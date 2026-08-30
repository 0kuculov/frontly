import {
  businesses,
  conversations,
  createTestDb,
  createUser,
  DEMO_IDS,
  type TestDatabase,
} from '@frontly/core';
import { DEFAULT_VOICE_CONFIG, emptyWorkingHours, serverEnvSchema } from '@frontly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { issueSession, readSession } from '../auth/session.js';
import type { ISpeechProvider, ISpeechToText, ITextToSpeech } from '../voice/types.js';

/**
 * The dashboard API.
 *
 * The thing worth testing hardest is not the shape of the JSON — it is that a
 * login is welded to ONE business. Every query filters on the session's
 * businessId, and a single forgotten filter would serve one clinic another
 * clinic's patients, which is the failure this product cannot survive.
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

const SECRET = 'a'.repeat(64);
const PASSWORD = 'a-long-enough-password';

let app: FastifyInstance;
let testDb: TestDatabase;
let ownToken: string;
let otherToken: string;

beforeAll(async () => {
  testDb = await createTestDb({ seed: true });

  // A second, real clinic — the tenancy tests are meaningless without one.
  await testDb.db.insert(businesses).values({
    id: 'biz_other_clinic',
    name: 'Друга ординација',
    slug: 'druga',
    workingHours: { ...emptyWorkingHours(), mon: [{ start: '09:00', end: '17:00' }] },
    greetingTemplate: 'Добар ден.',
    voiceConfig: DEFAULT_VOICE_CONFIG,
  });

  await createUser(testDb.db, {
    businessId: DEMO_IDS.business,
    email: 'Ana@Dental.mk',
    password: PASSWORD,
  });
  await createUser(testDb.db, {
    businessId: 'biz_other_clinic',
    email: 'other@druga.mk',
    password: PASSWORD,
  });

  const env = serverEnvSchema.parse({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: testDb.url,
    AUTH_SECRET: SECRET,
  });
  ({ app } = await buildApp(env, { speechProvider: inertSpeech, warmSpeechCache: false }));
  await app.ready();

  ownToken = issueSession({ userId: 'u1', businessId: DEMO_IDS.business }, SECRET);
  otherToken = issueSession({ userId: 'u2', businessId: 'biz_other_clinic' }, SECRET);
});

afterAll(async () => {
  await app?.close();
  testDb?.cleanup();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('signing in', () => {
  it('accepts the right password and ignores the case of the email', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/dashboard/login',
      payload: { email: 'ANA@dental.MK', password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // The session is welded to a business at issue time, not chosen per request.
    expect(readSession(body.token, SECRET)?.businessId).toBe(DEMO_IDS.business);
    expect(body.business.name).toBe('Дентал Охрид');
  });

  it('says the same thing for a wrong password and an unknown account', async () => {
    const wrong = await app.inject({
      method: 'POST',
      url: '/dashboard/login',
      payload: { email: 'ana@dental.mk', password: 'not-the-password' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/dashboard/login',
      payload: { email: 'nobody@nowhere.mk', password: PASSWORD },
    });

    // Distinguishing them turns the login form into a way to find out who has
    // an account.
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });
});

describe('the session token', () => {
  it('refuses a tampered payload', () => {
    const token = issueSession({ userId: 'u1', businessId: DEMO_IDS.business }, SECRET);
    const [payload, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ userId: 'u1', businessId: 'biz_other_clinic', exp: 9_999_999_999 }),
    ).toString('base64url');

    // Swapping the business in the payload is exactly the attack this signs
    // against: the signature no longer matches, so the token is simply not one.
    expect(readSession(`${forged}.${signature}`, SECRET)).toBeUndefined();
    expect(readSession(`${payload}.${signature}`, SECRET)?.businessId).toBe(DEMO_IDS.business);
  });

  it('refuses an expired token and one signed with another secret', () => {
    const expired = issueSession({ userId: 'u1', businessId: 'b' }, SECRET, { ttlSeconds: -1 });
    expect(readSession(expired, SECRET)).toBeUndefined();

    const foreign = issueSession({ userId: 'u1', businessId: 'b' }, 'a different secret entirely');
    expect(readSession(foreign, SECRET)).toBeUndefined();
  });
});

describe('every route needs a session', () => {
  const routes = [
    '/dashboard/today',
    '/dashboard/conversations',
    '/dashboard/calendar',
    '/dashboard/settings',
  ];

  for (const url of routes) {
    it(`refuses ${url} without a token`, async () => {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    });
  }

  it('refuses a token that is merely well-formed', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/today',
      headers: auth('not.a.real.token'),
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('one login sees exactly one clinic', () => {
  it('does not return another clinic conversation, even by its own id', async () => {
    await testDb.db.insert(conversations).values({
      id: 'conv_belongs_to_other',
      businessId: 'biz_other_clinic',
      channel: 'voice',
      externalId: 'CA_other',
      startedAt: new Date(),
      transcript: [],
    });

    /**
     * The id is real and the token is valid — the ONLY thing standing between
     * them is the businessId filter in the query. If that is ever dropped this
     * returns 200 and one clinic reads another's transcript.
     */
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/conversations/conv_belongs_to_other',
      headers: auth(ownToken),
    });
    expect(response.statusCode).toBe(404);

    // And the clinic it does belong to can read it.
    const owner = await app.inject({
      method: 'GET',
      url: '/dashboard/conversations/conv_belongs_to_other',
      headers: auth(otherToken),
    });
    expect(owner.statusCode).toBe(200);
  });

  it('keeps the lists apart', async () => {
    const mine = (
      await app.inject({ method: 'GET', url: '/dashboard/conversations', headers: auth(ownToken) })
    ).json();
    const theirs = (
      await app.inject({ method: 'GET', url: '/dashboard/conversations', headers: auth(otherToken) })
    ).json();

    expect(mine.conversations.map((c: { id: string }) => c.id)).not.toContain(
      'conv_belongs_to_other',
    );
    expect(theirs.conversations.map((c: { id: string }) => c.id)).toContain(
      'conv_belongs_to_other',
    );
  });

  it('serves settings for the session business, not a requested one', async () => {
    const body = (
      await app.inject({ method: 'GET', url: '/dashboard/settings', headers: auth(otherToken) })
    ).json();
    // No id is accepted from the caller anywhere — the session decides.
    expect(body.business.id).toBe('biz_other_clinic');
  });
});

