import {
  appointments,
  appointmentsAwaitingConfirmation,
  createTestDb,
  DEMO_IDS,
  type TestDatabase,
} from '@frontly/core';
import { smsSender, undeliverableReason } from '@frontly/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { confirmationText, dailySummaryText, formatWhen, partsFor, reminderText } from './messages.js';
import { sweepConfirmations, sweepReminders, confirmNow } from './follow-up.js';
import { TelnyxSmsProvider, type ISmsProvider, type SmsMessage, type SmsOutcome } from './sms.js';

/**
 * The follow-up channel.
 *
 * Worth pinning carefully because every failure here is silent by nature: a
 * text that never arrives produces no error anyone sees, and the two most
 * likely causes — a US long code aimed at a Macedonian number, and a stamp
 * written before the carrier accepted — both look exactly like success.
 */

class FakeSms implements ISmsProvider {
  public readonly name = 'fake';
  public readonly sent: SmsMessage[] = [];
  constructor(private readonly outcome: (m: SmsMessage) => SmsOutcome | Error = () => ({ status: 'sent', providerId: 'msg_1' })) {}

  async send(message: SmsMessage): Promise<SmsOutcome> {
    const result = this.outcome(message);
    if (result instanceof Error) throw result;
    // `sent` means DELIVERED to the carrier. Recording an undeliverable here
    // would make the fake agree with a bug rather than catch it.
    if (result.status === 'sent') this.sent.push(message);
    return result;
  }
}

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDb({ seed: true });
});

afterAll(() => testDb?.cleanup());

/**
 * The sweeps are global by design — they ask "what does ANY business owe?" —
 * so an appointment left unstamped by one test is picked up by the next one's
 * sweep and quietly inflates its counts. Clearing between tests keeps each
 * one honest about what it caused.
 */
afterEach(async () => {
  await testDb.db.delete(appointments);
});

/**
 * Insert the row directly rather than going through `bookAppointment`.
 *
 * These tests are about what happens AFTER a booking exists. Routing them
 * through the booking rules would couple them to working hours and staff
 * availability, so a test about a reminder window would start failing because
 * a date landed on a Sunday.
 */
let seq = 0;
async function givenAppointment(startsAt: Date, phone: string): Promise<string> {
  const id = `apt_test_${++seq}`;
  await testDb.db.insert(appointments).values({
    id,
    businessId: DEMO_IDS.business,
    serviceId: DEMO_IDS.services.checkup,
    staffId: DEMO_IDS.staff.ana,
    customerName: 'Марко Петровски',
    customerPhone: phone,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    status: 'booked',
    channel: 'voice',
  });
  return id;
}

describe('who a message comes from', () => {
  it('treats digits as a number and anything else as a sender ID', () => {
    expect(smsSender({ TELNYX_SMS_FROM: '+16193497599' })?.alphanumeric).toBe(false);
    expect(smsSender({ TELNYX_SMS_FROM: 'FRONTLY' })?.alphanumeric).toBe(true);
  });

  it('falls back to the voice number so a US handset can be tested against', () => {
    const sender = smsSender({ TELNYX_PHONE_NUMBER: '+16193497599' });
    expect(sender?.from).toBe('+16193497599');
  });

  it('carries the messaging profile id, which alphanumeric sending requires', () => {
    const sender = smsSender({ TELNYX_SMS_FROM: 'FRONTLY', TELNYX_MESSAGING_PROFILE_ID: 'mp_1' });
    expect(sender?.messagingProfileId).toBe('mp_1');
  });
});

