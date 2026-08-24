import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { appointments, businesses, services, staff, type Business, type Service, type StaffMember } from '../db/schema.js';
import { DEMO_IDS } from '../db/seed.js';
import { createTestDb, type TestDatabase } from '../db/testing.js';
import { fromZonedWallClock, toZonedParts } from '../time/zone.js';
import { findFreeSlots, staffForService } from './availability.js';
import { bookAppointment, cancelAppointment, rescheduleAppointment } from './booking.js';
import { BookingError } from './errors.js';

const SKOPJE = 'Europe/Skopje';

/** Monday 7 September 2026, 08:00 in Ohrid — an hour before the clinic opens. */
const NOW = fromZonedWallClock(SKOPJE, 2026, 9, 7, 8, 0);

let testDb: TestDatabase;
let db: Database;
let business: Business;
let allServices: Service[];
let allStaff: StaffMember[];

const checkup = () => allServices.find((s) => s.id === DEMO_IDS.services.checkup)!;
const filling = () => allServices.find((s) => s.id === DEMO_IDS.services.filling)!;

beforeAll(async () => {
  testDb = await createTestDb();
  db = testDb.db;
  business = (await db.select().from(businesses).where(eq(businesses.id, DEMO_IDS.business)))[0]!;
  allServices = await db.select().from(services).where(eq(services.businessId, DEMO_IDS.business));
  allStaff = await db.select().from(staff).where(eq(staff.businessId, DEMO_IDS.business));
});

afterAll(() => testDb?.cleanup());

beforeEach(async () => {
  await db.delete(appointments).where(eq(appointments.businessId, DEMO_IDS.business));
});

const localHour = (d: Date) => toZonedParts(d, SKOPJE).hour;

describe('finding free slots', () => {
  it('offers nothing outside the clinic’s opening hours', async () => {
    const slots = await findFreeSlots(db, {
      business,
      service: checkup(),
      staff: allStaff,
      from: '2026-09-07',
      to: '2026-09-07',
      now: NOW,
      limit: 200,
    });

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(localHour(slot.startsAt)).toBeGreaterThanOrEqual(9);
      // A 30-minute checkup must finish by 17:00, so it cannot start at 16:45.
      expect(toZonedParts(slot.endsAt, SKOPJE).hour * 60 + toZonedParts(slot.endsAt, SKOPJE).minute)
        .toBeLessThanOrEqual(17 * 60);
    }
  });

  it('honours a staff member’s own shift over the clinic’s', async () => {
    const slots = await findFreeSlots(db, {
      business,
      service: checkup(),
      staff: allStaff,
      from: '2026-09-07',
      to: '2026-09-07',
      staffId: DEMO_IDS.staff.stefan,
      now: NOW,
      limit: 200,
    });

    // Dr Stefan works afternoons only.
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) expect(localHour(slot.startsAt)).toBeGreaterThanOrEqual(12);
  });

  it('closes on Sunday and shortens Saturday', async () => {
    const sunday = await findFreeSlots(db, {
      business, service: checkup(), staff: allStaff,
      from: '2026-09-13', to: '2026-09-13', now: NOW, limit: 200,
    });
    expect(sunday).toHaveLength(0);

    const saturday = await findFreeSlots(db, {
      business, service: checkup(), staff: allStaff,
      from: '2026-09-12', to: '2026-09-12', now: NOW, limit: 200,
    });
    expect(saturday.length).toBeGreaterThan(0);
    // Saturday is 09:00-13:00, and only Dr Ana works it.
    for (const slot of saturday) {
      expect(slot.staffId).toBe(DEMO_IDS.staff.ana);
      expect(toZonedParts(slot.endsAt, SKOPJE).hour).toBeLessThanOrEqual(13);
    }
  });

  it('only offers staff who perform the service', () => {
    // Dr Stefan does not do fillings.
    const eligible = staffForService(allStaff, DEMO_IDS.services.filling);
    expect(eligible.map((s) => s.id)).toEqual([DEMO_IDS.staff.ana]);
  });

  it('stops offering a time once it is booked', async () => {
    const at10 = fromZonedWallClock(SKOPJE, 2026, 9, 7, 10, 0);

    const before = await findFreeSlots(db, {
      business, service: checkup(), staff: allStaff,
      from: '2026-09-07', to: '2026-09-07', staffId: DEMO_IDS.staff.ana, now: NOW, limit: 200,
    });
    expect(before.some((s) => s.startsAt.getTime() === at10.getTime())).toBe(true);

    await bookAppointment(db, {
      business, serviceId: checkup().id, staffId: DEMO_IDS.staff.ana,
      startsAt: at10, customerName: 'Марко', customerPhone: '+38970111222',
      channel: 'voice', now: NOW,
    });

    const after = await findFreeSlots(db, {
      business, service: checkup(), staff: allStaff,
      from: '2026-09-07', to: '2026-09-07', staffId: DEMO_IDS.staff.ana, now: NOW, limit: 200,
    });
    expect(after.some((s) => s.startsAt.getTime() === at10.getTime())).toBe(false);
    // The overlapping 09:45 start is gone too — a 30-min service runs into it.
    const at0945 = fromZonedWallClock(SKOPJE, 2026, 9, 7, 9, 45);
    expect(after.some((s) => s.startsAt.getTime() === at0945.getTime())).toBe(false);
  });

  it('refuses to offer a time inside the minimum-notice window', async () => {
    // 08:30 local, so 09:00 is only 30 minutes away.
    const late = fromZonedWallClock(SKOPJE, 2026, 9, 7, 8, 30);
    const slots = await findFreeSlots(db, {
      business, service: checkup(), staff: allStaff,
      from: '2026-09-07', to: '2026-09-07', now: late,
      minimumNoticeMinutes: 60, limit: 200,
    });
    for (const slot of slots) {
      expect(slot.startsAt.getTime()).toBeGreaterThanOrEqual(late.getTime() + 60 * 60_000);
    }
  });
});

