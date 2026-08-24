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
  type ConversationOutcome,
  type Language,
  type TranscriptTurn,
  type VoiceProfile,
} from '@frontly/shared';
import { PlaybackQueue, type PlaybackSink } from './audio.js';
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
  callSid: string;
  /** Caller ID, when Twilio provides one. */
  from?: string | undefined;
  logger: CallSessionLogger;
  /** Called when the session decides the call is over. */
  onHangUp: () => void;

  /** Reprompt after this much silence. */
  silenceMs?: number;
  /** How many reprompts before offering a callback and ending. */
  maxSilencePrompts?: number;
  /** Below this STT confidence the agent admits it did not catch it. */
  minConfidence?: number;
  /** Frame pacing. 20 ms in production; tests shorten it to run quickly. */
  frameIntervalMs?: number;
}

const DEFAULT_SILENCE_MS = 6000;
const DEFAULT_MAX_SILENCE_PROMPTS = 1;
const DEFAULT_MIN_CONFIDENCE = 0.4;

/** Said when STT is unsure or Azure failed. Never silence, never garbage. */
const DID_NOT_CATCH: Record<Language, string> = {
  mk: 'Извинете, не ве слушнав добро. Може ли да повторите, или да ве поврзам со колега?',
  sq: 'Më falni, nuk ju dëgjova mirë. A mund ta përsërisni, apo t’ju lidh me një koleg?',
  en: 'Sorry, I did not catch that. Could you repeat it, or shall I put you through to a colleague?',
};

const STILL_THERE: Record<Language, string> = {
  mk: 'Сè уште сте тука?',
  sq: 'Jeni ende aty?',
  en: 'Are you still there?',
};