describe('today', () => {
  it('counts the clinic day in the clinic timezone', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/today',
      headers: auth(ownToken),
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    const start = new Date(body.day.startsAt);
    /**
     * Midnight in Europe/Skopje, which is 22:00 or 23:00 UTC the day before —
     * never 00:00 UTC. A server-local day would roll over while the clinic is
     * still seeing patients.
     */
    expect(start.getUTCHours()).toBeGreaterThanOrEqual(21);
    expect(body.business.timezone).toBe('Europe/Skopje');
  });
});

describe('changing settings', () => {
  it('updates the greeting and clears the owner mobile', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/dashboard/settings',
      headers: auth(ownToken),
      payload: { greetingTemplate: 'Добро утро, {{business_name}}.', ownerMobile: '' },
    });
    expect(response.statusCode).toBe(200);

    const after = (
      await app.inject({ method: 'GET', url: '/dashboard/settings', headers: auth(ownToken) })
    ).json();
    expect(after.business.greetingTemplate).toContain('Добро утро');
    // Cleared on purpose: with no route a transfer says so rather than dialling.
    expect(after.business.ownerMobile).toBeNull();
  });

  it('refuses working hours that are not working hours', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/dashboard/settings',
      headers: auth(ownToken),
      payload: { workingHours: { mon: 'all day' } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('will not let the dashboard set the inbound number', async () => {
    // The carrier owns that value. A typo here silently unroutes every call.
    const response = await app.inject({
      method: 'PATCH',
      url: '/dashboard/settings',
      headers: auth(ownToken),
      payload: { inboundNumber: '+38900000000' },
    });
    expect(response.statusCode).toBe(400);
  });
});


