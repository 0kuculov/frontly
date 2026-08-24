import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import sensible from '@fastify/sensible';
import websocket from '@fastify/websocket';
import { createDb, enableForeignKeys, type Database } from '@frontly/core';
import type { ServerEnv } from '@frontly/shared';
import { healthRoutes } from './routes/health.js';
import { voiceRoutes } from './routes/voice.js';
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
 * Channel adapters (Twilio voice in Phase 3, the chat widget socket in Phase 5)
 * register here as plugins. They may talk to @frontly/core; core never reaches
 * back into this file.
 */
export interface BuildAppOptions {
  /** Injectable so the voice tests can drive a call with fake speech. */
  speechProvider?: ISpeechProvider;
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
    // arrive in X-Forwarded-*. Twilio signature validation (Phase 3) checks the
    // request URL, which has to be the public one.
    trustProxy: true,
  });

  await app.register(sensible);
  // Twilio posts application/x-www-form-urlencoded.
  await app.register(formbody);
  await app.register(websocket);
  await app.register(cors, {
    origin: env.APP_ORIGIN,
    credentials: true,
  });

  await app.register(healthRoutes, { db, version: API_VERSION });

  // The voice channel needs Azure; without a key the rest of the API still
  // boots, which is what keeps a partially-configured deploy usable.
  if (options.speechProvider || env.AZURE_SPEECH_KEY) {
    await app.register(voiceRoutes, {
      db,
      env,
      ...(options.speechProvider ? { provider: options.speechProvider } : {}),
    });
  } else {
    app.log.warn('AZURE_SPEECH_KEY is not set — the voice channel is disabled');
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
