import {
  emptyConversationState,
  handleTurn,
  recognitionPhrases,
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
  FAREWELL,
  CANNOT_HEAR,
  DID_NOT_CATCH,
  FILLERS,
  REPROMPTS,
  TRANSFER_UNAVAILABLE,
} from './phrases.js';
import type { CallEvent, CallEventDraft } from '../demo/events.js';
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

/**
 * Who ended the call.
 *
 * "Did we hang up on them or did they hang up on us?" was not answerable from
 * a log without knowing which reason strings originate in which layer, and it
 * is the first question worth asking about any short call.
 */
export type CallEndedBy = 'agent' | 'caller' | 'carrier' | 'transfer';

function endedBy(reason: string): CallEndedBy {
  // The socket closing is the caller's leg going away; the provider stopping
  // the stream is the carrier's doing. Everything else is a decision of ours.
  if (reason === 'socket_closed' || reason === 'socket_error') return 'caller';
  if (reason === 'provider_stop') return 'carrier';
  if (reason === 'transferred') return 'transfer';
  return 'agent';
}

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

  /**
   * A booking just succeeded. Fired so the adapter can text the confirmation
   * while the caller is still holding the phone — which is the feature; one
   * that arrives on the next cron tick is a receipt.
   *
   * Deliberately fire-and-forget and never awaited: an SMS round trip inside
   * a turn would be added to the caller's latency, and the hourly sweep
   * already picks up anything that fails, because the appointment's
   * `confirmation_sent_at` stays NULL.
   */
  onBooked?: ((appointmentId: string) => void) | undefined;

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
  /**
   * Live events for the demo screen. Optional: the call behaves identically
   * without a listener, and the session never learns who is watching.
   */
  onEvent?: ((event: CallEvent) => void) | undefined;
}


/**
 * How long the line may stay quiet mid-turn before a filler plays.
 *
 * Below roughly this, a pause reads as ordinary conversational rhythm and a
 * filler would talk over the answer arriving. Above it, the caller starts
 * wondering whether the call dropped.
 *
 * Lowered from 800 to 600 for the demo. The caller has ALREADY waited through
 * the segmentation timeout and Azure's finalization before this clock even
 * starts — roughly 1.2s of real silence — so 800 on top put the first sound
 * at about two seconds. It fires on nearly every turn either way, because
 * measured time-to-first-token is far longer than either value; what changes
 * is how long the line is dead before the caller hears anything at all.
 */
