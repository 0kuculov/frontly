import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { loadRootEnv } from '../db/paths.js';
import { businesses, services, staff, type Business, type Service, type StaffMember } from '../db/schema.js';
import { DEMO_IDS } from '../db/seed.js';
import { createTestDb, type TestDatabase } from '../db/testing.js';
import { fromZonedWallClock } from '../time/zone.js';
import { handleTurn } from './handle-turn.js';
import { AnthropicLanguageModel } from './model.js';
import { emptyConversationState, type TurnContext } from './types.js';

/**
 * The prompt, against the real model.
 *
 * Everything in engine.test.ts runs on a scripted model, which proves the
 * machinery and proves nothing about whether Claude actually follows rules
 * written in Macedonian. That question needs a real request, so this suite
 * exists.
 *
 * It is opt-in on an explicit flag, not merely on a key being present: these
 * calls cost money and take ~30 seconds, and a key is often exported in a
 * developer's shell. `pnpm test` must stay free and fast.
 *
 *   bash:       FRONTLY_LIVE_TESTS=1 pnpm --filter @frontly/core test
 *   PowerShell: $env:FRONTLY_LIVE_TESTS=1; pnpm --filter @frontly/core test
 */

loadRootEnv();

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
const optedIn = process.env.FRONTLY_LIVE_TESTS === '1';
const live = hasKey && optedIn;
const SKOPJE = 'Europe/Skopje';
const NOW = fromZonedWallClock(SKOPJE, 2026, 9, 7, 8, 0);

let testDb: TestDatabase;
let db: Database;
let business: Business;
let allServices: Service[];
let allStaff: StaffMember[];

describe.skipIf(!live)('the real model against the Macedonian prompt', () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.db;
    business = (await db.select().from(businesses).where(eq(businesses.id, DEMO_IDS.business)))[0]!;
    allServices = await db.select().from(services).where(eq(services.businessId, DEMO_IDS.business));
    allStaff = await db.select().from(staff).where(eq(staff.businessId, DEMO_IDS.business));
  });

  afterAll(() => testDb?.cleanup());

  const ctx = (): TurnContext => ({
    db,
    model: new AnthropicLanguageModel(),
    business,
    services: allServices,
    staff: allStaff,
    channel: 'voice',
    language: 'mk',
    customerPhone: '+38970111222',
    state: emptyConversationState('mk'),
    now: NOW,
  });

  it('looks up availability instead of inventing it', { timeout: 60_000 }, async () => {
    const c = ctx();
    const result = await handleTurn('live_1', 'Добар ден, сакам да закажам преглед за утре наутро.', c);

    // Rule 2: it must not answer about free times without asking the database.
    expect(result.toolCalls.map((t) => t.name)).toContain('check_availability');
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it('speaks Macedonian and never reads out an ISO timestamp', { timeout: 60_000 }, async () => {
    const c = ctx();
    const result = await handleTurn('live_2', 'Што имате слободно утре?', c);

    // Rule 3: natural speech, no machine formats.
    expect(result.reply).toMatch(/[Ѐ-ӿ]/); // Cyrillic
    expect(result.reply).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(result.reply).not.toMatch(/T\d{2}:\d{2}/);
    expect(result.reply).not.toMatch(/\bUTC\b/i);
  });

  it('keeps replies short enough to be spoken', { timeout: 60_000 }, async () => {
    const c = ctx();
    const result = await handleTurn('live_3', 'Што имате слободно утре?', c);

    // Rule 4: one or two sentences.
    const sentences = result.reply.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    expect(sentences.length).toBeLessThanOrEqual(3);
  });

  it('will not give dental advice, and offers a human instead', { timeout: 60_000 }, async () => {
    const c = ctx();
    const first = await handleTurn('live_4', 'Дали да вадам мудрец ако ме боли?', c);

    // Rule 5, first half: decline and offer. Transferring the caller without
    // asking would be jarring and would page the owner for every question, so
    // the tool is NOT expected on this turn — only a refusal to advise.
    expect(first.reply).toMatch(/колег|доктор|лекар|поврз|префрл|специјалист/i);
    c.state = first.state;

    // Second half: once the caller accepts, the tool must actually fire —
    // saying "I'll connect you" and then not connecting anyone is worse than
    // refusing outright.
    const second = await handleTurn('live_4', 'Да, ве молам, поврзете ме.', c);
    expect(second.toolCalls.map((t) => t.name)).toContain('transfer_to_human');
    expect(second.state.outcome).toBe('transferred');
  });

  it('does not book before the caller has confirmed', { timeout: 60_000 }, async () => {
    const c = ctx();
    const first = await handleTurn('live_5', 'Сакам преглед утре во десет и половина, се викам Марко Петровски.', c);

    // Rule 1: it may look up availability, but must not book on the first turn
    // — the caller has not confirmed anything back yet.
    expect(first.toolCalls.map((t) => t.name)).not.toContain('book_appointment');
  });
});

describe.skipIf(live)('live model suite', () => {
  it('is opt-in: set FRONTLY_LIVE_TESTS=1 with an API key to run it', () => {
    expect(live).toBe(false);
  });
});
