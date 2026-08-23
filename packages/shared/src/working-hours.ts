import { z } from 'zod';

/**
 * Working hours are stored as JSON on both `businesses` and `staff`, so the
 * same shape validates in both places. Times are wall-clock "HH:MM" in the
 * business's own timezone — never UTC, never with a date attached. Slot maths
 * (Phase 2) converts to instants using the business timezone.
 */

export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type DayKey = (typeof DAY_KEYS)[number];

/** JS Date#getDay() is Sunday-first; our week is Monday-first. */
export const DAY_KEY_BY_JS_DAY: readonly DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const timeOfDaySchema = z
  .string()
  .regex(TIME_RE, 'Expected wall-clock time as HH:MM (24h), e.g. "09:00"');

/**
 * zod v4 runs refinements even when an inner field has already failed, so
 * every cross-field check below has to tolerate a malformed time rather than
 * throw. Otherwise a typo like "9:00" crashes validation instead of being
 * reported as the field error it is.
 */
function tryMinutes(time: string): number | undefined {
  const m = TIME_RE.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

export const intervalSchema = z
  .object({
    start: timeOfDaySchema,
    end: timeOfDaySchema,
  })
  .refine(
    (i) => {
      const start = tryMinutes(i.start);
      const end = tryMinutes(i.end);
      return start === undefined || end === undefined || start < end;
    },
    { message: 'Interval end must be after start (overnight shifts are not supported)' },
  );

export type Interval = z.infer<typeof intervalSchema>;

/**
 * A day holds a list of intervals so a split shift (09:00-13:00, 16:00-20:00)
 * is expressible. An empty array means closed that day.
 */
const dayScheduleSchema = z.array(intervalSchema).superRefine((intervals, ctx) => {
  const parsed = intervals
    .map((i) => ({ raw: i, start: tryMinutes(i.start), end: tryMinutes(i.end) }))
    .filter((i): i is { raw: Interval; start: number; end: number } => {
      return i.start !== undefined && i.end !== undefined;
    })
    .sort((a, b) => a.start - b.start);

  for (let i = 1; i < parsed.length; i++) {
    const prev = parsed[i - 1]!;
    const curr = parsed[i]!;
    if (curr.start < prev.end) {
      ctx.addIssue({
        code: 'custom',
        message:
          `Overlapping intervals: ${prev.raw.start}-${prev.raw.end} ` +
          `and ${curr.raw.start}-${curr.raw.end}`,
      });
    }
  }
});

export const workingHoursSchema = z.object({
  mon: dayScheduleSchema,
  tue: dayScheduleSchema,
  wed: dayScheduleSchema,
  thu: dayScheduleSchema,
  fri: dayScheduleSchema,
  sat: dayScheduleSchema,
  sun: dayScheduleSchema,
});

export type WorkingHours = z.infer<typeof workingHoursSchema>;

/** Minutes since midnight. "09:30" -> 570. */
export function toMinutes(time: string): number {
  const m = TIME_RE.exec(time);
  if (!m) throw new Error(`Invalid time of day: ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Inverse of toMinutes. 570 -> "09:30". */
export function fromMinutes(minutes: number): string {
  const clamped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function emptyWorkingHours(): WorkingHours {
  return { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
}

/**
 * Convenience builder: same intervals Mon-Fri, optional Saturday, closed Sunday.
 * This is the shape almost every clinic in the seed data uses.
 */
export function weekdayHours(
  weekday: Interval[],
  saturday: Interval[] = [],
  sunday: Interval[] = [],
): WorkingHours {
  return {
    mon: weekday,
    tue: weekday,
    wed: weekday,
    thu: weekday,
    fri: weekday,
    sat: saturday,
    sun: sunday,
  };
}
