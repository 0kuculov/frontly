import {
  appointments,
  businesses,
  conversations,
  createTestDb,
  DEMO_IDS,
  type TestDatabase,
} from '@frontly/core';
import { DEFAULT_VOICE_CONFIG, emptyWorkingHours, serverEnvSchema } from '@frontly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { callEvents } from '../demo/events.js';
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

beforeAll(async () => {
  testDb = await createTestDb({ seed: true });
  const env = serverEnvSchema.parse({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: testDb.url,
  });
  ({ app } = await buildApp(env, { speechProvider: inertSpeech, warmSpeechCache: false }));
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
