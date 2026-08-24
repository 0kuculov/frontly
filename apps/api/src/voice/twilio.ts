import twilio from 'twilio';

/**
 * The Twilio side of the call: the TwiML that opens the socket, and the
 * signature check that keeps strangers off it.
 */

export interface TwimlOptions {
  /** wss:// URL of this server's media-stream endpoint. */
  streamUrl: string;
  /** Passed through to the socket so it knows which clinic was dialled. */
  businessId: string;
  /** Caller ID, so the session can use it without a second lookup. */
  from?: string | undefined;
}

/**
 * `<Connect><Stream>` rather than `<Start><Stream>`: Connect is bidirectional
 * and blocking, which is what lets the agent speak back over the same socket.
 * It is also terminal — when the socket closes, the call ends, which is how
 * hang-up works.
 */
export function buildStreamTwiml(options: TwimlOptions): string {
  const response = new twilio.twiml.VoiceResponse();
  const connect = response.connect();
  const stream = connect.stream({ url: options.streamUrl });

  stream.parameter({ name: 'businessId', value: options.businessId });
  if (options.from) stream.parameter({ name: 'from', value: options.from });

  return response.toString();
}

/**
 * Verify the request really came from Twilio.
 *
 * The webhook URL is public and starts a paid phone call, so an unauthenticated
 * endpoint is both a spam vector and a bill. Skipped only when no auth token is
 * configured, which is the local-development case.
 */
export function isValidTwilioRequest(input: {
  authToken: string | undefined;
  signature: string | undefined;
  url: string;
  params: Record<string, unknown>;
}): boolean {
  if (!input.authToken) return true; // not configured yet — Phase 3 local dev
  if (!input.signature) return false;
  return twilio.validateRequest(
    input.authToken,
    input.signature,
    input.url,
    input.params as Record<string, string>,
  );
}

/** Messages Twilio sends down the media socket. */
export type TwilioInboundMessage =
  | { event: 'connected'; protocol: string; version: string }
  | {
      event: 'start';
      streamSid: string;
      start: {
        callSid: string;
        streamSid: string;
        accountSid: string;
        tracks: string[];
        customParameters?: Record<string, string>;
        mediaFormat: { encoding: string; sampleRate: number; channels: number };
      };
    }
  | { event: 'media'; streamSid: string; media: { track: string; payload: string; timestamp: string } }
  | { event: 'dtmf'; streamSid: string; dtmf: { track: string; digit: string } }
  | { event: 'mark'; streamSid: string; mark: { name: string } }
  | { event: 'stop'; streamSid: string; stop: { callSid: string; accountSid: string } };

export function parseTwilioMessage(raw: string): TwilioInboundMessage | undefined {
  try {
    const parsed = JSON.parse(raw) as { event?: unknown };
    if (typeof parsed.event !== 'string') return undefined;
    return parsed as TwilioInboundMessage;
  } catch {
    return undefined;
  }
}

/** Outbound frame. Payload is base64 mulaw with no header. */
export function mediaMessage(streamSid: string, base64: string): string {
  return JSON.stringify({ event: 'media', streamSid, media: { payload: base64 } });
}

/** Discard everything Twilio has buffered — the barge-in primitive. */
export function clearMessage(streamSid: string): string {
  return JSON.stringify({ event: 'clear', streamSid });
}
