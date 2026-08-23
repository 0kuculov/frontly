import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type Database, type TestDatabase } from '@frontly/core';
import { serverEnvSchema } from '@frontly/shared';
import { buildApp } from './app.js';

let app: FastifyInstance;
let db: Database;
let testDb: TestDatabase;

beforeAll(async () => {
  // A migrated + seeded throwaway database, then point the server at it.
  testDb = await createTestDb();

  const env = serverEnvSchema.parse({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: testDb.url,
  });

  ({ app, db } = await buildApp(env));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  db?.$client.close();
  testDb?.cleanup();
});

describe('GET /health', () => {
  it('reports ok and confirms the database is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('frontly-api');
    expect(body.checks.database.status).toBe('ok');
    expect(body.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('answers liveness without touching the database', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('degrades to 503 when the database becomes unreachable', async () => {
    // Render must pull an instance that cannot read working hours out of
    // rotation: it cannot answer a call, so a cheerful 200 would be a lie.
    // Dropping the connection underneath a running server is the closest
    // thing to what actually happens when Turso is unavailable.
    const scratch = await createTestDb({ seed: false });
    const env = serverEnvSchema.parse({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: scratch.url,
    });
    const broken = await buildApp(env);
    await broken.app.ready();

    expect((await broken.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);

    broken.db.$client.close();

    const res = await broken.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('degraded');
    expect(res.json().checks.database.status).toBe('error');

    // Liveness still answers — the process itself is fine.
    expect((await broken.app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);

    await broken.app.close();
    scratch.cleanup();
  });
});

describe('routing', () => {
  it('identifies the service at the root', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.json().service).toBe('frontly-api');
  });

  it('returns a structured 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });
});