const CALLBACK_OFFER: Record<Language, string> = {
  mk: 'Изгледа дека врската не е добра. Ќе замолам колега да ви се јави. Пријатен ден.',
  sq: 'Duket se lidhja nuk është e mirë. Do të kërkoj një koleg t’ju telefonojë. Ditë të mbarë.',
  en: 'The line seems poor. I will ask a colleague to call you back. Have a good day.',
};

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
  private silencePrompts = 0;
  private busy = false;
  private pendingUtterance: string | undefined;
  private ended = false;
  private lowConfidenceStreak = 0;
  /** Synthesis time for the most recent sentence, for the latency log. */
  private lastSynthesisMs = 0;

  constructor(private readonly options: CallSessionOptions) {
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
      handlers: {
        onSpeechStarted: () => this.onSpeechStarted(),
        onFinal: (result) => void this.onUtterance(result),
        onError: (error) => void this.onSttError(error),
      },
    });

    this.conversationId = await this.createConversationRow();

    // Greet only once the recognizer is live, so the caller answering the
    // greeting immediately is not talking into a recognizer that is not
    // listening yet.
    await this.stt.ready;
    await this.speak(renderGreeting(this.options.business), { greeting: true });
    this.armSilenceTimer();
  }

  /** Inbound media frame from Twilio. */
  onMedia(base64Payload: string): void {
    if (this.ended || !this.stt) return;
    this.stt.write(Buffer.from(base64Payload, 'base64'));
  }

  async stop(reason: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.clearSilenceTimer();
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
        callSid: this.options.callSid,
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
   * Barge-in. The caller has started talking, so stop talking over them —
   * immediately, not at the end of the current sentence.
   */
  private onSpeechStarted(): void {
    this.clearSilenceTimer();
    if (this.playback.isPlaying) {
      this.options.logger.info({ callSid: this.options.callSid }, 'barge-in');
      this.playback.interrupt();
    }
  }

  private async onUtterance(result: TranscriptionResult): Promise<void> {
    if (this.ended) return;
    this.clearSilenceTimer();
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
        { callSid: this.options.callSid, language: this.language },
        'language locked',
      );
    }

    const minConfidence = this.options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    if (result.confidence < minConfidence) {
      this.lowConfidenceStreak++;
      this.options.logger.warn(
        { callSid: this.options.callSid, confidence: result.confidence, text: result.text },
        'low confidence transcription',
      );
      this.record({ role: 'customer', text: result.text, confidence: result.confidence });
      await this.speak(DID_NOT_CATCH[this.language]);
      // Two in a row means the line is bad, not that the caller mumbled.
      if (this.lowConfidenceStreak >= 2) this.state.outcome ??= 'transferred';
      this.armSilenceTimer();
      return;
    }

    this.lowConfidenceStreak = 0;
    this.record({ role: 'customer', text: result.text, confidence: result.confidence });
    await this.runTurn(result.text);
  }

  private async onSttError(error: Error): Promise<void> {
    this.options.logger.error(
      { callSid: this.options.callSid, err: error.message },
      'speech recognition failed',
    );
    // Never fail silently: say something and offer a human.
    this.state.outcome ??= 'transferred';
    await this.speak(DID_NOT_CATCH[this.language]);
    this.armSilenceTimer();
  }

  // --- the engine ------------------------------------------------------------

  private async runTurn(text: string): Promise<void> {
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

    const spokenSentences: string[] = [];

    try {
      const result = await handleTurn(this.conversationId ?? this.options.callSid, text, {
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
            { callSid: this.options.callSid, tokens: leak.unconverted, reply: leak.reply },
            'latin-script tokens in a Macedonian reply',
          );
        },
        // Sentence-at-a-time: synthesis of sentence one starts while the model
        // is still writing sentence two. This is the whole latency strategy.
        onSentence: (sentence) => {
          spokenSentences.push(sentence);
          void this.speak(sentence, { queueOnly: true });
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

      this.options.logger.info(
        {
          callSid: this.options.callSid,
          // The two numbers that matter, kept apart on purpose: the first is
          // what the caller perceives, the second is what a benchmark shows.
          // Three separate numbers because they are three separate problems:
          // model latency, sentence length, and everything else.
          toFirstTokenMs: result.timings.toFirstTokenMs,
          toFirstAudioMs: result.timings.toFirstSentenceMs,
          ttsMs: this.lastSynthesisMs,
          totalMs: result.timings.totalMs,
          toolMs: result.timings.toolMs,
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
    } catch (error) {
      this.options.logger.error(
        { callSid: this.options.callSid, err: error instanceof Error ? error.message : error },
        'turn failed',
      );
      await this.speak(DID_NOT_CATCH[this.language]);
    } finally {
      this.busy = false;

      // Anything the caller said while that turn was running is handled now,
      // before the silence timer gets a chance to reprompt them.
      const queued = this.pendingUtterance;
      this.pendingUtterance = undefined;
      if (queued && !this.ended) {
        await this.runTurn(queued);
        return;
      }

      this.armSilenceTimer();
    }
  }

  /** True while a turn is in flight — the simulation uses it to pace itself. */
  get isThinking(): boolean {
    return this.busy;
  }

  // --- speech out ------------------------------------------------------------

  private async speak(
    text: string,
    options: { greeting?: boolean; queueOnly?: boolean } = {},
  ): Promise<void> {
    if (this.ended || !text.trim()) return;

    const synthesisStartedAt = Date.now();
    try {
      const audio = await this.tts.synthesize({
        text,
        language: this.language,
        profile: this.voiceProfile(),
        // The configured pause between greeting and question, so the caller
        // does not talk over the question on every single call.
        ...(options.greeting ? { breakAfterFirstSentence: true } : {}),
      });
      this.lastSynthesisMs = Date.now() - synthesisStartedAt;
      if (this.ended) return;
      this.playback.enqueue(audio);
      if (!options.queueOnly) await this.playback.whenDrained();
    } catch (error) {
      // A failed synthesis must not become dead air or a burst of noise.
      this.options.logger.error(
        { callSid: this.options.callSid, err: error instanceof Error ? error.message : error },
        'speech synthesis failed',
      );
      this.state.outcome ??= 'transferred';
    }
  }

  private voiceProfile(): VoiceProfile {
    const configured = this.options.business.voiceConfig?.[this.language];
    return configured ?? DEFAULT_VOICE_CONFIG[this.language];
  }

  // --- silence ---------------------------------------------------------------

  private armSilenceTimer(): void {
    this.clearSilenceTimer();
    if (this.ended) return;
    const wait = this.options.silenceMs ?? DEFAULT_SILENCE_MS;
    this.silenceTimer = setTimeout(() => void this.onSilence(), wait);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
  }

  private async onSilence(): Promise<void> {
    if (this.ended || this.busy) return;
    const limit = this.options.maxSilencePrompts ?? DEFAULT_MAX_SILENCE_PROMPTS;

    if (this.silencePrompts < limit) {
      this.silencePrompts++;
      await this.speak(STILL_THERE[this.language]);
      this.armSilenceTimer();
      return;
    }

    // Reprompted and still nothing: offer a callback and hang up cleanly
    // rather than holding an empty line open.
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
      externalId: this.options.callSid,
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
        { callSid: this.options.callSid, err: error instanceof Error ? error.message : error },
        'failed to persist conversation',
      );
    }
  }
}
