import {
  emptyConversationState,
  handleTurn,
  renderGreeting,
  startConversation,
  updateConversation,
  type Business,
  type ConversationState,
  type Database,
  type ILanguageModel,
  type Service,
  type StaffMember,
} from '@frontly/core';
import {
  DEFAULT_LANGUAGE,
  DEFAULT_VOICE_CONFIG,
  recognitionFor,
  type ConversationOutcome,
  type Language,
  type RecognitionConfig,
  type TranscriptTurn,
  type VoiceProfile,
} from '@frontly/shared';
import { PlaybackQueue, type PlaybackSink } from './audio.js';
import {
  CALLBACK_OFFER,
  DID_NOT_CATCH,
  FILLERS,
  REPROMPTS,
  TRANSFER_UNAVAILABLE,
} from './phrases.js';
import { phraseRequest, type SpeechCache } from './speech-cache.js';
import type { ISpeechProvider, ISpeechToText, ITextToSpeech, TranscriptionResult } from './types.js';

/**
 * One phone call.
 *
 * Owns the state machine between "the socket opened" and "the caller hung up":
 * greeting, listening, thinking, speaking, barge-in, silence, and writing the
 * whole thing to the conversations table.
 *
 * It contains no booking logic and no prompt — that is @frontly/core, reached
 * through handleTurn. This file is an adapter, and if it ever starts making
 * decisions about appointments the layering has gone wrong.
 */

/** Why a turn ran. A reprompt must be distinguishable from a real answer. */
export type TurnReason = 'caller' | 'queued-while-busy';

export interface CallSessionLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface CallSessionOptions {
  db: Database;
  business: Business;
  services: Service[];
  staff: StaffMember[];
  provider: ISpeechProvider;
  model: ILanguageModel;
  sink: PlaybackSink;
  /** The carrier's opaque handle for this call. Never parsed, only logged. */
  callRef: string;
  /** Caller ID, when the carrier provides one. */
  from?: string | undefined;
  logger: CallSessionLogger;
  /** Called when the session decides the call is over. */
  onHangUp: () => void;
  /**
   * Put the caller through to a human, if the carrier can.
   *
   * Optional because a transfer is an outbound call, which not every account
   * is provisioned for — and an agent that cannot transfer must still say so
   * politely rather than pretend it did.
   */
  onTransfer?: ((to: string) => Promise<void>) | undefined;

  /** Reprompt after this much silence. */
  silenceMs?: number;
  /** How many reprompts before offering a callback and ending. */
  maxSilencePrompts?: number;
  /** Below this STT confidence the agent admits it did not catch it. */
  minConfidence?: number;
  /** Frame pacing. 20 ms in production; tests shorten it to run quickly. */
  frameIntervalMs?: number;
  /**
   * Pre-synthesized audio for the lines that never change.
   *
   * Optional: without it everything still works, just with an Azure round trip
   * in front of the greeting and no fillers on slow turns.
   */
  cache?: SpeechCache | undefined;
  /** Play a filler once a turn has been silent this long. */
  fillerAfterMs?: number;
  /** Overrides the business's own recognition tuning. Tests use it. */
  recognition?: RecognitionConfig | undefined;
}


/**
 * How long the line may stay quiet mid-turn before a filler plays.
 *
 * Below roughly this, a pause reads as ordinary conversational rhythm and a
 * filler would talk over the answer arriving. Above it, the caller starts
 * wondering whether the call dropped.
 */
const DEFAULT_FILLER_AFTER_MS = 800;

const DEFAULT_MIN_CONFIDENCE = 0.4;

export class CallSession {
  private readonly startedAt = Date.now();
  private readonly playback: PlaybackQueue;
  private readonly transcript: TranscriptTurn[] = [];
  private tts: ITextToSpeech;
  private stt: ISpeechToText | undefined;

  private state: ConversationState;
  private language: Language;
  private languageLocked = false;

