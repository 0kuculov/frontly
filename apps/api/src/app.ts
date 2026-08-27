import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import websocket from '@fastify/websocket';
import { createDb, enableForeignKeys, type Database } from '@frontly/core';
import type { ServerEnv } from '@frontly/shared';
import { registerChatRoutes } from './routes/chat.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerDemoRoutes } from './routes/demo.js';
import { registerSmsRoutes } from './routes/sms.js';
import { healthRoutes } from './routes/health.js';
import { voiceRoutes } from './routes/voice.js';
import { AzureSpeechProvider } from './voice/azure.js';
import { SpeechCache } from './voice/speech-cache.js';
import { TelnyxProvider } from './voice/telnyx.js';
import { confirmNow } from './sms/follow-up.js';
import { TelnyxSmsProvider, type ISmsProvider } from './sms/sms.js';
import { warmAllBusinesses } from './voice/warm.js';
import type { ITelephonyProvider } from './voice/telephony.js';
import type { ISpeechProvider } from './voice/types.js';
import { smsSender } from '@frontly/shared';

export const API_VERSION = '0.1.0';

export interface BuildAppResult {
  app: FastifyInstance;
  db: Database;
}

/**
 * Builds the server without listening, so tests can drive it via app.inject()
 * and the stage demo can be exercised without a port.
 *
 * Channel adapters (telephony in Phase 3, the chat widget socket in Phase 5)
 * register here as plugins. They may talk to @frontly/core; core never reaches
 * back into this file.
 */
export interface BuildAppOptions {
  /** Injectable so the voice tests can drive a call with fake speech. */
  speechProvider?: ISpeechProvider;
  /** Injectable so the voice tests never place a real call. */
  telephonyProvider?: ITelephonyProvider;
  /** Tests turn this off so they do not synthesize on boot. */
  warmSpeechCache?: boolean;
  /** Injectable so tests never send a real text message. */
  smsProvider?: ISmsProvider;
  /**
   * Refuse to boot without a working voice channel. Defaults to true in
   * production. Tests set it explicitly rather than depending on NODE_ENV.
   */
  requireVoiceChannel?: boolean;
}