describe('booking by hand', () => {
  /** The next Tuesday, so the clinic is open and Ana is working. */
  function nextTuesday(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + ((9 - d.getUTCDay()) % 7 || 7));
    return d.toISOString().slice(0, 10);
  }

  async function freeSlots(date: string) {
    const response = await app.inject({
      method: 'GET',
      url: `/dashboard/availability?serviceId=${DEMO_IDS.services.checkup}&date=${date}`,
      headers: auth(ownToken),
    });
    expect(response.statusCode).toBe(200);
    return response.json().slots as { staffId: string; startsAt: string }[];
  }

  it('offers only times availability returned, and books one of them', async () => {
    const date = nextTuesday();
    const slots = await freeSlots(date);
    expect(slots.length).toBeGreaterThan(0);

    const slot = slots[0]!;
    const created = await app.inject({
      method: 'POST',
      url: '/dashboard/appointments',
      headers: auth(ownToken),
      payload: {
        serviceId: DEMO_IDS.services.checkup,
        staffId: slot.staffId,
        startsAt: slot.startsAt,
        customerName: 'Марко Петровски',
        customerPhone: '+38970111222',
      },
    });
    expect(created.statusCode).toBe(201);
    const appointmentId = created.json().appointment.id as string;

    // The slot it just took is no longer on offer. This is the whole point of
    // asking availability rather than letting the form invent a time.
    const after = await freeSlots(date);
    expect(after.map((s) => s.startsAt)).not.toContain(slot.startsAt);

    // Booking the same slot again is refused by the index, not by app logic.
    const clash = await app.inject({
      method: 'POST',
      url: '/dashboard/appointments',
      headers: auth(ownToken),
      payload: {
        serviceId: DEMO_IDS.services.checkup,
        staffId: slot.staffId,
        startsAt: slot.startsAt,
        customerName: 'Некој друг',
        customerPhone: '+38970333444',
      },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toBe('slot_taken');

    // Cancelling frees it again: the unique index is partial on purpose.
    const cancelled = await app.inject({
      method: 'POST',
      url: `/dashboard/appointments/${appointmentId}/cancel`,
      headers: auth(ownToken),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().appointment.status).toBe('cancelled');

    const freed = await freeSlots(date);
    expect(freed.map((s) => s.startsAt)).toContain(slot.startsAt);
  });

  it('refuses a time outside working hours', async () => {
    const date = nextTuesday();
    const response = await app.inject({
      method: 'POST',
      url: '/dashboard/appointments',
      headers: auth(ownToken),
      payload: {
        serviceId: DEMO_IDS.services.checkup,
        staffId: DEMO_IDS.staff.ana,
        // 03:00 UTC is 05:00 in Skopje, hours before the clinic opens.
        startsAt: `${date}T03:00:00.000Z`,
        customerName: 'Марко',
        customerPhone: '+38970111222',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('outside_working_hours');
  });

  it('will not cancel another clinic appointment, even with its real id', async () => {
    const date = nextTuesday();
    const slots = await freeSlots(date);
    const slot = slots[0]!;

    const created = await app.inject({
      method: 'POST',
      url: '/dashboard/appointments',
      headers: auth(ownToken),
      payload: {
        serviceId: DEMO_IDS.services.checkup,
        staffId: slot.staffId,
        startsAt: slot.startsAt,
        customerName: 'Марко Петровски',
        customerPhone: '+38970111222',
      },
    });
    expect(created.statusCode).toBe(201);
    const appointmentId = created.json().appointment.id as string;

    /**
     * The other clinic knows the id and asks anyway. 404, not 403: whether
     * that id exists is itself the other clinic's business.
     */
    const stolen = await app.inject({
      method: 'POST',
      url: `/dashboard/appointments/${appointmentId}/cancel`,
      headers: auth(otherToken),
    });
    expect(stolen.statusCode).toBe(404);

    // And it is genuinely still booked.
    const mine = await app.inject({
      method: 'POST',
      url: `/dashboard/appointments/${appointmentId}/cancel`,
      headers: auth(ownToken),
    });
    expect(mine.statusCode).toBe(200);
  });
});