const DEFAULT_FILLER_AFTER_MS = 600;


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
  /** Pending hang-up after a farewell. Cleared if the caller speaks again. */
  private farewellTimer: NodeJS.Timeout | undefined;
  private pendingUtterance: string | undefined;
  private ended = false;
  private lowConfidenceStreak = 0;
  /**
   * Apologies actually spoken, as distinct from low-confidence results seen.
   * The give-up cap counts these, so a result met with silence never spends one
   * of the caller's chances.
   */
  private lowConfidenceApologies = 0;
  /** Bumped whenever the caller proves they are still there. See noteCallerActivity. */
  private callerActivity = 0;
  /**
   * Last moment the CALLER made a sound, never touched by our own audio.
   *
   * `lastAudibleAt` deliberately counts the agent too, because it drives the
   * quiet clock. This one must not: it is the answer to "is someone there?",
   * and an agent talking to itself is not someone being there.
   */
  private lastCallerSoundAt = Date.now();
  /**
   * When Azure last reported the caller's speech energy STOPPED.
   *
   * The honest starting point for "how long did the caller wait?", measured
   * rather than derived. Deriving it from the segmentation timeout produced a
   * number that did not move when the timeout changed, because simulated audio
   * carries its own trailing silence — so this takes the real moment instead.
   */
  private callerStoppedAt: number | undefined;
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
    // A locked language is the session's language from the first frame, so the
    // greeting and every cached phrase come out of the right voice profile.
    this.language =
      this.recognition.lockLanguage ??
      (options.business.languages[0] as Language | undefined) ??
      DEFAULT_LANGUAGE;
    this.state = emptyConversationState(this.language);
  }

  // --- lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    this.emit({ type: 'call.started', callRef: this.options.callRef, from: this.options.from });
    const languages = this.businessLanguages();

    this.stt = this.options.provider.createRecognizer({
      languages,
      recognition: this.recognition,
      // The clinic's own vocabulary: service names, staff, days, booking
      // phrases. Built from its database record, so a different clinic biases
      // towards different words with no code change.
      phrases: recognitionPhrases({
        business: this.options.business,
        services: this.options.services,
        staff: this.options.staff,
        language: this.language,
      }),
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
    // A pending farewell close on an already-ended call would fire into a dead
    // session; harmless, but it keeps the process awake for no reason.
    if (this.farewellTimer) clearTimeout(this.farewellTimer);
    this.farewellTimer = undefined;
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
        // Who ended it. Reading this back off a real call used to mean
        // knowing which reason strings came from which layer; a hangup we
        // caused and one the caller caused looked identical in the log.
        endedBy: endedBy(reason),
        durationMs: Date.now() - this.startedAt,
        // Silence at the moment of ending: the single number that says whether
        // we dropped someone who was still talking.
        callerQuietForMs: Date.now() - this.lastCallerSoundAt,
        outcome: this.state.outcome ?? 'abandoned',
        turns: this.state.turnCount,
        language: this.language,
      },
      'call ended',
    );
    this.emit({
      type: 'call.ended',
      callRef: this.options.callRef,
      endedBy: endedBy(reason),
      outcome: this.state.outcome ?? 'abandoned',
      durationMs: Date.now() - this.startedAt,
    });
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
    // The real moment the caller stopped talking, which is where the honest
    // latency number starts counting.
    this.callerStoppedAt = Date.now();
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
    // Real words in a partial are the strongest evidence available that the
    // caller is mid-sentence, and it arrives long before the final does. A
    // pending apology watches this: it is the signal that the low-confidence
    // result was a fragment of a sentence still being spoken, not a bad line.
    if (text.trim().length >= this.recognition.bargeInMinChars) this.noteCallerActivity();

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
      this.emit({ type: 'call.language', callRef: this.options.callRef, language: this.language });
    }

    const minConfidence = this.options.minConfidence ?? this.recognition.minConfidence;
    if (result.confidence < minConfidence) {
      this.lowConfidenceStreak++;
      this.options.logger.warn(
        {
          callRef: this.options.callRef,
          confidence: result.confidence,
          minConfidence,
          text: result.text,
          streak: this.lowConfidenceStreak,
          of: this.recognition.maxLowConfidenceTurns,
        },
        'low confidence transcription',
      );
      this.record({ role: 'customer', text: result.text, confidence: result.confidence });

      /**
       * Say nothing at all the first time.
       *
       * The apology is pre-synthesized, so it lands ~35 ms after the result —
       * far faster than a person could have understood the sentence. A caller
       * who paused mid-thought gets finalized on a fragment (which scores badly
       * BECAUSE it is a fragment, not because the line is bad), and the instant
       * apology arrives while they are still talking. That derails them into a
       * disfluent restart, which finalizes as another fragment, which scores
       * badly again — a loop sustained by timing, which is why no amount of
       * `--reprompt-after` tuning ever touched it.
       *
       * Silence is the fix: a caller mid-sentence who hears nothing simply
       * carries on, and the next result is a whole sentence that scores fine.
       * If they really had finished, the reprompt timer is the safety net.
       */
      if (this.lowConfidenceStreak <= this.recognition.silentLowConfidenceTurns) {
        this.options.logger.info(
          {
            callRef: this.options.callRef,
            streak: this.lowConfidenceStreak,
            silentBudget: this.recognition.silentLowConfidenceTurns,
          },
          'low confidence held in silence — may be a fragment of a sentence still being spoken',
        );
        this.startSilenceWatch();
        return;
      }

      /**
       * Stop retrying a question the line cannot carry.
       *
       * This branch used to speak the same apology on every low-confidence
       * result, forever, with nothing capping it — `lowConfidenceStreak >= 2`
       * set an outcome field and changed no behaviour at all. On a poor line
       * every utterance lands here, so the caller heard one identical sentence
       * over and over. It is not the reprompt timer, which is why tuning the
       * reprompt delay had no effect on it.
       *
       * Counts apologies SPOKEN, not results seen: a held result must not spend
       * one of the caller's chances, or the silent first turn would turn the
       * ladder into "say nothing, then hang up".
       */
      if (this.lowConfidenceApologies >= this.recognition.maxLowConfidenceTurns) {
        this.options.logger.warn(
          {
            callRef: this.options.callRef,
            streak: this.lowConfidenceStreak,
            apologies: this.lowConfidenceApologies,
            callerPresent: this.callerPresent,
          },
          'cannot hear this line — offering a way out, but staying on the call',
        );
        /**
         * Offer a route out; do NOT end the call.
         *
         * This branch used to run `handOver()`, which with no transfer route
         * spoke TRANSFER_UNAVAILABLE and hung up — so four low-confidence
         * results in a row dropped the caller at roughly ten seconds, while
         * they were still audibly talking. A caller we cannot transcribe is
         * still a caller. `handOver` no longer hangs up either, but reaching
         * it at all was the wrong response to a bad line.
         */
        this.state.outcome ??= 'transferred';
        await this.speak(CANNOT_HEAR[this.language]);
        this.forgetTrouble();
        this.startSilenceWatch();
        return;
      }

      await this.apologiseUnlessCallerResumes();
      return;
    }

    this.lowConfidenceStreak = 0;
    this.lowConfidenceApologies = 0;
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
    await this.speak(this.didNotCatchText());
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
    // A caller who speaks during the goodbye grace is not done after all.
    this.cancelFarewellClose();

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
        // Persisted so the demo's average latency is one actually measured on
        // real calls, and survives a redeploy.
        ...(this.callerFacingMs() !== undefined ? { callerFacingMs: this.callerFacingMs() } : {}),
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
          // Caller stopped speaking -> first audio. Unlike toFirstAudioMs above
          // (which starts after Azure has already finalized, and in practice
          // just reports the 800ms filler firing on schedule) this is the wait
          // the caller actually sits through.
          callerFacingMs: this.callerFacingMs(),
        },
        'turn complete',
      );

      for (const call of result.toolCalls) {
        this.emit({
          type: 'tool',
          callRef: this.options.callRef,
          name: call.name,
          ok: true,
        });
      }
      this.emit({
        type: 'turn.done',
        callRef: this.options.callRef,
        callerFacingMs: this.callerFacingMs(),
      });
      this.callerStoppedAt = undefined;

      // If streaming produced nothing (a model that returned only tool calls),
      // fall back to speaking the assembled reply so the line is never dead.
      if (spokenSentences.length === 0 && result.reply) {
        await this.speak(result.reply);
      }

      /**
       * A conclusion with nothing said would be a line that just goes dead,
       * which the caller cannot tell from a dropped call. `end_call` is meant
       * to arrive beside a goodbye and normally does; this is the floor.
       */
      if (this.state.concluded && spokenSentences.length === 0 && !result.reply) {
        await this.speak(FAREWELL[this.language]);
      }

      await this.persist(false);

      /**
       * Text the confirmation now, not on the next sweep.
       *
       * Read from the tool's own output rather than re-querying: this is the
       * one place that knows a booking was made by THIS turn, and the id it
       * returned is the appointment to confirm.
       */
      for (const call of result.toolCalls) {
        if (call.name !== 'book_appointment' || call.error) continue;
        const id = (call.output as { appointment_id?: unknown } | undefined)?.appointment_id;
        if (typeof id === 'string') this.options.onBooked?.(id);
      }

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
      await this.speak(this.didNotCatchText());
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

      /**
       * A concluded conversation gets a goodbye, not a reprompt.
       *
       * This line is where the bug lived: the ladder restarted after the
       * farewell like it does after any other turn, so the agent dismissed the
       * caller and then asked them if they were still there.
       */
      if (this.state.concluded) {
        this.armFarewellClose();
        return;
      }

      this.startSilenceWatch();
    }
  }

  /**
   * Hang up shortly after the goodbye, having given the caller room to say one
   * back.
   *
   * The wait starts once playback has drained, so the grace is measured from
   * the end of the farewell rather than the start of it — otherwise a long
   * goodbye eats its own courtesy window and the line drops on the last word.
   *
   * Deliberately does NOT arm the silence watch. There is nothing left to
   * reprompt about, and a reprompt here is precisely the failure being fixed.
   */
  private armFarewellClose(): void {
    if (this.ended || this.farewellTimer) return;

    /**
     * Stop the ladder, do not merely decline to restart it.
     *
     * `startSilenceWatch` installs a repeating interval, so the watch running
     * from before this turn keeps ticking on its own. Not calling it again is
     * not the same as turning it off — and a tick that lands between the
     * goodbye and the hang-up is exactly the "сè уште сте тука?" being fixed.
     */
    this.stopSilenceWatch();

    void this.playback.whenDrained().then(() => {
      if (this.ended || this.busy) return;
      this.options.logger.info(
        { callRef: this.options.callRef, graceMs: this.recognition.farewellGraceMs },
        'conversation concluded — closing after the grace period',
      );
      this.farewellTimer = setTimeout(() => {
        void this.hangUp('farewell', { concluded: true });
      }, this.recognition.farewellGraceMs);
    });
  }

  /**
   * The caller had more to say after all.
   *
   * Called when a real turn starts, which includes one that began during the
   * grace window. The model can conclude again on the next turn and the close
   * re-arms; what must not happen is hanging up over the top of someone who
   * has just asked another question.
   */
  private cancelFarewellClose(): void {
    if (!this.farewellTimer) return;
    clearTimeout(this.farewellTimer);
    this.farewellTimer = undefined;
    this.state.concluded = false;
    this.options.logger.info(
      { callRef: this.options.callRef },
      'farewell cancelled — the caller resumed',
    );
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
  /**
   * The next apology, escalating. Same reasoning as the reprompts: the second
   * identical sentence is what makes a bad line sound like a stuck machine.
   */
  private didNotCatchText(): string {
    const variants = DID_NOT_CATCH[this.language];
    const index = Math.min(Math.max(0, this.lowConfidenceApologies), variants.length - 1);
    return variants[index]!;
  }

  /**
   * Apologise, but only if the caller has genuinely stopped talking.
   *
   * The wait is not politeness — it is a window to be interrupted in. A delay
   * on its own would just move the collision later; what breaks the loop is
   * abandoning the apology outright when the caller turns out to have been
   * mid-sentence. Any proof of life during the hold (speech energy, a partial
   * with words, a new final) cancels it.
   *
   * Erring towards silence is safe in a way that erring towards speaking is
   * not: an apology we wrongly skip costs one reprompt interval, while one we
   * wrongly speak derails the caller and feeds the loop.
   */
  private async apologiseUnlessCallerResumes(): Promise<void> {
    const holdMs = this.recognition.lowConfidenceHoldMs;
    const before = this.callerActivity;

    if (holdMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      if (this.ended) return;

      if (this.callerActivity !== before) {
        this.options.logger.info(
          { callRef: this.options.callRef, heldMs: holdMs, streak: this.lowConfidenceStreak },
          'caller resumed during the hold — not apologising over them',
        );
        this.startSilenceWatch();
        return;
      }
    }

    // Text first: the variant is chosen by how many apologies have ALREADY
    // been spoken, so the first one is variant 0.
    const text = this.didNotCatchText();
    this.lowConfidenceApologies++;
    this.options.logger.info(
      {
        callRef: this.options.callRef,
        attempt: this.lowConfidenceApologies,
        of: this.recognition.maxLowConfidenceTurns,
        heldMs: holdMs,
        text,
      },
      'apologising for a low-confidence turn',
    );
    await this.speak(text);
    this.startSilenceWatch();
  }

  private repromptText(): string {
    const variants = REPROMPTS[this.language];
    const index = Math.min(this.silencePrompts - 1, variants.length - 1);
    return variants[Math.max(0, index)]!;
  }

  /**
   * The wait the caller actually experiences: they stop talking, then silence
   * until the agent's first audio.
   *
   * Undefined when either end is missing (a turn the caller never spoke into,
   * such as a reprompt) rather than guessed, because a fabricated latency
   * number is worse than a missing one.
   */
  private callerFacingMs(): number | undefined {
    if (!this.callerStoppedAt || !this.turnFirstAudioAt) return undefined;
    return this.turnFirstAudioAt - this.callerStoppedAt;
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
      // Say so and KEEP LISTENING. This path used to hang up, which meant a
      // caller we merely could not transcribe was dropped mid-sentence.
      await this.speak(TRANSFER_UNAVAILABLE[this.language]);
      this.forgetTrouble();
      this.startSilenceWatch();
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
      this.forgetTrouble();
      this.startSilenceWatch();
    }
  }

  /**
   * Give the caller a clean slate after an escape path has had its say.
   *
   * Without this the counters stay maxed, so the very next low-confidence
   * result walks straight back into the same dead end and the agent repeats
   * its apology forever — the loop again, just one level up.
   */
  private forgetTrouble(): void {
    this.lowConfidenceStreak = 0;
    this.lowConfidenceApologies = 0;
    this.silencePrompts = 0;
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

  /**
   * The caller is speaking, or just did: the line is not quiet.
   *
   * The counter is how a pending apology learns the caller resumed. Anything
   * that proves the caller is alive bumps it — speech energy, a partial, a
   * final — and a hold that sees it change abandons the apology rather than
   * speaking over someone who turned out to be mid-sentence.
   */
  private noteCallerActivity(): void {
    this.lastAudibleAt = Date.now();
    this.lastCallerSoundAt = Date.now();
    this.callerActivity++;
  }

  /**
   * Has the caller made any sound recently?
   *
   * The agent must never hang up on someone who is audibly there — a caller
   * dropped mid-call has no idea what happened and no way back. Recognising
   * nothing is not absence: a bad line, an accent, a noisy room all produce
   * sound we cannot transcribe, and every one of those is a person waiting.
   */
  private get callerPresent(): boolean {
    return Date.now() - this.lastCallerSoundAt < this.recognition.presenceWindowMs;
  }

  /**
   * End the call ourselves — the ONLY place that does.
   *
   * Refuses while the caller is audibly present, no matter which ladder asked.
   * Every escape path used to end in a hangup, so a caller the recogniser
   * could not understand got dropped at around ten seconds while they were
   * still talking. Now those paths say their piece and keep listening; only a
   * line with no sound at all for `abandonAfterMs` is actually ended.
   *
   * `concluded` is the one exception, and it is a different question entirely.
   * The presence rule answers "has this caller gone away?" — and the honest
   * answer for someone who just said "довидување" is no, they are right there,
   * which is exactly why they should not be held on an open line. A finished
   * conversation is not an abandoned one. Everything that cannot tell those
   * apart still goes through the presence rule.
   */
  private async hangUp(reason: string, { concluded = false } = {}): Promise<boolean> {
    const quietForMs = Date.now() - this.lastCallerSoundAt;

    if (!concluded && (this.callerPresent || quietForMs < this.recognition.abandonAfterMs)) {
      this.options.logger.info(
        {
          callRef: this.options.callRef,
          reason,
          quietForMs,
          presenceWindowMs: this.recognition.presenceWindowMs,
          abandonAfterMs: this.recognition.abandonAfterMs,
        },
        'declined to hang up — the caller is still there',
      );
      return false;
    }

    this.options.logger.warn(
      { callRef: this.options.callRef, reason, quietForMs, concluded, endedBy: 'agent' },
      concluded
        ? 'hanging up — the conversation concluded'
        : 'hanging up — our decision, the line has been silent',
    );
    await this.playback.whenDrained();
    await this.stop(reason);
    this.options.onHangUp();
    return true;
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

    /**
     * Reprompted to the limit.
     *
     * Offer the callback, then let `hangUp` decide — and it only agrees if the
     * caller has made no sound at all for `abandonAfterMs`. Someone who is
     * audibly there but not being understood keeps the line and gets another
     * round of the ladder rather than being dropped.
     */
    this.options.logger.info(
      {
        callRef: this.options.callRef,
        reprompts: this.silencePrompts,
        callerPresent: this.callerPresent,
      },
      'no answer after every reprompt — offering a callback',
    );
    await this.speak(CALLBACK_OFFER[this.language]);

    if (await this.hangUp('silence')) {
      this.state.outcome ??= 'abandoned';
      return;
    }

    // Still there. Reset the ladder so it can check in again later.
    this.silencePrompts = 0;
    this.startSilenceWatch();
  }

  // --- persistence -----------------------------------------------------------

  private businessLanguages(): Language[] {
    /**
     * A locked language wins over everything the business advertises.
     *
     * Handing the recognizer ONE language builds it without an auto-detect
     * config, which skips the detection Azure runs on the opening audio — and
     * takes the mid-call language-switch collapse off the table with it. The
     * clinic can still advertise three languages on its widget; this is about
     * what the phone line is willing to hear.
     */
    const locked = this.recognition.lockLanguage;
    if (locked) return [locked];

    const configured = this.options.business.languages;
    return configured.length > 0 ? configured : [DEFAULT_LANGUAGE];
  }

  private record(turn: Omit<TranscriptTurn, 'atMs'>): void {
    this.transcript.push({ ...turn, atMs: Date.now() - this.startedAt } as TranscriptTurn);
    if (turn.role === 'customer' || turn.role === 'agent') {
      this.emit({ type: 'said', callRef: this.options.callRef, role: turn.role, text: turn.text });
    }
  }

  /**
   * Tell the demo screen, if anyone is listening.
   *
   * Never allowed to affect the call: a listener that throws must not drop a
   * caller, and the screen is the least important thing on the line.
   */
  private emit(event: CallEventDraft): void {
    if (!this.options.onEvent) return;
    try {
      this.options.onEvent({ ...event, at: Date.now() } as CallEvent);
    } catch {
      /* the screen is not the call's problem */
    }
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