describe('what the sender can actually reach', () => {
  const usLongCode = smsSender({ TELNYX_SMS_FROM: '+16193497599' })!;
  const name = smsSender({ TELNYX_SMS_FROM: 'FRONTLY', TELNYX_MESSAGING_PROFILE_ID: 'mp_1' })!;

  it('refuses a US long code aimed at a Macedonian mobile', () => {
    /**
     * The live account reports international_outbound: false for this number.
     * Telnyx ACCEPTS the request and fails delivery later, so without this
     * check the only evidence is a receipt nobody is watching — and the owner
     * simply wonders why no reminders arrived.
     */
    const reason = undeliverableReason(usLongCode, '+38970123456');
    expect(reason).toContain('international');
    expect(reason).toContain('alphanumeric');
  });

  it('allows the same number to a US destination', () => {
    expect(undeliverableReason(usLongCode, '+12125550142')).toBeUndefined();
  });

  it('allows an alphanumeric sender anywhere', () => {
    // This is the configuration that ships once Telnyx enables MK, and the
    // whole point of the switch being a variable.
    expect(undeliverableReason(name, '+38970123456')).toBeUndefined();
  });
});

describe('what the messages say', () => {
  const appointment = {
    id: 'apt_1',
    businessId: DEMO_IDS.business,
    businessName: 'Дентал Охрид',
    customerName: 'Марко Петровски',
    customerPhone: '+38970123456',
    serviceName: 'Стоматолошки преглед',
    staffName: 'Д-р Ана Смилевска',
    startsAt: new Date('2026-09-03T08:30:00.000Z'),
    timezone: 'Europe/Skopje',
    languages: ['mk'],
  };

  it('writes the date with numerals, unlike anything spoken', () => {
    /**
     * The speech sanitiser spells numerals out because Azure reads "26" as
     * "дваесет и шест". An SMS is read with the eyes, where the numeral is
     * shorter and clearer — and shortness is billable here.
     */
    expect(formatWhen(appointment.startsAt, 'Europe/Skopje', 'mk')).toBe('четврток 03.09 во 10:30');
  });

  it('names the clinic, the time and the doctor', () => {
    const text = confirmationText(appointment, 'mk');
    expect(text).toContain('Дентал Охрид');
    expect(text).toContain('03.09 во 10:30');
    expect(text).toContain('Ана');
  });

  it('keeps a Macedonian reminder inside one UCS-2 part', () => {
    /**
     * Cyrillic is not in GSM-7, so a Macedonian SMS is UCS-2 at 70 characters
     * per part — less than half the Latin allowance. A template that reads
     * fine in English silently costs double here, and this caught exactly
     * that: with the doctor's name the reminder was 71 characters, one over,
     * and billed as two messages. The name lives in the confirmation instead.
     */
    const cost = partsFor(reminderText(appointment, 'mk'));
    expect(cost.encoding).toBe('UCS-2');
    expect(cost.parts).toBe(1);
    expect(reminderText(appointment, 'mk')).not.toContain('Ана');
  });

  it('counts a plain English message as GSM-7', () => {
    expect(partsFor('Reminder: your appointment is tomorrow at 10:30.').encoding).toBe('GSM-7');
  });

  /**
   * The confirmation used to cost two parts in BOTH languages the product is
   * for — 79 characters in Macedonian, 118 in Albanian — while English, the
   * one language nobody here speaks, was the only one that fit.
   *
   * Albanian is the trap worth a test of its own: `ë` and lowercase `ç` are
   * not in GSM-7, so Albanian is UCS-2 at 70 characters exactly like Cyrillic,
   * and the Albanian template was the longest of the three.
   */
  it.each(['mk', 'sq', 'en'] as const)('keeps the %s confirmation inside one part', (language) => {
    const local =
      language === 'mk'
        ? appointment
        : { ...appointment, businessName: 'Dental Ohrid', staffName: 'Dr. Ana Smilevska' };
    expect(partsFor(confirmationText(local, language)).parts).toBe(1);
  });

  it('gives up the staff name, then the weekday, rather than a second part', () => {
    /**
     * Composed to fit rather than written and hoped for. Tuning the wording to
     * the length of "Дентал Охрид" would work for the demo clinic and break
     * for the first customer with a longer name, so the message degrades in a
     * defined order instead.
     */
    const long = {
      ...appointment,
      businessName: 'Приватна здравствена установа Дентал Охрид',
    };
    const text = confirmationText(long, 'mk');

    expect(partsFor(text).parts).toBe(1);
    expect(text).toContain('03.09 во 10:30');
    expect(text).not.toContain('Ана'); // staff went first
    expect(text).not.toContain('четврток'); // then the weekday
  });

  it('caps the owner summary rather than sending a six-part report', () => {
    const tomorrow = Array.from({ length: 9 }, (_, i) => ({
      startsAt: new Date(`2026-09-04T0${i}:00:00.000Z`),
      customerName: `Пациент ${i}`,
      serviceName: 'Преглед',
      staffName: 'Ана',
    }));
    const text = dailySummaryText(
      {
        businessId: DEMO_IDS.business,
        businessName: 'Дентал Охрид',
        ownerMobile: '+38970000000',
        timezone: 'Europe/Skopje',
        languages: ['mk'],
        conversations: 12,
        booked: 5,
        transferred: 1,
        tomorrow,
      },
      'mk',
    );
    expect(text).toContain('12 повици');
    // The glance, not the report. The dashboard is where the full day lives.
    expect(text).toContain('+4 уште');
  });
});

