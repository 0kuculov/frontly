import type { Language, RecognitionConfig, VoiceProfile } from '@frontly/shared';

/**
 * Speech providers behind interfaces.
 *
 * Azure is the implementation today, but nothing in the call pipeline may
 * import it directly — swapping to Deepgram or ElevenLabs has to be a new file
 * in this directory and one line in the factory, not a rewrite of the session
 * state machine.
 *
 * These live in apps/api on purpose: @frontly/core knows nothing about audio.
 */

/** Raw mulaw 8 kHz mono. Telnyx calls this codec PCMU; it is what the media
 * stream carries in both directions. */
export const TELEPHONY_SAMPLE_RATE = 8000;
/** 20 ms of mulaw at 8 kHz — one RTP packet. */
export const FRAME_BYTES = 160;

export interface SynthesisRequest {
  text: string;
  language: Language;
  profile: VoiceProfile;
  /** Insert the configured pause after the first sentence (greeting only). */
  breakAfterFirstSentence?: boolean;
}

export interface ITextToSpeech {
  /** Returns raw mulaw 8 kHz bytes with no container header. */
  synthesize(request: SynthesisRequest): Promise<Buffer>;
  close(): void;
}

export interface TranscriptionResult {
  text: string;
  /** 0..1. Below the session's floor, the agent admits it did not catch it. */
  confidence: number;
  /** Present only when auto-detection ran, i.e. on the first utterance. */
  detectedLanguage?: Language | undefined;
  /**
   * How long the caller was silent before this was called final, measured from
   * the recognizer's own speech-end event.
   *
   * The number to look at when the agent interrupts: if it sits at the
   * configured segmentation timeout, the timeout is too low for this speaker.
   */
  endSilenceMs?: number | undefined;
  /** Length of the recognized audio, from Azure's own offsets. */
  utteranceMs?: number | undefined;
}

export interface SpeechToTextHandlers {
  /**
   * Azure heard energy. NOT a turn, and not on its own a reason to stop
   * talking — it fires for a cough. Barge-in confirms with onPartial.
   */
  onSpeechStarted?: () => void;
  /** Azure decided the energy stopped. Cancels a pending barge-in. */
  onSpeechEnded?: () => void;
  /**
   * Interim hypothesis. Never starts a turn — only a final result does — but
   * real words here are what confirms the caller is genuinely speaking.
   */
  onPartial?: (text: string) => void;
  /** A finished utterance. */
  onFinal: (result: TranscriptionResult) => void;
  /** Recognizer failed. The session must say something, never go quiet. */
  onError: (error: Error) => void;
}

export interface ISpeechToText {
  /**
   * Resolves once the recognizer is actually live. Audio written before then
   * is buffered, but a caller that can pace itself should wait — and the
   * session uses it to know when it is safe to start speaking the greeting.
   */
  readonly ready: Promise<void>;
  /** Feed inbound mulaw straight from the socket. */
  write(mulaw: Buffer): void;
  /** Stop recognition and release the connection. */
  stop(): Promise<void>;
}

export interface SpeechToTextOptions {
  /**
   * Candidates for auto-detection on the first utterance. Pass a single
   * language to lock the session and skip detection entirely — detection costs
   * latency, and after the first turn the language is already known.
   */
  languages: Language[];
  handlers: SpeechToTextHandlers;
  /** Segmentation tuning. Omitted means the shared defaults. */
  recognition?: RecognitionConfig | undefined;
  /**
   * Vocabulary to bias recognition towards — service names, staff, days,
   * booking phrases. The single biggest accuracy lever on a narrow domain
   * over a phone line.
   */
  phrases?: string[] | undefined;
  /** Somewhere to report what each finalization was triggered by. */
  onDiagnostic?: ((payload: Record<string, unknown>, message: string) => void) | undefined;
}

export interface ISpeechProvider {
  createRecognizer(options: SpeechToTextOptions): ISpeechToText;
  createSynthesizer(): ITextToSpeech;
}
