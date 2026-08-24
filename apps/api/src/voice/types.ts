import type { Language, VoiceProfile } from '@frontly/shared';

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
}

export interface SpeechToTextHandlers {
  /** Fired while the caller is still speaking — drives barge-in. */
  onSpeechStarted?: () => void;
  /** Interim hypothesis; not stable enough to act on. */
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
}

export interface ISpeechProvider {
  createRecognizer(options: SpeechToTextOptions): ISpeechToText;
  createSynthesizer(): ITextToSpeech;
}