describe('the sweeps', () => {
  it('sends a confirmation once and never again', async () => {
    const appointmentId = await givenAppointment(
      new Date(Date.now() + 3 * 86_400_000),
      '+38970123456',
    );

    const sms = new FakeSms();
    const first = await sweepConfirmations({ db: testDb.db, sms, logger: silent });
    expect(first.sent).toBe(1);
    expect(sms.sent[0]!.to).toBe('+38970123456');

    // Idempotent by construction: the stamp is a column, so a second run has
    // nothing to find. This is what replaces a queue.
    const second = await sweepConfirmations({ db: testDb.db, sms, logger: silent });
    expect(second.sent).toBe(0);
    expect(sms.sent).toHaveLength(1);

    // And an explicit re-send of the same booking is equally refused.
    await confirmNow({ db: testDb.db, sms, logger: silent }, appointmentId);
    expect(sms.sent).toHaveLength(1);
  });

  it('leaves the appointment unstamped when the carrier throws, so the next sweep retries', async () => {
    const appointmentId = await givenAppointment(
      new Date(Date.now() + 4 * 86_400_000),
      '+38970999888',
    );

    const failing = new FakeSms(() => new Error('telnyx is down'));
    const result = await sweepConfirmations({ db: testDb.db, sms: failing, logger: silent });
    expect(result.failed).toBeGreaterThan(0);

    /**
     * The whole durability story in one assertion. Stamping before the
     * carrier accepts would turn this transient failure into a confirmation
     * nobody ever receives, with no record that it was owed.
     */
    const stillDue = await appointmentsAwaitingConfirmation(testDb.db, new Date(), 200);
    expect(stillDue.map((a) => a.id)).toContain(appointmentId);
  });

  it('does not stamp an undeliverable message either', async () => {
    await givenAppointment(new Date(Date.now() + 5 * 86_400_000), '+38970777666');

    const refusing = new FakeSms(() => ({ status: 'undeliverable', reason: 'US long code' }));
    const result = await sweepConfirmations({ db: testDb.db, sms: refusing, logger: silent });
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.sent).toBe(0);
    // Nothing was delivered, so nothing may be recorded as delivered — it
    // becomes sendable the moment the sender ID changes.
    expect(refusing.sent).toHaveLength(0);
  });

  it('reminds only what falls inside the window', async () => {
    const sms = new FakeSms();
    const now = new Date();

    await givenAppointment(new Date(now.getTime() + 24.5 * 3_600_000), '+38970111000');

    const result = await sweepReminders({ db: testDb.db, sms, logger: silent }, { leadHours: 24, windowHours: 1 });
    expect(result.sent).toBe(1);
    expect(sms.sent[0]!.text).toContain('Потсетник');

    // Run again: the stamp means the same person is not reminded twice.
    const again = await sweepReminders({ db: testDb.db, sms, logger: silent }, { leadHours: 24, windowHours: 1 });
    expect(again.sent).toBe(0);
  });
});

