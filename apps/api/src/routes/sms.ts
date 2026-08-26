import type { ServerEnv } from '@frontly/shared';
import type { FastifyInstance } from 'fastify';
import type { ITelephonyProvider } from '../voice/telephony.js';

/**
 * Where the Telnyx messaging profile points its webhook.
 *
 * Two kinds of thing arrive here and they are not the same:
 *
 *   - **Delivery receipts** (`message.sent`, `message.finalized`). These are
 *     the only evidence that a message actually arrived. It matters more than
 *     usual for this product: a US long code aimed at a +389 handset is
 *     ACCEPTED by the API and fails later, so a 200 from the send call proves
 *     nothing on its own. `undeliverableReason()` refuses that case up front,
 *     but a sender ID that is approved and still fails per-carrier can only
 *     be seen here.
 *   - **Inbound messages** (`message.received`). Logged and acknowledged,
 *     nothing more. Replying by SMS is a conversation channel, and a
 *     conversation channel is a `packages/core` adapter — Phase 5's job, not
 *     something to improvise inside a webhook. Answering ad hoc here is
 *     exactly how a second, divergent conversation engine gets built by
 *     accident.
 *
 * Signature verification is shared with the voice webhook: same Ed25519
 * scheme, same `${timestamp}|${rawBody}` payload, same 5-minute replay
 * window, so it needs the RAW bytes and reuses the telephony provider's
 * verifier rather than growing a second copy of that logic.
 */

export interface SmsRouteOptions {
  env: ServerEnv;
  /** Only for `verifyWebhook` — the signing scheme is per account, not per product. */
  telephony?: ITelephonyProvider | undefined;
}

export async function registerSmsRoutes(
  app: FastifyInstance,
  options: SmsRouteOptions,
): Promise<void> {
  const { telephony } = options;

  /**
   * The raw body parser, for the same reason the voice plugin installs one:
   * Fastify's default JSON parse plus a re-serialize is not byte-identical,
   * and the signature is over the bytes Telnyx sent.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.post('/telnyx/sms', async (request, reply) => {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from('');

    if (telephony) {
      const ok = telephony.verifyWebhook({
        headers: request.headers as Record<string, string | string[] | undefined>,
        raw,
      });
      if (!ok) {
        app.log.warn({ route: '/telnyx/sms' }, 'rejected an unsigned or stale SMS webhook');
        return reply.code(403).send({ error: 'bad_signature' });
      }
    }

    let event: TelnyxMessageEvent | undefined;
    try {
      event = parseMessageEvent(JSON.parse(raw.toString('utf8')) as unknown);
    } catch {
      event = undefined;
    }

    if (!event) {
      // 200 on purpose: a body we cannot read is not something Telnyx should
      // retry, and a 4xx here would have it redeliver on a schedule forever.
      app.log.warn({ route: '/telnyx/sms' }, 'unparseable SMS webhook');
      return reply.code(200).send({ ok: true });
    }

    if (event.type === 'received') {
      app.log.info(
        { from: event.from, to: event.to, text: event.text?.slice(0, 200) },
        'inbound SMS (not answered — SMS is not a conversation channel yet)',
      );
      return reply.code(200).send({ ok: true });
    }

    /**
     * `delivery_failed` is the one worth raising a voice about: it is the
     * only place a message that the API accepted and the network dropped ever
     * shows up, and silence here reads exactly like success.
     */
    const failed = event.status === 'delivery_failed' || event.status === 'sending_failed';
    const log = failed ? app.log.warn.bind(app.log) : app.log.info.bind(app.log);
    log(
      { providerId: event.id, status: event.status, to: event.to, errors: event.errors },
      failed ? 'SMS delivery FAILED' : 'SMS delivery update',
    );

    return reply.code(200).send({ ok: true });
  });
}

interface TelnyxMessageEvent {
  type: 'received' | 'status';
  id?: string | undefined;
  status?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  text?: string | undefined;
  errors?: unknown;
}

/**
 * Telnyx wraps events as `{ data: { event_type, payload } }`, and delivers the
 * inner object directly on some paths — the voice adapter accepts both for
 * the same reason, and the cost of guessing wrong here is a delivery failure
 * nobody sees.
 */
function parseMessageEvent(body: unknown): TelnyxMessageEvent | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const envelope = body as { data?: unknown; event_type?: unknown; payload?: unknown };
  const event = (envelope.data ?? envelope) as {
    event_type?: unknown;
    payload?: Record<string, unknown>;
  };

  const name = typeof event.event_type === 'string' ? event.event_type : undefined;
  if (!name) return undefined;
  const payload = event.payload ?? {};

  /** `to` is an array on Telnyx messages — one entry per recipient. */
  const recipients = Array.isArray(payload.to) ? payload.to : [];
  const firstTo = recipients[0] as { phone_number?: unknown; status?: unknown } | undefined;

  const common = {
    id: str(payload.id),
    to: str(firstTo?.phone_number),
    from: str((payload.from as { phone_number?: unknown } | undefined)?.phone_number),
    errors: payload.errors,
  };

  if (name === 'message.received') {
    return { type: 'received', ...common, text: str(payload.text) };
  }
  if (name.startsWith('message.')) {
    return { type: 'status', ...common, status: str(firstTo?.status) ?? str(payload.type) };
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
