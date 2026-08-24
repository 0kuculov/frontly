import type { FastifyPluginAsync } from 'fastify';
import {
  AnthropicLanguageModel,
  getBusinessContext,
  getBusinessForDialledNumber,
  type Database,
} from '@frontly/core';
import { requireEnv, type ServerEnv } from '@frontly/shared';
import { AzureSpeechProvider } from '../voice/azure.js';
import { CallSession } from '../voice/session.js';
import {
  buildStreamTwiml,
  clearMessage,
  isValidTwilioRequest,
  mediaMessage,
  parseTwilioMessage,
} from '../voice/twilio.js';
import type { ISpeechProvider } from '../voice/types.js';

/**
 * The voice channel: one HTTP route that answers the phone, one WebSocket
 * route that carries the audio.
 *
 * This file is the entire "Twilio" surface of Frontly. The conversation itself
 * lives in @frontly/core and knows nothing about any of it.
 */

export interface VoiceRoutesOptions {
  db: Database;
  env: ServerEnv;
  /** Injectable so tests can drive the socket with fake speech. */
  provider?: ISpeechProvider;
}

export const voiceRoutes: FastifyPluginAsync<VoiceRoutesOptions> = async (app, opts) => {
  const { db, env } = opts;

  const provider =
    opts.provider ??
    (() => {
      const { AZURE_SPEECH_KEY, AZURE_SPEECH_REGION } = requireEnv(
        env,
        ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'],
        'Azure speech',
      );
      return new AzureSpeechProvider({ key: AZURE_SPEECH_KEY, region: AZURE_SPEECH_REGION });
    })();

  const model = new AnthropicLanguageModel({ model: env.ANTHROPIC_MODEL });

  // --- inbound call ---------------------------------------------------------

  app.post('/voice/incoming', async (request, reply) => {
    const params = (request.body ?? {}) as Record<string, string>;
    const publicBase = env.PUBLIC_BASE_URL ?? `https://${request.headers.host ?? 'localhost'}`;

    if (
      !isValidTwilioRequest({
        authToken: env.TWILIO_AUTH_TOKEN,
        signature: request.headers['x-twilio-signature'] as string | undefined,
        url: `${publicBase}/voice/incoming`,
        params,
      })
    ) {
      app.log.warn({ from: params.From }, 'rejected an unsigned Twilio request');
      return reply.code(403).send({ error: 'invalid_signature' });
    }

    const business = await getBusinessForDialledNumber(db, params.To);
    if (!business) {
      app.log.error({ to: params.To }, 'no business is configured for the dialled number');
      // Say something rather than dropping the call into silence.
      return reply
        .type('text/xml')
        .send(
          '<?xml version="1.0" encoding="UTF-8"?><Response><Say language="mk-MK">' +
            'Извинете, бројот не е во употреба.</Say><Hangup/></Response>',
        );
    }

    const wsUrl = `${publicBase.replace(/^http/, 'ws')}/voice/stream`;
    const twiml = buildStreamTwiml({
      streamUrl: wsUrl,
      businessId: business.id,
      from: params.From,
    });

    app.log.info({ callSid: params.CallSid, from: params.From, business: business.id }, 'call answered');
    return reply.type('text/xml').send(twiml);
  });

  // --- media stream ---------------------------------------------------------

  app.get('/voice/stream', { websocket: true }, (socket) => {
    let session: CallSession | undefined;
    let streamSid: string | undefined;
    let closing = false;

    const closeSocket = (): void => {
      if (closing) return;
      closing = true;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    };

    socket.on('message', (raw: Buffer) => {
      const message = parseTwilioMessage(raw.toString());
      if (!message) return;

      switch (message.event) {
        case 'connected':
          break;

        case 'start': {
          streamSid = message.streamSid;
          const params = message.start.customParameters ?? {};
          void startSession({
            callSid: message.start.callSid,
            businessId: params.businessId,
            from: params.from,
          });
          break;
        }

        case 'media':
          // Only the caller's audio; our own playback is echoed on `outbound`.
          if (message.media.track === 'inbound') session?.onMedia(message.media.payload);
          break;

        case 'stop':
          void session?.stop('twilio_stop').finally(closeSocket);
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
      callSid: string;
      businessId?: string | undefined;
      from?: string | undefined;
    }): Promise<void> {
      try {
        const context = input.businessId
          ? await getBusinessContext(db, input.businessId)
          : undefined;

        if (!context) {
          app.log.error({ callSid: input.callSid }, 'stream started for an unknown business');
          closeSocket();
          return;
        }

        session = new CallSession({
          db,
          business: context.business,
          services: context.services,
          staff: context.staff,
          provider,
          model,
          callSid: input.callSid,
          from: input.from,
          logger: app.log,
          onHangUp: closeSocket,
          sink: {
            sendFrame: (base64) => {
              if (streamSid && socket.readyState === socket.OPEN) {
                socket.send(mediaMessage(streamSid, base64));
              }
            },
            clear: () => {
              if (streamSid && socket.readyState === socket.OPEN) {
                socket.send(clearMessage(streamSid));
              }
            },
          },
        });

        await session.start();
      } catch (error) {
        app.log.error(
          { callSid: input.callSid, err: error instanceof Error ? error.message : error },
          'failed to start call session',
        );
        closeSocket();
      }
    }
  });
};
