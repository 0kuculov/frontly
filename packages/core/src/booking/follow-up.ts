import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { appointments, businesses, conversations, services, staff } from '../db/schema.js';

/**
 * Which appointments still owe someone a message, and what the owner's day
 * looked like.
 *
 * Queries only. Nothing here knows what SMS is, who Telnyx are, or how a
 * message is worded — `packages/core` cannot reach a carrier and must not
 * learn to. The adapter in `apps/api` asks these questions and does the
 * sending, exactly as the voice channel does with the conversation engine.
 *
 * The design has no queue on purpose. Both "has the confirmation gone out?"
 * and "has the reminder gone out?" are columns on the appointment itself, so
 * the hourly sweep is idempotent by construction and doubles as the retry:
 * a send that failed leaves the column NULL and is simply picked up next
 * hour. A queue would add a moving part to a system whose whole failure mode
 * is "one text did not arrive".
 */

export interface DueAppointment {
  id: string;
  businessId: string;
  businessName: string;
  customerName: string;
  customerPhone: string;
  serviceName: string;
  staffName: string;
  startsAt: Date;
  timezone: string;
  languages: string[];
}

/** The columns every follow-up needs, joined once. */
function dueSelection() {
  return {
    id: appointments.id,
    businessId: appointments.businessId,
    businessName: businesses.name,
    customerName: appointments.customerName,
    customerPhone: appointments.customerPhone,
    serviceName: services.nameMk,
    staffName: staff.name,
    startsAt: appointments.startsAt,
    timezone: businesses.timezone,
    languages: businesses.languages,
  };
}

function toDue(row: Record<string, unknown>): DueAppointment {
  return {
    ...(row as unknown as DueAppointment),
    languages: (row.languages as string[] | null) ?? ['mk'],
  };
}

/**
 * Bookings that have not had their confirmation sent.
 *
 * Bounded to the future: a confirmation for an appointment that has already
 * happened is noise at best and confusing at worst, so a booking that slipped
 * through while the process was down is only rescued while it still matters.
 */
export async function appointmentsAwaitingConfirmation(
  db: Database,
  now: Date,
  limit = 50,
): Promise<DueAppointment[]> {
  const rows = await db
    .select(dueSelection())
    .from(appointments)
    .innerJoin(businesses, eq(appointments.businessId, businesses.id))
    .innerJoin(services, eq(appointments.serviceId, services.id))
    .innerJoin(staff, eq(appointments.staffId, staff.id))
    .where(
      and(
        eq(appointments.status, 'booked'),
        isNull(appointments.confirmationSentAt),
        gte(appointments.startsAt, now),
      ),
    )
    .limit(limit);

  return rows.map((row) => toDue(row as Record<string, unknown>));
}

/**
 * Bookings starting inside the reminder window that have not been reminded.
 *
 * The window is a range rather than "exactly 24h from now" because the sweep
 * runs on a cron: an appointment can only be caught on the ticks that happen
 * to straddle it. An hourly cron with a 24-25h window sees every appointment
 * exactly once — and if a tick is missed, the next one still catches it while
 * there is time for the reminder to be useful.
 */
export async function appointmentsDueForReminder(
  db: Database,
  now: Date,
  { leadHours = 24, windowHours = 1, limit = 100 } = {},
): Promise<DueAppointment[]> {
  const from = new Date(now.getTime() + leadHours * 3_600_000);
  const to = new Date(from.getTime() + windowHours * 3_600_000);

  const rows = await db
    .select(dueSelection())
    .from(appointments)
    .innerJoin(businesses, eq(appointments.businessId, businesses.id))
    .innerJoin(services, eq(appointments.serviceId, services.id))
    .innerJoin(staff, eq(appointments.staffId, staff.id))
    .where(
      and(
        eq(appointments.status, 'booked'),
        isNull(appointments.reminderSentAt),
        gte(appointments.startsAt, from),
        lte(appointments.startsAt, to),
      ),
    )
    .limit(limit);

  return rows.map((row) => toDue(row as Record<string, unknown>));
}

/**
 * Record that a message went out.
 *
 * Called only after the carrier accepted it. Stamping before sending would
 * turn a transient failure into a message nobody ever receives, which is the
 * one outcome worse than sending twice.
 */
export async function markFollowUpSent(
  db: Database,
  appointmentId: string,
  kind: 'confirmation' | 'reminder',
  at: Date,
): Promise<void> {
  await db
    .update(appointments)
    .set(
      kind === 'confirmation'
        ? { confirmationSentAt: at, updatedAt: at }
        : { reminderSentAt: at, updatedAt: at },
    )
    .where(eq(appointments.id, appointmentId));
}

export interface DailySummary {
  businessId: string;
  businessName: string;
  ownerMobile: string | null;
  timezone: string;
  languages: string[];
  /** Calls and chats that reached a conclusion today. */
  conversations: number;
  booked: number;
  transferred: number;
  /** Appointments in tomorrow's diary, so the owner knows what is coming. */
  tomorrow: { startsAt: Date; customerName: string; serviceName: string; staffName: string }[];
}

/**
 * What the owner gets at 20:00.
 *
 * Counted over an explicit instant range supplied by the caller rather than
 * "today" computed here, because a day boundary is a wall-clock question in
 * the business's own timezone and this package stores only UTC millis. The
 * caller owns the timezone maths; this owns the counting.
 */
export async function dailySummary(
  db: Database,
  businessId: string,
  dayStart: Date,
  dayEnd: Date,
  tomorrowStart: Date,
  tomorrowEnd: Date,
): Promise<DailySummary | undefined> {
  const [business] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  if (!business) return undefined;

  const [counts] = await db
    .select({
      total: sql<number>`count(*)`,
      booked: sql<number>`sum(case when ${conversations.outcome} = 'booked' then 1 else 0 end)`,
      transferred: sql<number>`sum(case when ${conversations.outcome} = 'transferred' then 1 else 0 end)`,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.businessId, businessId),
        gte(conversations.startedAt, dayStart),
        lte(conversations.startedAt, dayEnd),
      ),
    );

  const tomorrow = await db
    .select({
      startsAt: appointments.startsAt,
      customerName: appointments.customerName,
      serviceName: services.nameMk,
      staffName: staff.name,
    })
    .from(appointments)
    .innerJoin(services, eq(appointments.serviceId, services.id))
    .innerJoin(staff, eq(appointments.staffId, staff.id))
    .where(
      and(
        eq(appointments.businessId, businessId),
        eq(appointments.status, 'booked'),
        gte(appointments.startsAt, tomorrowStart),
        lte(appointments.startsAt, tomorrowEnd),
      ),
    )
    .orderBy(appointments.startsAt);

  return {
    businessId,
    businessName: business.name,
    ownerMobile: business.ownerMobile,
    timezone: business.timezone,
    languages: (business.languages as string[] | null) ?? ['mk'],
    conversations: Number(counts?.total ?? 0),
    booked: Number(counts?.booked ?? 0),
    transferred: Number(counts?.transferred ?? 0),
    tomorrow,
  };
}
