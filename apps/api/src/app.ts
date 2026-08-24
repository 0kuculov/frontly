import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import websocket from '@fastify/websocket';
import { createDb, enableForeignKeys, type Database } from '@frontly/core';
import type { ServerEnv } from '@frontly/shared';
import { healthRoutes } from './routes/health.js';
import { voiceRoutes } from './routes/voice.js';
import { AzureSpeechProvider } from './voice/azure.js';
import { SpeechCache } from './voice/speech-cache.js';
import { TelnyxProvider } from './voice/telnyx.js';
import { warmAllBusinesses } from './voice/warm.js';
import type { ITelephonyProvider } from './voice/telephony.js';
import type { ISpeechProvider } from './voice/types.js';

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

  await app.register(healthRoutes, { db, version: API_VERSION });

  /**
   * The voice channel needs both a carrier and a speech provider. Missing
   * either disables it and leaves the rest of the API up, which is what keeps
   * a half-configured deploy usable instead of crash-looping.
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

  if (speech && telephony) {
    const cache = new SpeechCache(speech);
    await app.register(voiceRoutes, { db, env, telephony, speech, cache });
    app.log.info(
      { carrier: telephony.name, prefix: telephony.routePrefix },
      'voice channel registered',
    );

    /**
     * Warm in the background.
     *
     * Awaiting it would hold the health check behind a handful of Azure round
     * trips, and Render would call that a failed deploy. A call that lands
     * mid-warm simply synthesizes the greeting the old way.
     */
    if (options.warmSpeechCache !== false) {
      void warmAllBusinesses(cache, db)
        .then((result) => app.log.info(result, 'speech cache warmed'))
        .catch((error: unknown) =>
          app.log.warn(
            { err: error instanceof Error ? error.message : error },
            'speech cache warming failed — greetings will synthesize on demand',
          ),
        );
    }

    app.addHook('onClose', () => cache.close());
  } else {
    const missing = [
      speech ? undefined : 'AZURE_SPEECH_KEY',
      telephony ? undefined : 'TELNYX_API_KEY',
    ].filter(Boolean);
    app.log.warn({ missing }, 'voice channel disabled');
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