export async function buildApp(
  env: ServerEnv,
  options: BuildAppOptions = {},
): Promise<BuildAppResult> {
  const db = createDb({ url: env.DATABASE_URL, authToken: env.DATABASE_AUTH_TOKEN });
  await enableForeignKeys(db);

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Pretty logs are a dev nicety; Render wants one JSON object per line.
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
        : {}),
    },
    // Render terminates TLS upstream, so the caller's IP and the https scheme
    // arrive in X-Forwarded-*.
    trustProxy: true,
  });

  await app.register(sensible);
  await app.register(websocket);
  await app.register(cors, {
    origin: env.APP_ORIGIN,
    credentials: true,
  });

  /**
   * Set once the voice channel has actually mounted, and read by /health so a
   * green health check means the phone works, not merely that the process is
   * up. Declared before the health route so the closure sees later writes.
   */
  let voiceChannel: { carrier: string; prefix: string } | undefined;

  await app.register(registerChatRoutes, { db, env });
  await app.register(registerDashboardRoutes, { db, env });
  await app.register(registerDemoRoutes, { db, env });

  await app.register(healthRoutes, {
    db,
    version: API_VERSION,
    voice: () => voiceChannel,
  });

  /**
   * The voice channel needs both a carrier and a speech provider.
   *
   * Outside production, missing either disables voice and leaves the rest of
   * the API up — that is what makes the dashboard workable without an Azure
   * key. In production it is fatal, because Frontly IS the phone line: an
   * instance that answers /health but has no voice route is a service that
   * looks alive and silently cannot take a call. That exact state shipped
   * once and was only noticed by curling the webhook by hand.
   */
  const speech: ISpeechProvider | undefined =
    options.speechProvider ??
    (env.AZURE_SPEECH_KEY
      ? new AzureSpeechProvider({ key: env.AZURE_SPEECH_KEY, region: env.AZURE_SPEECH_REGION })
      : undefined);

  const telephony: ITelephonyProvider | undefined =
    options.telephonyProvider ??
    (env.TELNYX_API_KEY
      ? new TelnyxProvider({ apiKey: env.TELNYX_API_KEY, publicKey: env.TELNYX_PUBLIC_KEY })
      : undefined);

  /**
   * SMS is optional, and stays optional.
   *
   * The phone is the product; follow-up messages are not. A missing messaging
   * profile must never stop a call being answered, so unlike the voice channel
   * this is never asserted at boot — it simply logs what it is missing and the
   * confirmation hook is left unwired.
   */
  const sender = smsSender(env);
  const sms: ISmsProvider | undefined =
    options.smsProvider ??
    (env.TELNYX_API_KEY && sender
      ? new TelnyxSmsProvider({ apiKey: env.TELNYX_API_KEY, sender })
      : undefined);

  if (sms && sender) {
    app.log.info(
      { from: sender.from, alphanumeric: sender.alphanumeric },
      'SMS follow-up enabled',
    );
  } else {
    app.log.warn(
      { hasApiKey: Boolean(env.TELNYX_API_KEY), hasSender: Boolean(sender) },
      'SMS follow-up disabled — set TELNYX_SMS_FROM to enable',
    );
  }

  /**
   * Registered with the resolved provider, not `options.telephonyProvider`:
   * webhook signatures are verified by the real Telnyx public key, and an
   * injected test double would leave production unverified.
   */
  await app.register(registerSmsRoutes, { env, telephony });

  const voiceRequired = options.requireVoiceChannel ?? env.NODE_ENV === 'production';

  if (!speech || !telephony) {
    const missing = [
      speech ? undefined : 'AZURE_SPEECH_KEY',
      telephony ? undefined : 'TELNYX_API_KEY',
    ].filter(Boolean);

    if (voiceRequired) {
      throw new Error(
        `The voice channel cannot start: ${missing.join(' and ')} missing. ` +
          'Frontly is a phone line, so booting without one would serve a healthy ' +
          '/health on a service that cannot answer a call. Set it, or run with ' +
          'NODE_ENV other than production.',
      );
    }

    app.log.warn({ missing }, 'voice channel disabled');
  } else {
    const cache = new SpeechCache(speech);

    /**
     * Warm in the background, but hand the promise to the routes.
     *
     * Awaiting it here would hold the health check behind a handful of Azure
     * round trips and Render would call that a failed deploy. Handing it over
     * lets an inbound call wait for the thing it actually needs, without the
     * whole service waiting for it.
     */
    const speechReady =
      options.warmSpeechCache === false
        ? Promise.resolve()
        : warmAllBusinesses(cache, db)
            .then((result) => {
              app.log.info(result, 'speech cache warmed');
              return result;
            })
            .catch((error: unknown) => {
              app.log.warn(
                { err: error instanceof Error ? error.message : error },
                'speech cache warming failed — greetings will synthesize on demand',
              );
            });

    await app.register(voiceRoutes, {
      db,
      env,
      telephony,
      speech,
      cache,
      speechReady,
      /**
       * Never awaited, and never allowed to reach the caller: a failed text
       * must not turn a successful booking into a failed turn. The hourly
       * sweep retries anything that did not go out.
       */
      ...(sms
        ? {
            onBooked: (appointmentId: string) => {
              void confirmNow({ db, sms, logger: app.log }, appointmentId).catch(
                (error: unknown) => {
                  app.log.error(
                    { appointmentId, err: error instanceof Error ? error.message : error },
                    'confirmation SMS failed',
                  );
                },
              );
            },
          }
        : {}),
    });
    voiceChannel = { carrier: telephony.name, prefix: telephony.routePrefix };

    /**
     * Verify the effect, not the intent.
     *
     * `register` resolving proves a plugin ran, not that its routes reached
     * the tree that is about to serve traffic — a route added to the wrong
     * instance, or a plugin whose error was swallowed, both look identical
     * from here. onReady fires once the route tree is final, so asking it
     * directly is the only check that cannot be fooled.
     */
    app.addHook('onReady', async () => {
      const expected = [
        { method: 'POST' as const, url: `${telephony.routePrefix}/voice` },
        { method: 'GET' as const, url: `${telephony.routePrefix}/stream` },
      ];
      const missingRoutes = expected.filter((route) => !app.hasRoute(route));
      if (missingRoutes.length > 0) {
        throw new Error(
          'The voice channel registered but its routes are not in the served route ' +
            `tree: ${missingRoutes.map((r) => `${r.method} ${r.url}`).join(', ')}. ` +
            'Refusing to start rather than answer /health on a line that cannot ring.',
        );
      }
      app.log.info(voiceChannel ?? {}, 'voice channel registered');
    });

    app.addHook('onClose', () => cache.close());
  }

  app.get('/', async () => ({
    service: 'frontly-api',
    version: API_VERSION,
    docs: 'https://github.com/0kuculov/frontly',
  }));

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${request.url}` });
  });

  return { app, db };
}
