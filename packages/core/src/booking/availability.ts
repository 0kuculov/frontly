import { and, eq, gte, lt } from 'drizzle-orm';
import {
  BLOCKING_STATUSES,
  toMinutes,
  type WorkingHours,
} from '@frontly/shared';
import type { Database } from '../db/client.js';
import { appointments, type Business, type Service, type StaffMember } from '../db/schema.js';
import {
  dayKeyForLocalDate,
  eachLocalDate,
  fromZonedWallClock,
  parseLocalDateString,
  toLocalDateString,
} from '../time/zone.js';

/**
 * Free-slot computation.
 *
 * The single rule this module exists to make true: the agent may only offer
 * times that came out of here. Everything the model says about availability is
 * traceable to a slot this function returned.
 */

export interface FreeSlot {
  staffId: string;
  staffName: string;
  startsAt: Date;
  endsAt: Date;
}

export interface AvailabilityQuery {
  business: Business;
  service: Service;
  staff: StaffMember[];
  /** Inclusive local date range, "YYYY-MM-DD". */
  from: string;
  to: string;
  /** Only consider this staff member. */
  staffId?: string | undefined;
  /** Reference instant; injectable so tests are not clock-dependent. */
  now?: Date;
  /** Candidate starts every N minutes inside a shift. */
  granularityMinutes?: number;
  /** Refuse to offer anything sooner than this. */
  minimumNoticeMinutes?: number;
  /** Cap the returned list — a phone caller can only hear a few. */
  limit?: number;
}

/** Clinics book on the half hour, and it keeps one day's list speakable. */
const DEFAULT_GRANULARITY_MINUTES = 30;
const DEFAULT_MINIMUM_NOTICE_MINUTES = 60;
const DEFAULT_LIMIT = 20;

/** Staff who are active and able to perform this service ([] means all). */
export function staffForService(staff: StaffMember[], serviceId: string): StaffMember[] {
  return staff.filter(
    (s) => s.active && (s.serviceIds.length === 0 || s.serviceIds.includes(serviceId)),
  );
}

function hoursFor(member: StaffMember, business: Business): WorkingHours {
  // NULL on a staff row means "inherits the business's hours".
  return member.workingHours ?? business.workingHours;
}

export async function findFreeSlots(db: Database, query: AvailabilityQuery): Promise<FreeSlot[]> {
  const {
    business,
    service,
    from,
    to,
    now = new Date(),
    granularityMinutes = DEFAULT_GRANULARITY_MINUTES,
    minimumNoticeMinutes = DEFAULT_MINIMUM_NOTICE_MINUTES,
    limit = DEFAULT_LIMIT,
  } = query;

  const timeZone = business.timezone;
  const duration = service.durationMinutes;

  let candidates = staffForService(query.staff, service.id);
  if (query.staffId) candidates = candidates.filter((s) => s.id === query.staffId);
  if (candidates.length === 0) return [];

  const dates = eachLocalDate(from, to);
  if (dates.length === 0) return [];

  // One query for the whole window rather than one per day.
  const windowStart = startOfLocalDay(timeZone, dates[0]!);
  const windowEnd = endOfLocalDay(timeZone, dates[dates.length - 1]!);

  const booked = await db
    .select({
      staffId: appointments.staffId,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      status: appointments.status,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.businessId, business.id),
        gte(appointments.startsAt, windowStart),
        lt(appointments.startsAt, windowEnd),
      ),
    );

  const busyByStaff = new Map<string, { start: number; end: number }[]>();
  for (const row of booked) {
    if (!BLOCKING_STATUSES.includes(row.status)) continue;
    const list = busyByStaff.get(row.staffId) ?? [];
    list.push({ start: row.startsAt.getTime(), end: row.endsAt.getTime() });
    busyByStaff.set(row.staffId, list);
  }

  const earliest = now.getTime() + minimumNoticeMinutes * 60_000;
  const slots: FreeSlot[] = [];

  for (const date of dates) {
    const dayKey = dayKeyForLocalDate(date);
    const { year, month, day } = parseLocalDateString(date);

    for (const member of candidates) {
      const intervals = hoursFor(member, business)[dayKey];
      if (intervals.length === 0) continue; // closed

      const busy = busyByStaff.get(member.id) ?? [];

      for (const interval of intervals) {
        const openMinutes = toMinutes(interval.start);
        const closeMinutes = toMinutes(interval.end);

        for (
          let startMinutes = openMinutes;
          startMinutes + duration <= closeMinutes;
          startMinutes += granularityMinutes
        ) {
          const startsAt = fromZonedWallClock(
            timeZone,
            year,
            month,
            day,
            Math.floor(startMinutes / 60),
            startMinutes % 60,
          );
          const start = startsAt.getTime();
          const end = start + duration * 60_000;

          if (start < earliest) continue;
          if (busy.some((b) => start < b.end && b.start < end)) continue;

          slots.push({
            staffId: member.id,
            staffName: member.name,
            startsAt,
            endsAt: new Date(end),
          });
        }
      }
    }
  }

  slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.staffId.localeCompare(b.staffId));
  return slots.slice(0, limit);
}

