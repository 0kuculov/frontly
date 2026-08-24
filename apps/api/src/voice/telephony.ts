import type { PlaybackSink } from './audio.js';

/**
 * Telephony behind an interface.
 *
 * Telnyx carries the calls today. It is the second provider this file has
 * described — the first was Twilio — which is the entire argument for the
 * interface existing: the call session, the engine and the database never
 * learned that anything changed.
 *
 * Everything provider-shaped lives behind `ITelephonyProvider`:
 *   - webhook authenticity and parsing
 *   - answering, hanging up, transferring
 *   - the media WebSocket wire format
 *
 * Nothing above this line may reference Telnyx, a call_control_id, or a
 * stream_id. Adding a provider means one new file next to `telnyx.ts` plus one
 * line in the factory.
 */

// --- call control ------------------------------------------------------------

/**
 * A provider's opaque handle for the call.
 *
 * Telnyx calls it `call_control_id`, Twilio called it a `CallSid`. Callers of
 * this interface only ever pass it back, never parse it.
 */
export type CallRef = string;

/** The provider-neutral subset of call events the session actually reacts to. */
export type TelephonyEvent =
  | {
      type: 'call.initiated';
      callRef: CallRef;
      /** Caller ID. Absent when withheld. */
      from?: string | undefined;
      /** The number that was dialled — how a deployment routes to a business. */
      to?: string | undefined;
      /** Provider's own session id, logged for support tickets. */
      sessionId?: string | undefined;
    }
  | { type: 'call.answered'; callRef: CallRef }
  | { type: 'call.hangup'; callRef: CallRef; cause?: string | undefined }
  | { type: 'streaming.failed'; callRef: CallRef; reason?: string | undefined }
  /** Anything we do not act on, kept so the route can log it rather than 404. */
  | { type: 'ignored'; name: string };

export interface WebhookRequest {
  /** Raw body bytes. Signature verification cannot use the parsed object. */
  raw: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface AnswerOptions {
  callRef: CallRef;
  /** wss:// URL of this server's media endpoint. */
  streamUrl: string;
  /**
   * Opaque data handed back to us when the media socket opens.
   *
   * This is how the socket learns which business was dialled without a second
   * database lookup or a shared map keyed by call id — the provider carries it
   * for us across two unrelated connections.
   */
  clientState?: Record<string, string> | undefined;
}

export interface TransferOptions {
  callRef: CallRef;
  /** E.164 destination. */
  to: string;
  /** E.164 caller ID to present, which the provider must own. */
  from: string;
}

// --- media stream ------------------------------------------------------------

export interface MediaFormat {
  encoding: string;
  sampleRate: number;
  channels: number;
}

/** Provider-neutral messages arriving on the media socket. */
export type MediaMessage =
  | { kind: 'connected' }
  | {
      kind: 'start';
      /** Provider handle for this stream, needed to address outbound frames. */
      streamRef: string;
      callRef: CallRef;
      from?: string | undefined;
      to?: string | undefined;
      /** Whatever was passed to `answer`, decoded. */
      clientState?: Record<string, string> | undefined;
      format?: MediaFormat | undefined;
    }
  | { kind: 'audio'; track: 'inbound' | 'outbound'; payload: string }
  | { kind: 'dtmf'; digit: string }
  | { kind: 'stop'; streamRef?: string | undefined }
  | { kind: 'error'; code?: number | undefined; detail?: string | undefined };

/**
 * The wire format of the media socket.
 *
 * Deliberately separate from call control: a provider can change how a call is
 * answered without changing how audio frames are framed, and the two are used
 * from different places (an HTTP route and a WebSocket route).
 */
export interface IMediaProtocol {
  parse(raw: string): MediaMessage | undefined;
  /** One outbound audio frame. `payload` is base64 mulaw, no container. */
  encodeMedia(payload: string, streamRef: string | undefined): string;
  /** Discard everything the provider has buffered — the barge-in primitive. */
  encodeClear(streamRef: string | undefined): string;
}

// --- the provider ------------------------------------------------------------

export interface ITelephonyProvider {
  /** For logs and the health endpoint. */
  readonly name: string;

  /**
   * Where this provider's routes mount.
   *
   * Provider-specific by design: the URL is configured in someone else's
   * dashboard, so it is a fact about the provider, not about our routing.
   */
  readonly routePrefix: string;

  readonly media: IMediaProtocol;

  /**
   * Is this request really from the provider?
   *
   * The webhook URL is public and every call costs money, so an unauthenticated
   * endpoint is both a spam vector and a bill.
   */
  verifyWebhook(request: WebhookRequest): boolean;

  parseEvent(body: unknown): TelephonyEvent | undefined;

  /** Answer, and open a bidirectional media stream in the same command. */
  answer(options: AnswerOptions): Promise<void>;

  /**
   * End the call.
   *
   * Not optional the way it was under Twilio, where closing the media socket
   * dropped the call by itself. Here the socket and the call are independent:
   * close the socket alone and the caller keeps holding a silent line.
   */
  hangup(callRef: CallRef): Promise<void>;

  /** Hand the caller to a human. */
  transfer(options: TransferOptions): Promise<void>;

  /**
   * The stream settings `answer` will request, for logging.
   *
   * Exists because the settings that decide whether the caller hears anything
   * are provider-specific and not fully pinned down by any provider's docs.
   * Logging them turns "the call was silent" into a one-line diagnosis.
   */
  describeAnswer?(options: AnswerOptions): Record<string, unknown>;
}

/** A sink bound to one open media socket. */
export function createSink(
  send: (data: string) => void,
  protocol: IMediaProtocol,
  streamRef: () => string | undefined,
): PlaybackSink {
  return {
    sendFrame: (base64) => send(protocol.encodeMedia(base64, streamRef())),
    clear: () => send(protocol.encodeClear(streamRef())),
  };
}