describe('the telnyx client', () => {
  it('names the messaging profile when sending from a sender ID', async () => {
    let body: Record<string, unknown> = {};
    const provider = new TelnyxSmsProvider({
      apiKey: 'KEY',
      sender: { from: 'FRONTLY', messagingProfileId: 'mp_1', alphanumeric: true },
      fetchImpl: (async (_url: string, init: { body: string }) => {
        body = JSON.parse(init.body) as Record<string, unknown>;
        return { ok: true, json: async () => ({ data: { id: 'msg_9' } }) };
      }) as unknown as typeof fetch,
    });

    const outcome = await provider.send({ to: '+38970123456', text: 'здраво' });
    expect(outcome).toEqual({ status: 'sent', providerId: 'msg_9' });
    // Telnyx has no number to look the profile up from, so it must be named.
    expect(body.messaging_profile_id).toBe('mp_1');
    expect(body.from).toBe('FRONTLY');
  });

  it('never spends a request on a message the sender cannot carry', async () => {
    let called = false;
    const provider = new TelnyxSmsProvider({
      apiKey: 'KEY',
      sender: { from: '+16193497599', alphanumeric: false },
      fetchImpl: (async () => {
        called = true;
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch,
    });

    const outcome = await provider.send({ to: '+38970123456', text: 'здраво' });
    expect(outcome.status).toBe('undeliverable');
    expect(called).toBe(false);
  });

  it('treats a carrier-substituted sender as a delivery, not a failure', async () => {
    const provider = new TelnyxSmsProvider({
      apiKey: 'KEY',
      sender: { from: 'FRONTLY', messagingProfileId: 'mp_1', alphanumeric: true },
      fetchImpl: (async () => ({
        ok: true,
        // Telnyx warned the alpha sender may be swapped for a generic one to
        // get the message delivered on some networks.
        json: async () => ({ data: { id: 'msg_7', from: { phone_number: '+38975000111' } } }),
      })) as unknown as typeof fetch,
    });

    const outcome = await provider.send({ to: '+38970123456', text: 'здраво' });
    // Delivered. Anything that retried or errored here would send the patient
    // a second copy of a message they already have.
    expect(outcome.status).toBe('sent');
    if (outcome.status === 'sent') {
      expect(outcome.senderSubstituted).toBe(true);
      expect(outcome.sentFrom).toBe('+38975000111');
    }
  });

  it('does not call it a substitution when the sender came back unchanged', async () => {
    const provider = new TelnyxSmsProvider({
      apiKey: 'KEY',
      sender: { from: 'FRONTLY', messagingProfileId: 'mp_1', alphanumeric: true },
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ data: { id: 'msg_8', from: { phone_number: 'FRONTLY' } } }),
      })) as unknown as typeof fetch,
    });

    const outcome = await provider.send({ to: '+38970123456', text: 'здраво' });
    expect(outcome.status).toBe('sent');
    if (outcome.status === 'sent') expect(outcome.senderSubstituted).toBeUndefined();
  });

  it('treats a rejected sender as undeliverable rather than retryable', async () => {
    const provider = new TelnyxSmsProvider({
      apiKey: 'KEY',
      sender: { from: 'FRONTLY', messagingProfileId: 'mp_1', alphanumeric: true },
      fetchImpl: (async () => ({
        ok: false,
        status: 422,
        text: async () => '{"errors":[{"detail":"sender id not approved for destination"}]}',
      })) as unknown as typeof fetch,
    });

    const outcome = await provider.send({ to: '+38970123456', text: 'здраво' });
    // Retrying this every hour until the deadline would be pure log noise —
    // it fails identically until the Telnyx ticket is resolved.
    expect(outcome.status).toBe('undeliverable');
    if (outcome.status === 'undeliverable') expect(outcome.reason).toContain('MK');
  });
});
