import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { appointments, businesses, conversations, services, staff } from './schema.js';
import { DEMO_IDS, seedDemoBusiness } from './seed.js';
import { createTestDb, type TestDatabase } from './testing.js';

/**
 * Runs the real migrations against a throwaway SQLite file. If these pass, the
 * SQL that ships to Turso is the SQL that was tested.
 */

let db: Database;
let testDb: TestDatabase;

/**
 * Drizzle wraps driver errors in a DrizzleQueryError whose message is the SQL,
 * not the reason. The actual "UNIQUE constraint failed" text lives on `cause`,
 * so assertions have to walk the chain or they silently pass on any failure.
 */
function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(' | ');
}

async function failureText(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return errorChainText(error);
  }
  throw new Error('expected the query to be rejected, but it succeeded');
}

const startOfNextTenThirty = (): Date => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  d.setUTCHours(8, 30, 0, 0);
  return d;
};

beforeAll(async () => {
  testDb = await createTestDb();
  db = testDb.db;
});

afterAll(() => {
  testDb?.cleanup();
});

describe('demo seed', () => {
  it('creates the Ohrid dental clinic with 3 services and 2 staff', async () => {
    const [business] = await db.select().from(businesses).where(eq(businesses.id, DEMO_IDS.business));
    expect(business?.name).toBe('Дентал Охрид');
    expect(business?.timezone).toBe('Europe/Skopje');

    const svc = await db.select().from(services).where(eq(services.businessId, DEMO_IDS.business));
    const stf = await db.select().from(staff).where(eq(staff.businessId, DEMO_IDS.business));
    expect(svc).toHaveLength(3);
    expect(stf).toHaveLength(2);
  });

  it('round-trips JSON columns as objects, not strings', async () => {
    const [business] = await db.select().from(businesses).where(eq(businesses.id, DEMO_IDS.business));

    // languages[] survives as an array
    expect(business?.languages).toEqual(['mk', 'sq', 'en']);

    // working_hours is Mon-Fri 09:00-17:00, Sat 09:00-13:00, closed Sunday
    expect(business?.workingHours.mon).toEqual([{ start: '09:00', end: '17:00' }]);
    expect(business?.workingHours.sat).toEqual([{ start: '09:00', end: '13:00' }]);
    expect(business?.workingHours.sun).toEqual([]);
  });

  it('applies the tested Macedonian voice defaults', async () => {
    const [business] = await db.select().from(businesses).where(eq(businesses.id, DEMO_IDS.business));
    expect(business?.voiceConfig.mk).toMatchObject({
      voiceName: 'mk-MK-AleksandarNeural',
      rate: '-6%',
      greetingBreakMs: 300,
    });
  });

  it('is idempotent — re-seeding does not duplicate rows', async () => {
    await seedDemoBusiness(db);
    const svc = await db.select().from(services).where(eq(services.businessId, DEMO_IDS.business));
    expect(svc).toHaveLength(3);
  });

  it('gives Dr Stefan an afternoon-only shift and Dr Ana the clinic default', async () => {
    const [ana] = await db.select().from(staff).where(eq(staff.id, DEMO_IDS.staff.ana));
    const [stefan] = await db.select().from(staff).where(eq(staff.id, DEMO_IDS.staff.stefan));

    expect(ana?.workingHours).toBeNull(); // inherits the business
    expect(stefan?.workingHours?.mon).toEqual([{ start: '12:00', end: '17:00' }]);
    expect(stefan?.workingHours?.sat).toEqual([]);
  });
});

describe('double-booking guard', () => {
  const slot = startOfNextTenThirty();

  const booking = (overrides: Partial<typeof appointments.$inferInsert> = {}) => ({
    businessId: DEMO_IDS.business,
    serviceId: DEMO_IDS.services.checkup,
    staffId: DEMO_IDS.staff.ana,
    customerName: 'Марко Петровски',
    customerPhone: '+38970111222',
    startsAt: slot,
    endsAt: new Date(slot.getTime() + 30 * 60_000),
    channel: 'voice' as const,
    ...overrides,
  });

  it('accepts the first booking for a staff member at a given time', async () => {
    await expect(db.insert(appointments).values(booking()).returning()).resolves.toHaveLength(1);
  });

  it('rejects a second booking for the same staff member at the same time', async () => {
    // This is the constraint Phase 2 relies on: two callers racing for 10:30
    // must not both win. SQLite refuses the second INSERT outright.
    const message = await failureText(() =>
      db.insert(appointments).values(booking({ customerName: 'Ана Јованова' })),
    );
    expect(message).toMatch(/UNIQUE constraint failed/i);
    expect(message).toMatch(/appointments\.staff_id, appointments\.starts_at/);
  });

  it('allows a different staff member at the same time', async () => {
    await expect(
      db.insert(appointments).values(booking({ staffId: DEMO_IDS.staff.stefan })).returning(),
    ).resolves.toHaveLength(1);
  });

  it('frees the slot again once the appointment is cancelled', async () => {
    // A plain UNIQUE(staff_id, starts_at) would keep the slot hostage forever.
    // The partial index only covers live rows, so a cancellation releases it.
    await db
      .update(appointments)
      .set({ status: 'cancelled' })
      .where(and(eq(appointments.staffId, DEMO_IDS.staff.ana), eq(appointments.startsAt, slot)));

    await expect(
      db.insert(appointments).values(booking({ customerName: 'Елена Стојанова' })).returning(),
    ).resolves.toHaveLength(1);
  });
});

describe('one conversations table for every channel', () => {
  it('stores voice and chat side by side, told apart only by `channel`', async () => {
    await db.insert(conversations).values([
      {
        businessId: DEMO_IDS.business,
        channel: 'voice',
        externalId: 'CA_test_call_1',
        fromIdentifier: '+38970333444',
        languageDetected: 'mk',
        outcome: 'booked',
        transcript: [
          { role: 'agent', text: 'Добар ден, се јавивте во Дентал Охрид.', atMs: 0 },
          { role: 'customer', text: 'Сакам да закажам преглед.', atMs: 2400, confidence: 0.94 },
        ],
      },
      {
        businessId: DEMO_IDS.business,
        channel: 'chat',
        externalId: 'sess_test_chat_1',
        fromIdentifier: 'anon_9f2',
        languageDetected: 'sq',
        outcome: 'info',
        transcript: [{ role: 'customer', text: 'Sa kushton kontrolli?', atMs: 0 }],
      },
    ]);

    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.businessId, DEMO_IDS.business));

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.channel))).toEqual(new Set(['voice', 'chat']));

    const voice = rows.find((r) => r.channel === 'voice');
    expect(voice?.transcript[1]).toMatchObject({ role: 'customer', confidence: 0.94 });
  });

  it('keeps one row per call, so a Twilio retry cannot duplicate it', async () => {
    const message = await failureText(() =>
      db.insert(conversations).values({
        businessId: DEMO_IDS.business,
        channel: 'voice',
        externalId: 'CA_test_call_1',
      }),
    );
    expect(message).toMatch(/UNIQUE constraint failed/i);
  });
});
