import type { FastifyPluginAsync } from 'fastify';
import {
  AnthropicLanguageModel,
  getBusinessContext,
  getBusinessForDialledNumber,
  type Database,
} from '@frontly/core';
import type { ServerEnv } from '@frontly/shared';
import { CallSession } from '../voice/session.js';
import type { SpeechCache } from '../voice/speech-cache.js';
import { callEvents } from '../demo/events.js';
import { createSink, type ITelephonyProvider } from '../voice/telephony.js';
import type { ISpeechProvider } from '../voice/types.js';

/**
 * The voice channel: one HTTP route that answers the phone, one WebSocket
 * route that carries the audio.
 *
 * Neither knows who the carrier is. Both go through `ITelephonyProvider`, so
 * the Twilio-to-Telnyx switch touched the adapter and this file's imports and
 * nothing else — no change to the session, the engine, or the database.
 */

export interface VoiceRoutesOptions {
  db: Database;
  env: ServerEnv;
  telephony: ITelephonyProvider;
  speech: ISpeechProvider;
  /** Pre-synthesized fixed phrases: the greeting, the fillers, the apologies. */
  cache?: SpeechCache | undefined;
  /**
   * Resolves when the speech cache has finished warming.
   *
   * Awaited before answering, because a cold Render instance finishes warming
   * after the first caller has already dialled.
   */
  speechReady?: Promise<unknown> | undefined;
  /** How long to wait for that before answering anyway. */
  speechReadyTimeoutMs?: number;
  /**
   * Text the confirmation the moment a booking is made.
   *
   * Optional: the phone works without SMS configured, and a missing messaging
   * profile must never stop a call being answered. Failures here are picked
   * up by the hourly sweep.
   */
  onBooked?: ((appointmentId: string) => void) | undefined;
}

