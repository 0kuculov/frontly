import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { createHash } from 'node:crypto';
import type {
  AnswerOptions,
  CallRef,
  CommandOutcome,
  IMediaProtocol,
  ITelephonyProvider,
  MediaMessage,
  TelephonyEvent,
  TransferOptions,
  WebhookRequest,
} from './telephony.js';

/**
 * Telnyx Call Control v2.
 *
 * Written against the current docs rather than by analogy with Twilio, because
 * three things differ in ways that fail silently if assumed:
 *
 *  1. There is no TwiML. A call is answered by POSTing a command to an API,
 *     and the media stream is opened by parameters on that same command.
 *  2. Closing the media socket does not end the call. Twilio's `<Connect>` was
 *     terminal; here the socket and the call are independent, so hanging up is
 *     an explicit command. Skip it and the caller holds a silent line until
 *     they give up — and the meter runs the whole time.
 *  3. Outbound media frames carry no stream identifier. Twilio required
 *     `streamSid` on every frame; Telnyx rejects nothing but ignores it, and
 *     the socket is already one-per-call.
 *
 * Sources:
 *   https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming
 *   https://developers.telnyx.com/api-reference/call-commands/answer-call
 */

const API_BASE = 'https://api.telnyx.com/v2';

/** Telnyx signs `${timestamp}|${rawBody}` and rejects replays past this age. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * DER prefix that turns a raw 32-byte Ed25519 public key into an SPKI document,
 * which is the only shape `crypto.createPublicKey` accepts. Telnyx publishes
 * the raw key, base64-encoded, in the portal.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface TelnyxOptions {
  apiKey: string;
  /** Account Settings → Keys & Credentials → Public Key. */
  publicKey?: string | undefined;
  /**
   * Which legs hear what we send.
   *
   * `both` rather than the API default of `opposite`, because an inbound call
   * that has not been bridged has no opposite leg, and the docs do not say
   * which side an unbridged leg counts as. `both` is the only value that is
   * correct under either reading; with no second leg there is nothing else it
   * could reach. If a real call proves `opposite` alone works, narrow it.
   */
  targetLegs?: 'both' | 'self' | 'opposite';
  /** Injectable so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Injectable so signature-tolerance tests are not clock-dependent. */
  now?: () => number;
}

export class TelnyxProvider implements ITelephonyProvider {
  readonly name = 'telnyx';
  readonly routePrefix = '/telnyx';
  readonly media: IMediaProtocol = telnyxMediaProtocol;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: TelnyxOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  // --- authenticity ----------------------------------------------------------

