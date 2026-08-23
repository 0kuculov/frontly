import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { createDb, enableForeignKeys, type Database } from '@frontly/core';
import type { ServerEnv } from '@frontly/shared';
import { healthRoutes } from './routes/health.js';

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
export async function buildApp(env: ServerEnv): Promise<BuildAppResult> {
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
  await app.register(cors, {
    origin: env.APP_ORIGIN,
    credentials: true,
  });

  await app.register(healthRoutes, { db, version: API_VERSION });

  app.get('/', async () => ({
    service: 'frontly-api',
    version: API_VERSION,
    docs: 'https://github.com/frontly/frontly',
  }));

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${request.url}` });
  });

  return { app, db };
}
