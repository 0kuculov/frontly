import {
  appointments,
  businesses,
  conversations,
  createTestDb,
  DEMO_IDS,
  type TestDatabase,
} from '@frontly/core';
import { DEFAULT_VOICE_CONFIG, emptyWorkingHours, serverEnvSchema } from '@frontly/shared';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { callEvents } from '../demo/events.js';
import { registerDemoRoutes, resetRefusal } from './demo.js';
import type { ISpeechProvider, ISpeechToText, ITextToSpeech } from '../voice/types.js';

/**
 * The stage surface, over real HTTP.
 *
 * This is the one screen that cannot be debugged while it is failing — it is
 * on a projector, in front of judges, and there is no second take. So the
 * things worth pinning are the ones that would be invisible until then: the
 * reset touching only the demo clinic, the metrics refusing to invent a
 * latency, and the stream replaying what a dropped connection missed.
 */

const inertSpeech: ISpeechProvider = {
  createSynthesizer: (): ITextToSpeech => ({
    synthesize: async () => Buffer.alloc(160, 0xff),
    close: () => {},
  }),
  createRecognizer: (): ISpeechToText => ({
    ready: Promise.resolve(),
    write: () => {},
    stop: async () => {},
  }),
};

let app: FastifyInstance;
let testDb: TestDatabase;
let baseEnv: ReturnType<typeof serverEnvSchema.parse>;

beforeAll(async () => {
  testDb = await createTestDb({ seed: true });
  baseEnv = serverEnvSchema.parse({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: testDb.url,
  });
  ({ app } = await buildApp(baseEnv, { speechProvider: inertSpeech, warmSpeechCache: false }));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  testDb?.cleanup();
});

describe('the demo screen', () => {
  it('reports zeroed metrics without inventing a latency', async () => {
    const response = await app.inject({ method: 'GET', url: '/demo/metrics' });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    // Null, not 0. On a projector "0.0s" reads as a claim about how fast we
    // are; "—" reads as "nothing measured yet", which is the truth.
    expect(body.avgCallerFacingMs).toBeNull();
    expect(body.resolvedWithoutOwnerPct).toBeNull();
    expect(body.estimatedCostPerCallUsd).toBeGreaterThan(0);
  });

  it('averages only latencies that were actually measured', async () => {
    await testDb.db.insert(conversations).values({
      id: 'conv_demo_metrics',
      businessId: DEMO_IDS.business,
      channel: 'voice',
      externalId: 'CA_metrics',
      startedAt: new Date(),
      endedAt: new Date(),
      outcome: 'booked',
      transcript: [
        { role: 'customer', text: 'Добар ден.', atMs: 0 },
        { role: 'agent', text: 'Повелете.', atMs: 900, callerFacingMs: 1400 },
        // No callerFacingMs: a reprompt the caller never spoke into. Counting
        // it as zero would drag the average toward a flattering lie.
        { role: 'agent', text: 'Сè уште сте тука?', atMs: 9000 },
        { role: 'agent', text: 'Готово.', atMs: 12_000, callerFacingMs: 1600 },
      ],
    });

    const body = (await app.inject({ method: 'GET', url: '/demo/metrics' })).json();
    expect(body.avgCallerFacingMs).toBe(1500);
    expect(body.callsHandled).toBe(1);
    expect(body.resolvedWithoutOwnerPct).toBe(100);
  });

  it('counts a transfer as NOT resolved without the owner', async () => {
    await testDb.db.insert(conversations).values({
      id: 'conv_demo_transfer',
      businessId: DEMO_IDS.business,
      channel: 'voice',
      externalId: 'CA_transfer',
      startedAt: new Date(),
      endedAt: new Date(),
      outcome: 'transferred',
      transcript: [],
    });

    const body = (await app.inject({ method: 'GET', url: '/demo/metrics' })).json();
    // Needing a human is the precise failure this number measures.
    expect(body.resolvedWithoutOwnerPct).toBe(50);
  });

  it('resets the demo clinic and leaves every other business alone', async () => {
    // A real second business, because the foreign key is real: the point of
    // this test is that a reset cannot reach a paying customer's calendar.
    await testDb.db.insert(businesses).values({
      id: 'biz_someone_else',
      name: 'Друга ординација',
      slug: 'druga-ordinacija',
      workingHours: { ...emptyWorkingHours(), mon: [{ start: '09:00', end: '17:00' }] },
      greetingTemplate: 'Добар ден.',
      voiceConfig: DEFAULT_VOICE_CONFIG,
    });
    await testDb.db.insert(conversations).values({
      id: 'conv_other_business',
      businessId: 'biz_someone_else',
      channel: 'voice',
      externalId: 'CA_other',
      startedAt: new Date(),
      transcript: [],
    });

    const response = await app.inject({ method: 'POST', url: '/demo/reset' });
    expect(response.statusCode).toBe(200);

    const left = await testDb.db.select().from(conversations);
    // The demo clinic is clean; the other row is untouched. A reset that could
    // reach beyond the seeded business is one keystroke from a real calendar.
    expect(left.map((row) => row.businessId)).toEqual(['biz_someone_else']);

    // Re-seeded, not merely emptied: the clinic must still answer afterwards.
    const services = (await app.inject({ method: 'GET', url: '/demo/metrics' })).json();
    expect(services.callsHandled).toBe(0);
    expect(await testDb.db.select().from(appointments)).toHaveLength(0);
  });
});