  private conversationId: string | undefined;
  private silenceTimer: NodeJS.Timeout | undefined;
  /** Last moment either side was audible; the quiet clock counts from here. */
  private lastAudibleAt = Date.now();
  /** Sentences synthesized but not yet queued — still "about to speak". */
  private pendingSpeech = 0;
  /** Armed on speech-start, fired only once the caller is confirmed talking. */
  private bargeInTimer: NodeJS.Timeout | undefined;
  private silencePrompts = 0;
  private busy = false;
  private pendingUtterance: string | undefined;
  private ended = false;
  private lowConfidenceStreak = 0;
  /** Synthesis time for the most recent sentence, for the latency log. */
  private lastSynthesisMs = 0;
  /** Synthesis time for the FIRST sentence of the current turn. */
  private turnFirstTtsMs: number | undefined;
  /** When audio first existed this turn — what the caller's silence ends at. */
  private turnFirstAudioAt: number | undefined;
  /** Rotates the filler variants so slow turns do not all sound identical. */
  private lastFillerIndex = -1;

  /**
   * Segmentation and barge-in tuning, read once per call from the business's
   * own config. Tuning is a database write that the next call picks up — no
   * restart, no deploy, which is the only way to set these by ear.
   */
  private readonly recognition: RecognitionConfig;

  /** How long the line may be quiet before the agent checks in. */
  private get repromptAfterMs(): number {
    return this.options.silenceMs ?? this.recognition.repromptAfterMs;
  }

  private get maxReprompts(): number {
    return this.options.maxSilencePrompts ?? this.recognition.maxReprompts;
  }

  constructor(private readonly options: CallSessionOptions) {
    this.recognition = options.recognition ?? recognitionFor(options.business.voiceConfig);
    this.playback = new PlaybackQueue(options.sink, options.frameIntervalMs ?? 20);
    this.tts = options.provider.createSynthesizer();
    this.language = (options.business.languages[0] as Language | undefined) ?? DEFAULT_LANGUAGE;
    this.state = emptyConversationState(this.language);
  }

  // --- lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    const languages = this.businessLanguages();

    this.stt = this.options.provider.createRecognizer({
      languages,
      recognition: this.recognition,
      // Straight into the call log: the text, and the silence that ended it.
      onDiagnostic: (payload, message) =>
        this.options.logger.info({ callRef: this.options.callRef, ...payload }, message),
      handlers: {
        onSpeechStarted: () => this.onSpeechStarted(),
        onSpeechEnded: () => this.onSpeechEnded(),
        onPartial: (text) => this.onPartial(text),
        onFinal: (result) => void this.onUtterance(result),
        onError: (error) => void this.onSttError(error),
      },
    });

    const greeting = renderGreeting(this.options.business);
    const cached = this.options.cache?.get(this.greetingRequest(greeting));

    if (cached) {
      /**
       * Nothing between the caller connecting and hearing a voice.
       *
       * The greeting is fixed text, so with it already synthesized the only
       * remaining work is queueing bytes. The database insert and the Azure
       * recognizer handshake both used to sit in front of this and both now
       * happen while the caller is being greeted.
       *
       * Not waiting for `stt.ready` is safe specifically because the recognizer
       * adapter buffers audio written before it is live — without that buffer
       * this would silently eat the caller's opening words.
       */
      this.playback.enqueue(cached);
      const rowWritten = this.createConversationRow().then((id) => {
        this.conversationId = id;
      });
      await this.playback.whenDrained();
      await rowWritten;
    } else {
      // Cold cache. Nothing to play early, so keep the careful order.
      this.conversationId = await this.createConversationRow();
      await this.stt.ready;
      await this.speak(greeting, { greeting: true });
    }