/**
 * Slots grouped so the agent can offer one time per staff member rather than
 * reading out four consecutive quarter-hours with the same doctor.
 */
export function distinctStartTimes(slots: FreeSlot[], max = 3): FreeSlot[] {
  const seen = new Set<number>();
  const out: FreeSlot[] = [];
  for (const slot of slots) {
    const key = slot.startsAt.getTime();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slot);
    if (out.length >= max) break;
  }
  return out;
}

export interface SpreadOptions {
  timeZone: string;
  /** Times to show per calendar day. */
  perDay?: number;
  /** Overall cap across the whole range. */
  total?: number;
}

/**
 * Pick a representative handful of times across the range.
 *
 * Truncating a chronological list is the obvious thing to do and it is wrong:
 * at quarter-hour granularity with two doctors, the first twenty slots are all
 * before eleven in the morning, so a caller asking for an afternoon would be
 * told about mornings. This spreads the choice across each day instead, which
 * is also how a receptionist answers — "morning or afternoon?".
 */
export function spreadSlots(slots: FreeSlot[], options: SpreadOptions): FreeSlot[] {
  const { timeZone, perDay = 4, total = 12 } = options;

  // One entry per distinct start time; the earliest-listed staff member wins.
  const byTime = new Map<number, FreeSlot>();
  for (const slot of slots) {
    if (!byTime.has(slot.startsAt.getTime())) byTime.set(slot.startsAt.getTime(), slot);
  }
  const unique = [...byTime.values()].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );

  const byDay = new Map<string, FreeSlot[]>();
  for (const slot of unique) {
    const day = toLocalDateString(slot.startsAt, timeZone);
    const list = byDay.get(day) ?? [];
    list.push(slot);
    byDay.set(day, list);
  }

  const out: FreeSlot[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const daySlots = byDay.get(day)!;
    const take = Math.min(perDay, daySlots.length);
    // Even sampling across the day: first, last, and evenly between.
    const step = take > 1 ? (daySlots.length - 1) / (take - 1) : 0;
    for (let i = 0; i < take; i++) {
      out.push(daySlots[Math.round(i * step)]!);
    }
    if (out.length >= total) break;
  }

  return out.slice(0, total);
}

function startOfLocalDay(timeZone: string, date: string): Date {
  const { year, month, day } = parseLocalDateString(date);
  return fromZonedWallClock(timeZone, year, month, day, 0, 0);
}

function endOfLocalDay(timeZone: string, date: string): Date {
  const { year, month, day } = parseLocalDateString(date);
  // Start of the following day; the range check is half-open.
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return fromZonedWallClock(
    timeZone,
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
    0,
  );
}