describe('booking', () => {
  const at1030 = () => fromZonedWallClock(SKOPJE, 2026, 9, 7, 10, 30);

  const book = (overrides: Partial<Parameters<typeof bookAppointment>[1]> = {}) =>
    bookAppointment(db, {
      business,
      serviceId: checkup().id,
      staffId: DEMO_IDS.staff.ana,
      startsAt: at1030(),
      customerName: 'Марко Петровски',
      customerPhone: '+38970111222',
      channel: 'voice',
      now: NOW,
      ...overrides,
    });

  it('writes the appointment with the service’s duration', async () => {
    const created = await book();
    expect(created.status).toBe('booked');
    expect(created.endsAt.getTime() - created.startsAt.getTime()).toBe(30 * 60_000);
  });

  it('rejects a second booking for the same doctor at the same time', async () => {
    // The scenario the whole design turns on: two callers, one 10:30 slot.
    await book();
    await expect(book({ customerName: 'Ана Јованова', customerPhone: '+38971333444' }))
      .rejects.toMatchObject({ code: 'slot_taken' });
  });

  it('allows the other doctor at the same time', async () => {
    // Dr Stefan works afternoons, so compare them on a slot they share.
    const afternoon = fromZonedWallClock(SKOPJE, 2026, 9, 7, 14, 0);
    await book({ startsAt: afternoon });
    await expect(
      book({ staffId: DEMO_IDS.staff.stefan, startsAt: afternoon, customerPhone: '+38971333444' }),
    ).resolves.toMatchObject({ status: 'booked' });
  });

  it('frees the slot again after a cancellation', async () => {
    const created = await book();
    await cancelAppointment(db, {
      business, appointmentId: created.id, customerPhone: '+38970111222', now: NOW,
    });
    await expect(book({ customerName: 'Елена' })).resolves.toMatchObject({ status: 'booked' });
  });

  it('refuses a time outside working hours', async () => {
    // 07:00 tomorrow: comfortably in the future, still before the clinic opens.
    await expect(book({ startsAt: fromZonedWallClock(SKOPJE, 2026, 9, 8, 7, 0) }))
      .rejects.toMatchObject({ code: 'outside_working_hours' });
  });

  it('refuses a time in the past', async () => {
    await expect(book({ startsAt: fromZonedWallClock(SKOPJE, 2026, 9, 1, 10, 0) }))
      .rejects.toMatchObject({ code: 'in_the_past' });
  });

  it('refuses a doctor who does not perform the service', async () => {
    await expect(
      book({ serviceId: filling().id, staffId: DEMO_IDS.staff.stefan, startsAt: fromZonedWallClock(SKOPJE, 2026, 9, 7, 13, 0) }),
    ).rejects.toMatchObject({ code: 'staff_cannot_perform_service' });
  });

  it('will not book without a contact number', async () => {
    await expect(book({ customerPhone: '  ' })).rejects.toBeInstanceOf(BookingError);
  });
});

describe('cancelling and rescheduling', () => {
  const at1030 = () => fromZonedWallClock(SKOPJE, 2026, 9, 7, 10, 30);

  const seedOne = () =>
    bookAppointment(db, {
      business, serviceId: checkup().id, staffId: DEMO_IDS.staff.ana,
      startsAt: at1030(), customerName: 'Марко Петровски',
      customerPhone: '+38970111222', channel: 'voice', now: NOW,
    });

  it('finds the caller’s appointment by number alone', async () => {
    await seedOne();
    const cancelled = await cancelAppointment(db, {
      business, customerPhone: '+38970111222', now: NOW,
    });
    expect(cancelled.status).toBe('cancelled');
  });

  it('tolerates a differently-formatted Balkan number', async () => {
    await seedOne();
    // Same number written as a local 070 prefix.
    const cancelled = await cancelAppointment(db, {
      business, customerPhone: '070 111 222', now: NOW,
    });
    expect(cancelled.status).toBe('cancelled');
  });

  it('will not let one caller cancel another’s appointment by id', async () => {
    const created = await seedOne();
    await expect(
      cancelAppointment(db, { business, appointmentId: created.id, customerPhone: '+38975999888', now: NOW }),
    ).rejects.toMatchObject({ code: 'contact_mismatch' });
  });

  it('moves an appointment to a new time', async () => {
    const created = await seedOne();
    const newTime = fromZonedWallClock(SKOPJE, 2026, 9, 8, 14, 0);
    const moved = await rescheduleAppointment(db, {
      business, appointmentId: created.id, newStartsAt: newTime, now: NOW,
    });
    expect(moved.startsAt.getTime()).toBe(newTime.getTime());
    expect(moved.endsAt.getTime() - moved.startsAt.getTime()).toBe(30 * 60_000);
  });

  it('refuses to reschedule onto an occupied slot', async () => {
    const first = await seedOne();
    const second = fromZonedWallClock(SKOPJE, 2026, 9, 8, 14, 0);
    await bookAppointment(db, {
      business, serviceId: checkup().id, staffId: DEMO_IDS.staff.ana,
      startsAt: second, customerName: 'Ана', customerPhone: '+38971333444',
      channel: 'chat', now: NOW,
    });

    await expect(
      rescheduleAppointment(db, { business, appointmentId: first.id, newStartsAt: second, now: NOW }),
    ).rejects.toMatchObject({ code: 'slot_taken' });
  });
});