    this.startSilenceWatch();
  }

  /** The greeting carries the configured pause between sentence and question. */
  private greetingRequest(text: string) {
    return phraseRequest(text, this.language, this.voiceProfile(), {
      breakAfterFirstSentence: true,
    });
  }

  /** Inbound media frame from the carrier. */
  onMedia(base64Payload: string): void {
    if (this.ended || !this.stt) return;
    this.stt.write(Buffer.from(base64Payload, 'base64'));
  }

  async stop(reason: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.stopSilenceWatch();
    if (this.bargeInTimer) clearTimeout(this.bargeInTimer);
    this.bargeInTimer = undefined;
    this.playback.interrupt();

    try {
      await this.stt?.stop();
    } catch {
      /* already gone */
    }
    this.tts.close();

    await this.persist(true);
    this.options.logger.info(
      {
        callRef: this.options.callRef,
        reason,
        durationMs: Date.now() - this.startedAt,
        outcome: this.state.outcome ?? 'abandoned',
        turns: this.state.turnCount,
        language: this.language,
      },
      'call ended',
    );
  }

  // --- speech in -------------------------------------------------------------

  /**
   * Barge-in, armed but not fired.
   *
   * Azure raises speech-start on energy alone, so a cough, a door, or a car
   * horn used to kill the agent mid-sentence. Starting talking now only arms
   * the interrupt; it fires when the caller is confirmed to be speaking —
   * either a partial transcript with real words, or sustained energy for
   * `bargeInMs`. Speech-end before either cancels it.
   */
  private onSpeechStarted(): void {
    this.noteCallerActivity();
    if (!this.playback.isPlaying || this.bargeInTimer) return;

    const after = this.recognition.bargeInMs;
    if (after <= 0) {
      this.fireBargeIn('immediate');
      return;
    }
    this.bargeInTimer = setTimeout(() => this.fireBargeIn('sustained speech'), after);
  }

  /** Energy stopped before it became words: it was noise, not the caller. */
  private onSpeechEnded(): void {
    if (!this.bargeInTimer) return;
    clearTimeout(this.bargeInTimer);
    this.bargeInTimer = undefined;
    this.options.logger.info(
      { callRef: this.options.callRef },
      'ignored a noise burst that was not speech',
    );
  }

  /**
   * A partial transcript is not a turn — only a final result is — but real
   * words in one prove the caller is genuinely talking, which is the fastest
   * honest confirmation available for barge-in.
   */
  private onPartial(text: string): void {
    if (!this.bargeInTimer) return;
    if (text.trim().length < this.recognition.bargeInMinChars) return;
    this.fireBargeIn(`partial: ${text.trim().slice(0, 40)}`);
  }

  private fireBargeIn(reason: string): void {
    if (this.bargeInTimer) {
      clearTimeout(this.bargeInTimer);
      this.bargeInTimer = undefined;
    }
    if (!this.playback.isPlaying) return;
    this.options.logger.info({ callRef: this.options.callRef, reason }, 'barge-in');
    this.playback.interrupt();
  }

  private async onUtterance(result: TranscriptionResult): Promise<void> {
    if (this.ended) return;

    /**
     * An empty final is not a turn.
     *
     * Azure occasionally finalizes on noise with no words in it. Acting on one
     * sends the model an empty message, resets the silence counter, and makes
     * the agent say something unprompted — which from the caller's side is the
     * agent talking to itself.
     */
    if (!result.text.trim()) {
      this.options.logger.info(
        { callRef: this.options.callRef, confidence: result.confidence },
        'ignored an empty recognition result',
      );
      return;
    }

    // A final result is proof, so anything still playing stops now.
    this.fireBargeIn('final result');
    this.noteCallerActivity();
    this.silencePrompts = 0;

    // Lock to the caller's language the first time detection produces one.
    // A short opening utterance sometimes yields nothing, in which case we
    // stay on the business default and try again next turn rather than
    // committing to a guess.
    if (!this.languageLocked && result.detectedLanguage) {
      this.language = result.detectedLanguage;
      this.languageLocked = true;
      this.state.language = result.detectedLanguage;
      this.options.logger.info(
        { callRef: this.options.callRef, language: this.language },
        'language locked',
      );
    }

    const minConfidence = this.options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    if (result.confidence < minConfidence) {
      this.lowConfidenceStreak++;
      this.options.logger.warn(
        { callRef: this.options.callRef, confidence: result.confidence, text: result.text },
        'low confidence transcription',
      );
      this.record({ role: 'customer', text: result.text, confidence: result.confidence });
      await this.speak(DID_NOT_CATCH[this.language]);
      // Two in a row means the line is bad, not that the caller mumbled.
      if (this.lowConfidenceStreak >= 2) this.state.outcome ??= 'transferred';
      this.startSilenceWatch();
      return;
    }

    this.lowConfidenceStreak = 0;
    this.options.logger.info(
      {
        callRef: this.options.callRef,
        text: result.text,
        confidence: result.confidence,
        endSilenceMs: result.endSilenceMs,
        utteranceMs: result.utteranceMs,
        configuredSilenceMs: this.recognition.segmentationSilenceMs,
      },
      'caller said',
    );
    this.record({ role: 'customer', text: result.text, confidence: result.confidence });
    await this.runTurn(result.text);
  }

  private async onSttError(error: Error): Promise<void> {
    this.options.logger.error(
      { callRef: this.options.callRef, err: error.message },
      'speech recognition failed',
    );
    // Never fail silently: say something and offer a human.
    this.state.outcome ??= 'transferred';
    await this.speak(DID_NOT_CATCH[this.language]);
    this.startSilenceWatch();
  }

  // --- the engine ------------------------------------------------------------

  private async runTurn(text: string, reason: TurnReason = 'caller'): Promise<void> {
    /**
     * A caller who answers before the agent has finished thinking must not be
     * ignored. Dropping the utterance here is what made a simulated call
     * recognise "Се викам Марко Петровски, потврдувам" and then never book
     * anything — the confirmation landed mid-turn and vanished.
     *
     * Queue instead, and coalesce: if several utterances arrive while one turn
     * runs, they are one thing the caller said, so they go to the model
     * together rather than as separate turns.
     */
    if (this.busy) {
      this.pendingUtterance = this.pendingUtterance ? `${this.pendingUtterance} ${text}` : text;
      return;
    }
    this.busy = true;

    /**
     * Why this turn is running.
     *
     * A reprompt and a real answer look identical in a transcript, so a call
     * that felt like a loop cannot be read back without this.
     */
    this.options.logger.info(
      { callRef: this.options.callRef, reason, text, turn: this.state.turnCount + 1 },
      'turn started',
    );

    const spokenSentences: string[] = [];
    const turnStartedAt = Date.now();
    this.turnFirstTtsMs = undefined;
    this.turnFirstAudioAt = undefined;
    /** The first sentence's synthesis, so the log reports real audio timing. */
    let firstSpeak: Promise<void> | undefined;

    /**
     * Cover the gap, do not extend it.
     *
     * If nothing has been queued by the time this fires, the line is silent
     * and the caller is starting to wonder. A cached acknowledgement buys the
     * remaining generation time without pretending to answer. Cancelled the
     * moment a real sentence arrives, and skipped entirely if the cache is
     * cold — synthesizing a filler would cost exactly what it is meant to hide.
     */
    const filler = setTimeout(() => {
      if (this.ended || spokenSentences.length > 0 || this.playback.isPlaying) return;
      const chosen = this.nextFiller();
      if (!chosen) return;
      this.options.logger.info(
        { callRef: this.options.callRef, text: chosen.text },
        'filler played',
      );
      // The filler IS the first thing the caller hears this turn, so it is
      // what ends their silence — the measurement has to agree with the ear.
      this.turnFirstAudioAt ??= Date.now();
      this.playback.enqueue(chosen.audio);
    }, this.options.fillerAfterMs ?? DEFAULT_FILLER_AFTER_MS);

    try {
      const result = await handleTurn(this.conversationId ?? this.options.callRef, text, {
        db: this.options.db,
        model: this.options.model,
        business: this.options.business,
        services: this.options.services,
        staff: this.options.staff,
        channel: 'voice',
        language: this.language,
        customerPhone: this.options.from,
        state: this.state,
        onLatinLeak: (leak) => {
          if (leak.unconverted.length === 0) return;
          this.options.logger.warn(
            { callRef: this.options.callRef, tokens: leak.unconverted, reply: leak.reply },
            'latin-script tokens in a Macedonian reply',
          );
        },
        // Sentence-at-a-time: synthesis of sentence one starts while the model
        // is still writing sentence two. This is the whole latency strategy.
        onSentence: (sentence) => {
          spokenSentences.push(sentence);
          clearTimeout(filler);
          // Deliberately not awaited: the point of streaming is that sentence
          // two generates while sentence one synthesizes. The first one is kept
          // so the latency log can wait for it, and only for it.
          const synthesis = this.speak(sentence, { queueOnly: true });
          firstSpeak ??= synthesis;
          void synthesis;
        },
      });

      this.state = result.state;

      this.record({
        role: 'agent',
        text: result.reply,
        toolCalls: result.toolCalls.map((call) => ({
          name: call.name,
          input: call.input,
          output: call.output,
          durationMs: call.durationMs,
          ...(call.error ? { error: call.error } : {}),
        })),
      });

      /**
       * Stages, not a single number.
       *
       * `toFirstTokenMs` on a tool turn spans the first model call, the tool,
       * and the second call's first token — so on its own it cannot say whether
       * a slow turn was the model or the database. `stages` breaks it apart,
       * which is the difference between switching models and adding an index.
       */
      // Without this the log reads the clock before the first synthesis has
      // finished setting it, and every streamed turn reports "undefined".
      await firstSpeak;

      const [firstCall] = result.timings.calls;
      this.options.logger.info(
        {
          callRef: this.options.callRef,
          // What the caller actually perceives: silence until audio exists.
          toFirstAudioMs: this.turnFirstAudioAt
            ? this.turnFirstAudioAt - turnStartedAt
            : undefined,
          toFirstTokenMs: result.timings.toFirstTokenMs,
          toFirstSentenceMs: result.timings.toFirstSentenceMs,
          totalMs: result.timings.totalMs,
          stages: {
            /** Pure model latency, before any tool has run. */
            modelFirstTokenMs: firstCall?.toFirstTokenMs,
            firstCallMs: firstCall?.totalMs,
            toolMs: result.timings.toolMs,
            ttsFirstMs: this.turnFirstTtsMs,
            calls: result.timings.calls,
            tools: result.timings.tools,
          },
          modelCalls: result.timings.modelCalls,
          tools: result.toolCalls.map((c) => c.name),
        },
        'turn complete',
      );

      // If streaming produced nothing (a model that returned only tool calls),
      // fall back to speaking the assembled reply so the line is never dead.
      if (spokenSentences.length === 0 && result.reply) {
        await this.speak(result.reply);
      }

      await this.persist(false);

      // The engine asked for a human. Its explanation is already queued, so let
      // the caller hear it before the line moves anywhere.
      if (result.toolCalls.some((call) => call.name === 'transfer_to_human')) {
        await this.handOver();
      }
    } catch (error) {
      this.options.logger.error(
        { callRef: this.options.callRef, err: error instanceof Error ? error.message : error },
        'turn failed',
      );
      await this.speak(DID_NOT_CATCH[this.language]);
    } finally {
      clearTimeout(filler);
      this.busy = false;

      // Anything the caller said while that turn was running is handled now,
      // before the silence timer gets a chance to reprompt them.
      const queued = this.pendingUtterance;
      this.pendingUtterance = undefined;
      if (queued && !this.ended) {
        await this.runTurn(queued, 'queued-while-busy');
        return;
      }

      this.startSilenceWatch();
    }
  }

  /**
   * The next filler, rotating so the caller never hears the same two words
   * twice running. Returns undefined when nothing is cached, which is the
   * signal to stay quiet rather than synthesize one.
   */
  private nextFiller(): { audio: Buffer; text: string } | undefined {
    const cache = this.options.cache;
    if (!cache) return undefined;

    const variants = FILLERS[this.language];
    for (let step = 1; step <= variants.length; step++) {
      const index = (this.lastFillerIndex + step) % variants.length;
      const text = variants[index]!;
      const audio = cache.get(phraseRequest(text, this.language, this.voiceProfile()));
      if (audio) {
        this.lastFillerIndex = index;
        return { audio, text };
      }
    }
    return undefined;
  }

  /**
   * The next thing to say when checking in.
   *
   * Escalates rather than repeating: hearing the identical sentence twice is
   * what turns "the agent is checking in" into "the agent is stuck in a loop".
   * Clamps to the last variant so a higher maxReprompts still says something.
   */
  private repromptText(): string {
    const variants = REPROMPTS[this.language];
    const index = Math.min(this.silencePrompts - 1, variants.length - 1);
    return variants[Math.max(0, index)]!;
  }

  /** True while a turn is in flight — the simulation uses it to pace itself. */
  get isThinking(): boolean {
    return this.busy;
  }

  /**
   * Hand the call to a human.
   *
   * Waits for playback to drain first: transferring mid-sentence cuts the agent
   * off in the caller's ear and sounds like the call dropped.
   */
  private async handOver(): Promise<void> {
    await this.playback.whenDrained();
    const to = this.options.business.ownerMobile ?? undefined;

    if (!this.options.onTransfer || !to) {
      this.options.logger.warn(
        { callRef: this.options.callRef, hasRoute: Boolean(this.options.onTransfer), to },
        'transfer requested but no route is configured',
      );
      await this.speak(TRANSFER_UNAVAILABLE[this.language]);
      await this.playback.whenDrained();
      await this.stop('transfer_unavailable');
      this.options.onHangUp();
      return;
    }

    try {
      await this.options.onTransfer(to);
      this.options.logger.info({ callRef: this.options.callRef, to }, 'transferred to a human');
      // The carrier owns the call from here; stop our side without hanging up,
      // or we would drop the call we just handed over.
      await this.stop('transferred');
    } catch (error) {
      this.options.logger.error(
        { callRef: this.options.callRef, to, err: error instanceof Error ? error.message : error },
        'transfer failed',
      );
      await this.speak(TRANSFER_UNAVAILABLE[this.language]);
      await this.playback.whenDrained();
      await this.stop('transfer_failed');
      this.options.onHangUp();
    }
  }

  // --- speech out ------------------------------------------------------------

  private async speak(
    text: string,
    options: { greeting?: boolean; queueOnly?: boolean } = {},
  ): Promise<void> {
    if (this.ended || !text.trim()) return;

    // The configured pause between greeting and question, so the caller does
    // not talk over the question on every single call.
    const request = phraseRequest(text, this.language, this.voiceProfile(), {
      ...(options.greeting ? { breakAfterFirstSentence: true } : {}),
    });

    /**
     * Fixed lines never touch Azure.
     *
     * The apologies, the reprompt and the callback offer are all pre-synthesized,
     * and they are precisely the lines a caller hears when the call is already
     * going badly. Making the recovery path the slowest one would be backwards.
     */
    const cached = this.options.cache?.get(request);
    if (cached) {
      this.lastSynthesisMs = 0;
      this.turnFirstTtsMs ??= 0;
      this.turnFirstAudioAt ??= Date.now();
      this.playback.enqueue(cached);
      if (!options.queueOnly) await this.playback.whenDrained();
      return;
    }

    const synthesisStartedAt = Date.now();
    this.pendingSpeech++;
    try {
      const audio = await this.tts.synthesize(request);
      this.lastSynthesisMs = Date.now() - synthesisStartedAt;
      this.turnFirstTtsMs ??= this.lastSynthesisMs;
      if (this.ended) return;
      this.turnFirstAudioAt ??= Date.now();
      this.playback.enqueue(audio);
      if (!options.queueOnly) await this.playback.whenDrained();
    } catch (error) {
      // A failed synthesis must not become dead air or a burst of noise.
      this.options.logger.error(
        { callRef: this.options.callRef, err: error instanceof Error ? error.message : error },
        'speech synthesis failed',
      );
      this.state.outcome ??= 'transferred';
    } finally {
      this.pendingSpeech--;
    }
  }

  private voiceProfile(): VoiceProfile {
    const configured = this.options.business.voiceConfig?.[this.language];
    return configured ?? DEFAULT_VOICE_CONFIG[this.language];
  }

  // --- silence ---------------------------------------------------------------

  /**
   * One periodic check instead of a timer armed from six places.
   *
   * Arming was subtly wrong in a way that kept coming back. The playback queue
   * empties *between* streamed sentences, while the next one is still being
   * synthesized, so `isPlaying` goes false mid-reply — and arming there started
   * counting the caller's silence while the agent was still talking. The
   * reprompt then landed moments after it stopped speaking, which is exactly
   * what makes it feel like it is interrupting rather than waiting.
   *
   * Asking "has the line actually been quiet?" on a tick has no such moment to
   * get wrong: the line is not quiet while audio is queued, while a turn is
   * running, or while a sentence is still being synthesized.
   */
  private startSilenceWatch(): void {
    this.stopSilenceWatch();
    if (this.ended) return;
    this.lastAudibleAt = Date.now();
    const every = Math.max(25, Math.min(250, Math.floor(this.repromptAfterMs / 4)));
    this.silenceTimer = setInterval(() => this.checkSilence(), every);
  }

  private stopSilenceWatch(): void {
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.silenceTimer = undefined;
  }

  /** True while the agent is doing anything the caller should wait through. */
  private get agentBusy(): boolean {
    return this.busy || this.pendingSpeech > 0 || this.playback.isPlaying;
  }

  private checkSilence(): void {
    if (this.ended) return;

    // Measured from the last moment anyone was audible, not from the first
    // tick that noticed the quiet, so the delay is accurate to one tick
    // rather than rounded up to one.
    if (this.agentBusy) {
      this.lastAudibleAt = Date.now();
      return;
    }
    if (Date.now() - this.lastAudibleAt < this.repromptAfterMs) return;

    this.lastAudibleAt = Date.now();
    void this.onSilence();
  }

  /** The caller is speaking, or just did: the line is not quiet. */
  private noteCallerActivity(): void {
    this.lastAudibleAt = Date.now();
  }

  private async onSilence(): Promise<void> {
    if (this.ended || this.busy) return;
    const limit = this.maxReprompts;

    if (this.silencePrompts < limit) {
      this.silencePrompts++;
      const text = this.repromptText();
      this.options.logger.info(
        {
          callRef: this.options.callRef,
          attempt: this.silencePrompts,
          of: limit,
          afterMs: this.repromptAfterMs,
          text,
        },
        'reprompting after silence',
      );
      await this.speak(text);
      this.startSilenceWatch();
      return;
    }

    // Reprompted to the limit and still nothing: offer a callback and hang up
    // cleanly rather than holding an empty line open indefinitely.
    this.options.logger.info(
      { callRef: this.options.callRef, reprompts: this.silencePrompts },
      'no answer after every reprompt — offering a callback and ending',
    );
    this.state.outcome ??= 'abandoned';
    await this.speak(CALLBACK_OFFER[this.language]);
    await this.playback.whenDrained();
    await this.stop('silence');
    this.options.onHangUp();
  }

  // --- persistence -----------------------------------------------------------

  private businessLanguages(): Language[] {
    const configured = this.options.business.languages;
    return configured.length > 0 ? configured : [DEFAULT_LANGUAGE];
  }

  private record(turn: Omit<TranscriptTurn, 'atMs'>): void {
    this.transcript.push({ ...turn, atMs: Date.now() - this.startedAt } as TranscriptTurn);
  }

  private async createConversationRow(): Promise<string> {
    const row = await startConversation(this.options.db, {
      businessId: this.options.business.id,
      channel: 'voice',
      externalId: this.options.callRef,
      fromIdentifier: this.options.from,
      language: this.language,
      startedAt: new Date(this.startedAt),
    });
    return row.id;
  }

  private async persist(final: boolean): Promise<void> {
    if (!this.conversationId) return;
    const outcome: ConversationOutcome | undefined =
      this.state.outcome ?? (final ? 'abandoned' : undefined);

    try {
      await updateConversation(this.options.db, this.conversationId, {
        transcript: this.transcript,
        language: this.language,
        outcome,
        appointmentId: this.state.appointmentId,
        ended: final,
      });
    } catch (error) {
      // Losing the transcript must not drop the call.
      this.options.logger.error(
        { callRef: this.options.callRef, err: error instanceof Error ? error.message : error },
        'failed to persist conversation',
      );
    }
  }
}