export const voiceRoutes: FastifyPluginAsync<VoiceRoutesOptions> = async (app, opts) => {
  const { db, env, telephony, speech, cache } = opts;
  const speechReadyTimeoutMs = opts.speechReadyTimeoutMs ?? 8000;

  /**
   * Calls already being answered in this process.
   *
   * Webhook delivery retries — routine on a cold instance, where the first
   * request times out while Render is still starting — used to answer and log
   * twice for one call. `command_id` makes Telnyx discard the duplicate
   * command, but only this stops the duplicate log.
   */
  const answering = new Set<string>();
  const model = new AnthropicLanguageModel({ model: env.ANTHROPIC_MODEL });

  /**
   * Keep the raw bytes.
   *
   * Signature verification runs over the exact body that was signed, and
   * `JSON.parse` followed by `JSON.stringify` is not byte-identical — key order
   * and whitespace both move. Encapsulated in this plugin, so the rest of the
   * API keeps the normal parser.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      (request as { rawBody?: Buffer }).rawBody = body;
      try {
        done(null, body.length > 0 ? JSON.parse(body.toString('utf8')) : {});
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  // --- call control webhook -------------------------------------------------

  app.post(`${telephony.routePrefix}/voice`, async (request, reply) => {
    const raw = (request as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);

    if (!telephony.verifyWebhook({ raw, headers: request.headers })) {
      app.log.warn({ provider: telephony.name }, 'rejected an unsigned telephony webhook');
      return reply.code(403).send({ error: 'invalid_signature' });
    }

    const event = telephony.parseEvent(request.body);
    if (!event) return reply.code(200).send({ ok: true });

    /**
     * Always 200, always immediately.
     *
     * The provider retries anything else, and a retried `call.initiated`
     * answers a call that is already answered. Work that can fail happens after
     * the response — the webhook is a notification, not a request for a result.
     */
    switch (event.type) {
      case 'call.initiated': {
        if (answering.has(event.callRef)) {
          app.log.info(
            { callRef: event.callRef },
            'ignoring a duplicate call.initiated — already answering this call',
          );
          break;
        }
        answering.add(event.callRef);
        // Bounded: a long-lived instance must not accumulate call refs.
        if (answering.size > 500) answering.delete(answering.values().next().value!);
        void answerCall(event.callRef, event.from, event.to);
        break;
      }

      case 'call.hangup':
        app.log.info(
          { callRef: event.callRef, cause: event.cause, provider: telephony.name },
          'caller hung up',
        );
        break;

      case 'streaming.failed':
        // The call is up but has no audio path. Nothing to salvage in-band, so
        // make it loud: silence on a demo line looks like a crash.
        app.log.error(
          { callRef: event.callRef, reason: event.reason },
          'media streaming failed to start — the caller is on a silent line',
        );
        void telephony.hangup(event.callRef).catch(() => {});
        break;

      default:
        break;
    }

    return reply.code(200).send({ ok: true });
  });

  async function answerCall(
    callRef: string,
    from: string | undefined,
    to: string | undefined,
  ): Promise<void> {
    try {
      const business = await getBusinessForDialledNumber(db, to);

      if (!business) {
        /**
         * An unrouted number is an operations error, not something to improvise
         * around: the provider's own text-to-speech has no Macedonian voice, so
         * answering would put the caller in front of a wrong-language apology.
         * Refuse the call and make the log impossible to miss.
         */
        app.log.error(
          { to, callRef },
          'no business is configured for the dialled number — rejecting the call',
        );
        await telephony.hangup(callRef);
        return;
      }

      const base = env.PUBLIC_BASE_URL;
      if (!base) throw new Error('PUBLIC_BASE_URL is not set, so the stream URL cannot be built');

      /**
       * Never answer into a pipeline that cannot speak.
       *
       * On a cold instance the first caller arrives while the speech cache is
       * still warming. Waiting costs a second or two of ringing; answering
       * early costs the greeting. If warming is slower than the bound, we go
       * ahead anyway and say so — on-demand synthesis is a real audio path,
       * just an Azure round trip slower, and it is what the session already
       * falls back to when the cache misses.
       */
      if (opts.speechReady) {
        const warmedInTime = await Promise.race([
          opts.speechReady.then(() => true).catch(() => false),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), speechReadyTimeoutMs)),
        ]);
        if (!warmedInTime) {
          app.log.warn(
            { callRef, waitedMs: speechReadyTimeoutMs },
            'answering before the speech cache finished warming — the greeting will be ' +
              'synthesized on demand, which is slower but not silent',
          );
        }
      }

      const streamUrl = `${base.replace(/^http/, 'ws')}${telephony.routePrefix}/stream`;

      const outcome = await telephony.answer({
        callRef,
        streamUrl,
        // Carried by the provider across to the media socket, which is a
        // separate connection with no other way to learn any of this.
        clientState: {
          businessId: business.id,
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
        },
      });

      /**
       * Logged only when the command actually succeeded.
       *
       * This used to fire unconditionally after `answer` resolved, and
       * `answer` resolved even when the carrier had rejected the command —
       * so the log read "call answered" for a call that was never answered.
       *
       * The stream parameters go in the same line because `stream_track` and
       * `stream_bidirectional_target_legs` are the two settings that produce a
       * connected-but-silent call.
       */
      if (outcome === 'call_gone') {
        app.log.warn(
          { callRef, from, to },
          'the caller hung up before we could answer',
        );
        return;
      }

      app.log.info(
        {
          callRef,
          from,
          to,
          business: business.id,
          stream: telephony.describeAnswer?.({ callRef, streamUrl }),
        },
        'call answered',
      );
    } catch (error) {
      /**
       * Release the call ref so a webhook retry can try again.
       *
       * The dedupe above exists to stop a retry answering twice; it must not
       * stop a retry answering at all when the first attempt never got there.
       */
      answering.delete(callRef);
      app.log.error(
        { callRef, err: error instanceof Error ? error.message : error },
        'failed to answer the call',
      );
      await telephony.hangup(callRef).catch(() => {});
    }
  }

  // --- media stream ---------------------------------------------------------

  /**
   * Call refs with a live media stream, so a second one is visible.
   *
   * A production call on 30 Aug 2026 booked an appointment and stored an empty
   * transcript. Both sessions would have shared the conversation row (it is
   * keyed on the call ref), so a silent second session persisting last is the
   * shape that explains it — but nothing in the logs could confirm or refute
   * that, which is the actual problem. The database no longer lets an empty
   * writer win; this says out loud whether there was one.
   *
   * Diagnostic only. It deliberately does not refuse the second stream: which
   * of the two carries the caller's audio is exactly what is not known.
   */
  const liveStreams = new Set<string>();

  app.get(`${telephony.routePrefix}/stream`, { websocket: true }, (socket) => {
    let session: CallSession | undefined;
    let streamRef: string | undefined;
    let callRef: string | undefined;
    let closing = false;

    const send = (data: string): void => {
      if (socket.readyState === socket.OPEN) socket.send(data);
    };

    const closeSocket = (): void => {
      if (closing) return;
      closing = true;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    };

    /**
     * End the call, not just the socket.
     *
     * Under Twilio the socket was the call and closing it was enough. Telnyx
     * keeps them separate: drop the socket alone and the caller sits on an open,
     * silent, billable line.
     */
    const endCall = (): void => {
      const ref = callRef;
      if (ref) void telephony.hangup(ref).catch(() => {});
      closeSocket();
    };

    socket.on('message', (raw: Buffer) => {
      const message = telephony.media.parse(raw.toString());
      if (!message) return;

      switch (message.kind) {
        case 'connected':
          break;

        case 'start': {
          streamRef = message.streamRef;
          callRef = message.callRef;
          const state = message.clientState ?? {};

          if (message.format && message.format.encoding.toUpperCase() !== 'PCMU') {
            // The whole pipeline is 8 kHz mulaw end to end. Anything else would
            // be decoded as mulaw anyway and come out as noise, so say so.
            app.log.error(
              { callRef, format: message.format },
              'media stream opened with an unexpected encoding — expected PCMU',
            );
          }

          void startSession({
            callRef: message.callRef,
            businessId: state.businessId,
            from: state.from ?? message.from,
            to: state.to ?? message.to,
          });
          break;
        }

        case 'audio':
          // `stream_track: inbound_track` means only the caller reaches us, but
          // the guard stays: an accidental both_tracks would otherwise feed our
          // own voice into the recognizer and the agent would barge in on itself.
          if (message.track === 'inbound') session?.onMedia(message.payload);
          break;

        case 'stop':
          void session?.stop('provider_stop').finally(closeSocket);
          break;

        case 'error':
          app.log.error(
            { callRef, code: message.code, detail: message.detail },
            'media stream error',
          );
          break;

        default:
          break;
      }
    });

    socket.on('close', () => {
      closing = true;
      if (callRef) liveStreams.delete(callRef);
      void session?.stop('socket_closed');
    });

    socket.on('error', (error: Error) => {
      app.log.error({ err: error.message }, 'media socket error');
      void session?.stop('socket_error');
    });

    async function startSession(input: {
      callRef: string;
      businessId?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
    }): Promise<void> {
      if (session) {
        // A second `start` on one socket would replace the running session and
        // leave the first holding an open recognizer nobody stops.
        app.log.warn({ callRef: input.callRef }, 'ignoring a second stream start on one socket');
        return;
      }
      if (liveStreams.has(input.callRef)) {
        app.log.warn(
          { callRef: input.callRef },
          'a second media stream opened for a call that already has one',
        );
      }
      liveStreams.add(input.callRef);
      try {
        const context = input.businessId
          ? await getBusinessContext(db, input.businessId)
          : undefined;

        if (!context) {
          app.log.error({ callRef: input.callRef }, 'stream started for an unknown business');
          endCall();
          return;
        }

        session = new CallSession({
          db,
          business: context.business,
          services: context.services,
          staff: context.staff,
          provider: speech,
          model,
          callRef: input.callRef,
          from: input.from,
          logger: app.log,
          cache,
          // The demo screen listens here. The session does not know that.
          onEvent: (event) => callEvents.publish(event),
          onHangUp: endCall,
          ...(opts.onBooked ? { onBooked: opts.onBooked } : {}),
          onTransfer: async (to) => {
            await telephony.transfer({
              callRef: input.callRef,
              to,
              // Present the dialled number as caller ID: the provider must own
              // whatever it sends, and this is the one we know it owns.
              from: input.to ?? env.TELNYX_PHONE_NUMBER ?? '',
            });
          },
          sink: createSink(send, telephony.media, () => streamRef),
        });

        await session.start();
      } catch (error) {
        app.log.error(
          { callRef: input.callRef, err: error instanceof Error ? error.message : error },
          'failed to start call session',
        );
        endCall();
      }
    }
  });
};
