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
}

export const voiceRoutes: FastifyPluginAsync<VoiceRoutesOptions> = async (app, opts) => {
  const { db, env, telephony, speech, cache } = opts;
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

      const streamUrl = `${base.replace(/^http/, 'ws')}${telephony.routePrefix}/stream`;

      await telephony.answer({
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
       * The stream parameters are logged, not just the fact of answering.
       * `stream_track` and `stream_bidirectional_target_legs` are the two
       * settings that produce a connected-but-silent call, and this is the
       * line that says which values were in play when that happens.
       */
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
      app.log.error(
        { callRef, err: error instanceof Error ? error.message : error },
        'failed to answer the call',
      );
      await telephony.hangup(callRef).catch(() => {});
    }
  }

  // --- media stream ---------------------------------------------------------

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
          onHangUp: endCall,
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