  /**
   * Ed25519 over `${timestamp}|${rawBody}`.
   *
   * Asymmetric, so there is no shared secret to leak: the portal publishes a
   * public key and Telnyx keeps the private one. The timestamp is inside the
   * signed string, so an attacker cannot replay yesterday's `call.initiated`
   * with a fresh header.
   */
  verifyWebhook(request: WebhookRequest): boolean {
    const publicKey = this.options.publicKey;
    if (!publicKey) return true; // not configured — local development only

    const signature = header(request.headers, 'telnyx-signature-ed25519');
    const timestamp = header(request.headers, 'telnyx-timestamp');
    if (!signature || !timestamp) return false;

    const age = Math.abs(Math.floor(this.now() / 1000) - Number(timestamp));
    if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return false;

    try {
      const key = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, 'base64')]),
        format: 'der',
        type: 'spki',
      });
      const signed = Buffer.concat([
        Buffer.from(`${timestamp}|`, 'utf8'),
        request.raw,
      ]);
      // Ed25519 takes no separate digest algorithm, hence the null.
      return verifySignature(null, signed, key, Buffer.from(signature, 'base64'));
    } catch {
      return false;
    }
  }

  // --- events ----------------------------------------------------------------

  /**
   * Telnyx wraps events as `{ data: { event_type, payload } }`. Some older
   * examples and the retry path deliver the inner object directly, so both are
   * accepted — the cost is one `??` and the failure mode of guessing wrong is
   * an unanswered phone.
   */
  parseEvent(body: unknown): TelephonyEvent | undefined {
    if (typeof body !== 'object' || body === null) return undefined;
    const envelope = body as { data?: unknown; event_type?: unknown; payload?: unknown };
    const event = (envelope.data ?? envelope) as {
      event_type?: unknown;
      payload?: Record<string, unknown>;
    };

    const name = typeof event.event_type === 'string' ? event.event_type : undefined;
    if (!name) return undefined;

    const payload = event.payload ?? {};
    const callRef = str(payload.call_control_id);

    switch (name) {
      case 'call.initiated':
        if (!callRef) return undefined;
        return {
          type: 'call.initiated',
          callRef,
          from: str(payload.from),
          to: str(payload.to),
          sessionId: str(payload.call_session_id),
        };

      case 'call.answered':
        return callRef ? { type: 'call.answered', callRef } : undefined;

      case 'call.hangup':
        return callRef
          ? { type: 'call.hangup', callRef, cause: str(payload.hangup_cause) }
          : undefined;

      case 'streaming.failed':
        return callRef
          ? {
              type: 'streaming.failed',
              callRef,
              reason: str(payload.failure_reason) ?? str(payload.reason),
            }
          : undefined;

      default:
        return { type: 'ignored', name };
    }
  }

  // --- commands --------------------------------------------------------------

  /**
   * Answer and open the media stream in one command.
   *
   * Doing it in two (answer, then `streaming_start`) costs a round trip during
   * which the caller is connected and hearing nothing, and leaves a window
   * where the greeting can be synthesized before anything can carry it.
   */
  async answer(options: AnswerOptions): Promise<CommandOutcome> {
    return this.command(options.callRef, 'answer', this.answerBody(options));
  }

  /**
   * Split out so the route can log exactly what was requested.
   *
   * Two of these values are judgement calls the docs do not fully settle, and
   * both fail the same way — the call connects and the caller hears nothing.
   * Having them in the log turns a silent call from a mystery into a one-line
   * diagnosis.
   */
  private answerBody(options: AnswerOptions): Record<string, unknown> {
    return {
      stream_url: options.streamUrl,
      // Only the caller's audio. Asking for both tracks would feed our own
      // playback straight back into the recognizer, and the agent would
      // interrupt itself on every sentence it spoke.
      stream_track: 'inbound_track',
      stream_bidirectional_mode: 'rtp',
      // PCMU is mulaw 8 kHz — byte-identical to what Azure synthesizes and to
      // what the recognizer expects, so no transcoding happens on our side.
      stream_bidirectional_codec: 'PCMU',
      stream_bidirectional_sampling_rate: 8000,
      stream_bidirectional_target_legs: this.options.targetLegs ?? 'both',
      ...(options.clientState
        ? { client_state: encodeClientState(options.clientState) }
        : {}),
      // Webhook delivery retries — and Render's free tier cold-starts for ~50s
      // against a 30s webhook timeout, so a retry is expected, not exotic.
      // Without an idempotency key that retry answers the same call twice.
      command_id: commandId(options.callRef, 'answer'),
    };
  }

  /** The subset worth reading in a log line: no base64, no idempotency key. */
  describeAnswer(options: AnswerOptions): Record<string, unknown> {
    const { client_state: _state, command_id: _id, ...rest } = this.answerBody(options);
    return rest;
  }

  async hangup(callRef: CallRef): Promise<void> {
    await this.command(callRef, 'hangup', {
      command_id: commandId(callRef, 'hangup'),
    });
  }

  /**
   * Hand the caller to a human.
   *
   * Requires an **outbound voice profile** on the Telnyx connection: a transfer
   * places a new outbound call, and an account with no outbound profile is
   * rejected. The error is re-thrown with that spelled out, because the raw
   * API message does not make the cause obvious.
   */
  async transfer(options: TransferOptions): Promise<void> {
    try {
      await this.command(options.callRef, 'transfer', {
        to: options.to,
        from: options.from,
        command_id: commandId(options.callRef, 'transfer'),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Telnyx refused the transfer to ${options.to}: ${detail}. ` +
          'A transfer places an outbound call, so the connection needs an outbound ' +
          'voice profile with that destination enabled.',
      );
    }
  }

  private async command(
    callRef: CallRef,
    action: string,
    body: Record<string, unknown>,
  ): Promise<CommandOutcome> {
    const response = await this.fetchImpl(
      `${API_BASE}/calls/${encodeURIComponent(callRef)}/actions/${action}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (response.ok) return 'done';

    /**
     * A call that has already ended is not an error worth throwing over: the
     * caller hanging up mid-turn races every command we send, and a rejected
     * hangup on a dead call would otherwise surface as a failed call.
     *
     * It is emphatically NOT success either. This used to return the same
     * nothing as a 200, so a 422 whose body happened to mention the call
     * ending was reported to the caller of this method as a clean answer —
     * and the route logged "call answered" for a call it had not answered.
     */
    const text = await response.text().catch(() => '');
    if (response.status === 404 || /call.*(not found|has ended|is not active)/i.test(text)) {
      return 'call_gone';
    }
    throw new Error(`telnyx ${action} failed (HTTP ${response.status}): ${describe(text)}`);
  }
}

// --- the media socket --------------------------------------------------------

/**
 * Telnyx's WebSocket framing. Close to Twilio's, and the two differences are
 * exactly the ones that break quietly:
 *   - the stream identifier is `stream_id`, at the top level, not `streamSid`
 *   - outbound frames carry no identifier at all
 */
export const telnyxMediaProtocol: IMediaProtocol = {
  parse(raw: string): MediaMessage | undefined {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }

    const event = parsed.event;
    if (typeof event !== 'string') return undefined;

    switch (event) {
      case 'connected':
        return { kind: 'connected' };

      case 'start': {
        const start = (parsed.start ?? {}) as Record<string, unknown>;
        const format = start.media_format as Record<string, unknown> | undefined;
        const callRef = str(start.call_control_id);
        if (!callRef) return undefined;
        return {
          kind: 'start',
          streamRef: str(parsed.stream_id) ?? '',
          callRef,
          from: str(start.from),
          to: str(start.to),
          clientState: decodeClientState(str(start.client_state)),
          ...(format
            ? {
                format: {
                  encoding: String(format.encoding ?? ''),
                  sampleRate: Number(format.sample_rate ?? 0),
                  channels: Number(format.channels ?? 0),
                },
              }
            : {}),
        };
      }

      case 'media': {
        const media = (parsed.media ?? {}) as Record<string, unknown>;
        const payload = str(media.payload);
        if (!payload) return undefined;
        // Telnyx labels tracks `inbound`/`outbound`; anything unexpected is
        // treated as the caller, because dropping the caller is worse than
        // briefly hearing ourselves.
        return {
          kind: 'audio',
          track: str(media.track) === 'outbound' ? 'outbound' : 'inbound',
          payload,
        };
      }

      case 'dtmf': {
        const dtmf = (parsed.dtmf ?? {}) as Record<string, unknown>;
        const digit = str(dtmf.digit);
        return digit ? { kind: 'dtmf', digit } : undefined;
      }

      case 'stop':
        return { kind: 'stop', streamRef: str(parsed.stream_id) };

      case 'error': {
        const payload = (parsed.payload ?? {}) as Record<string, unknown>;
        return {
          kind: 'error',
          code: typeof payload.code === 'number' ? payload.code : undefined,
          detail: str(payload.detail) ?? str(payload.title),
        };
      }

      default:
        return undefined;
    }
  },

  encodeMedia(payload: string): string {
    return JSON.stringify({ event: 'media', media: { payload } });
  },

  encodeClear(): string {
    return JSON.stringify({ event: 'clear' });
  },
};

// --- helpers -----------------------------------------------------------------

/**
 * `client_state` is base64 and echoed back on the media socket, which is how
 * the socket learns which business was dialled without a shared in-memory map.
 * A map would not survive two Render instances; this does.
 */
export function encodeClientState(state: Record<string, string>): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
}

export function decodeClientState(
  encoded: string | undefined,
): Record<string, string> | undefined {
  if (!encoded) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  } catch {
    return undefined;
  }
}

/**
 * A stable UUID per (call, action), so a redelivered webhook produces the same
 * command id and Telnyx discards the duplicate instead of acting twice.
 */
function commandId(callRef: string, action: string): string {
  const hex = createHash('sha256').update(`${callRef}:${action}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Pull the useful line out of a Telnyx error body. */
function describe(text: string): string {
  try {
    const parsed = JSON.parse(text) as { errors?: { detail?: string; title?: string }[] };
    const first = parsed.errors?.[0];
    if (first) return first.detail ?? first.title ?? text.slice(0, 200);
  } catch {
    /* not JSON */
  }
  return text.slice(0, 200);
}
