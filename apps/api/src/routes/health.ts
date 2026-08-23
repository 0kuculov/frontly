import type { FastifyPluginAsync } from 'fastify';
import { pingDb, type Database } from '@frontly/core';

export interface HealthOptions {
  db: Database;
  version: string;
}

/**
 * GET /health — the endpoint Render polls and the one you curl at 3am.
 *
 * It reports 503 when the database is unreachable rather than a cheerful 200,
 * because a Frontly instance that cannot read working hours cannot answer a
 * call, and Render should take it out of rotation.
 */
export const healthRoutes: FastifyPluginAsync<HealthOptions> = async (app, opts) => {
  const startedAt = Date.now();

  app.get('/health', async (_request, reply) => {
    const dbStartedAt = Date.now();
    let dbStatus: 'ok' | 'error' = 'ok';
    let dbError: string | undefined;

    try {
      await pingDb(opts.db);
    } catch (error) {
      dbStatus = 'error';
      dbError = error instanceof Error ? error.message : String(error);
      app.log.error({ err: error }, 'health check: database unreachable');
    }

    const body = {
      status: dbStatus === 'ok' ? ('ok' as const) : ('degraded' as const),
      service: 'frontly-api',
      version: opts.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checks: {
        database: {
          status: dbStatus,
          latencyMs: Date.now() - dbStartedAt,
          ...(dbError ? { error: dbError } : {}),
        },
      },
      timestamp: new Date().toISOString(),
    };

    return reply.code(dbStatus === 'ok' ? 200 : 503).send(body);
  });

  /** Liveness only: is the process up? Never touches the database. */
  app.get('/health/live', async () => ({ status: 'ok' as const }));
};