describe('the reset guard', () => {
  /**
   * The failure this exists to prevent: a laptop running `pnpm dev` with the
   * owner's .env, which points DATABASE_URL at the same Turso database Render
   * serves. The reset button on localhost:3000 then wipes the live clinic —
   * its call history, its bookings and every number on the stage screen — and
   * nothing about the screen suggests it is talking to production.
   */
  const remote = 'libsql://frontly-0kuculov.aws-eu-west-1.turso.io';
  const local = 'file:./frontly.db';

  it('refuses to reset a remote database from a dev server', () => {
    const refusal = resetRefusal(
      { NODE_ENV: 'development', DATABASE_URL: remote, DEMO_RESET_TOKEN: undefined },
      undefined,
    );
    expect(refusal?.code).toBe(403);
    // The message has to name the database, because the whole problem is not
    // knowing which one you are pointed at.
    expect(refusal?.message).toContain('libsql://');
  });

  it('lets a dev server reset its own file database', () => {
    expect(
      resetRefusal(
        { NODE_ENV: 'development', DATABASE_URL: local, DEMO_RESET_TOKEN: undefined },
        undefined,
      ),
    ).toBeUndefined();
  });

  it('requires the token in production', () => {
    const env = { NODE_ENV: 'production' as const, DATABASE_URL: remote, DEMO_RESET_TOKEN: 's3cret' };
    // Unauthenticated is how it shipped: POST /demo/reset from anywhere on the
    // internet emptied the clinic mid-pitch.
    expect(resetRefusal(env, undefined)?.code).toBe(401);
    expect(resetRefusal(env, 'wrong')?.code).toBe(401);
    // A wrong token of a different length must not be distinguishable by how
    // long the comparison took.
    expect(resetRefusal(env, 'a')?.code).toBe(401);
    expect(resetRefusal(env, 's3cret')).toBeUndefined();
  });

  /**
   * The rules above are a pure function; this is the wiring.
   *
   * Worth its own test because the two failure modes are not the same: a
   * correct rule that the route forgets to consult deletes the live clinic
   * just as thoroughly as no rule at all, and every unit test above would
   * still be green. The database here is the local test file — the point is
   * to prove the DELETE never runs, so it has to be a database we can check.
   */
  it('refuses over HTTP without touching the tables', async () => {
    const guarded = Fastify({ logger: false });
    await guarded.register(registerDemoRoutes, {
      db: testDb.db,
      env: { ...baseEnv, NODE_ENV: 'development', DATABASE_URL: remote },
    });

    await testDb.db.insert(conversations).values({
      id: 'conv_must_survive',
      businessId: DEMO_IDS.business,
      channel: 'voice',
      externalId: 'CA_survivor',
      startedAt: new Date(),
      transcript: [],
    });

    const response = await guarded.inject({ method: 'POST', url: '/demo/reset' });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('reset_refused');

    // The row is still there: the guard returned before the delete, rather
    // than deleting and then reporting a refusal.
    const left = await testDb.db.select().from(conversations);
    expect(left.map((row) => row.id)).toContain('conv_must_survive');

    await guarded.close();
    await testDb.db.delete(conversations).where(eq(conversations.id, 'conv_must_survive'));
  });

  it('fails closed when production has no token configured', () => {
    // Render generates this value, so an absent one means something is wrong
    // with the deploy — and an open wipe endpoint is the worse of the two
    // failures to ship.
    const refusal = resetRefusal(
      { NODE_ENV: 'production', DATABASE_URL: remote, DEMO_RESET_TOKEN: undefined },
      undefined,
    );
    expect(refusal?.code).toBe(503);
  });
});

describe('the event bus', () => {
  it('replays what a dropped connection missed', () => {
    const bus = callEvents;
    const before = bus.lastId;
    bus.publish({ type: 'call.started', callRef: 'CA_replay', at: Date.now() });
    bus.publish({
      type: 'said',
      callRef: 'CA_replay',
      role: 'customer',
      text: 'Добар ден.',
      at: Date.now(),
    });

    // A projector that lost the venue wifi reconnects with Last-Event-ID and
    // must come back to the conversation, not to a blank screen.
    const missed = bus.since(before);
    expect(missed.map((row) => row.event.type)).toEqual(['call.started', 'said']);
  });

  it('does not let one broken screen affect the call', () => {
    const bus = callEvents;
    const seen: string[] = [];
    const stopBad = bus.subscribe(() => {
      throw new Error('this screen is on fire');
    });
    const stopGood = bus.subscribe((event) => seen.push(event.type));

    expect(() =>
      bus.publish({ type: 'call.ended', callRef: 'CA_x', endedBy: 'caller', outcome: 'booked', durationMs: 1, at: Date.now() }),
    ).not.toThrow();
    expect(seen).toEqual(['call.ended']);

    stopBad();
    stopGood();
  });
});

describe('the event stream over a real socket', () => {
  /**
   * app.inject() cannot see this bug. The handler writes its headers straight
   * to the raw socket, and the thing that was missing — the CORS headers
   * @fastify/cors staged on the Fastify reply — only matters to a browser on
   * another origin. So this one test needs a real listener and a real fetch.
   */
  it('sends CORS headers on the stream, not only on /demo/metrics', async () => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();

    const response = await fetch(`${address}/demo/stream`, {
      headers: { Origin: 'http://localhost:3000' },
      signal: controller.signal,
    });

    try {
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      /**
       * Without this the stage screen loads its numbers and then silently
       * never opens EventSource: metrics work, the transcript stays blank,
       * and the only evidence is in the browser console of the laptop
       * driving the projector.
       */
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    } finally {
      controller.abort();
    }
  });
});
