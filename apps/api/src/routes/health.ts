import type { FastifyPluginAsync } from 'fastify';
import { pingDb, type Database } from '@frontly/core';

export interface HealthOptions {
  db: Database;
  version: string;
  /**
   * The mounted voice channel, or undefined if there isn't one.
   *
   * A function rather than a value because the channel mounts after this
   * plugin registers, and a snapshot taken here would always read undefined.
   */
  voice?: () => { carrier: string; prefix: string } | undefined;
}

/**
 * GET /health — the endpoint Render polls and the one you curl at 3am.
 *
 * It reports 503 when the database is unreachable rather than a cheerful 200,
 * because a Frontly instance that cannot read working hours cannot answer a
 * call, and Render should take it out of rotation.
 *
 * It reports the voice channel for the same reason. A deploy once came up
 * green with no voice route at all, and the only way to find out was to curl
 * the webhook by hand — so the thing the service exists to do is now part of
 * the answer.
 */
export const healthRoutes: FastifyPluginAsync<HealthOptions> = async (app, opts) => {
  const startedAt = Date.now();

  app.get('/health', async (_request, reply) => {
    const voice = opts.voice?.();
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
        voice: voice
          ? { status: 'ok' as const, carrier: voice.carrier, webhook: `${voice.prefix}/voice` }
          : { status: 'disabled' as const },
      },
      timestamp: new Date().toISOString(),
    };

    return reply.code(dbStatus === 'ok' ? 200 : 503).send(body);
  });

  /** Liveness only: is the process up? Never touches the database. */
  app.get('/health/live', async () => ({ status: 'ok' as const }));
};
