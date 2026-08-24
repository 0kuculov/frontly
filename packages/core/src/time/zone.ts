import { DAY_KEY_BY_JS_DAY, type DayKey } from '@frontly/shared';

/**
 * Wall-clock <-> instant conversion for a named IANA timezone.
 *
 * Everything Frontly stores is a UTC instant; everything a business configures
 * ("09:00", "Saturday") is wall-clock in its own timezone. This module is the
 * only place the two meet.
 *
 * Built on Intl rather than a date library: the two operations below are all
 * the engine needs, and Node 24 has no Temporal. `Intl.DateTimeFormat` is
 * fully IANA/DST aware — verified for Europe/Skopje across a CET/CEST boundary
 * in the tests.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  dayKey: DayKey;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hour12: false,
    });
    partsFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

const JS_DAY_BY_SHORT_WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** What the wall clock in `timeZone` reads at instant `instant`. */
export function toZonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`Intl did not return a "${type}" part for ${timeZone}`);
    return found.value;
  };

  // Intl renders midnight as hour "24" in some ICU versions; normalise it.
  const hour = Number(get('hour')) % 24;
  const jsDay = JS_DAY_BY_SHORT_WEEKDAY[get('weekday')];
  if (jsDay === undefined) throw new Error(`Unrecognised weekday from Intl: ${get('weekday')}`);

  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    second: Number(get('second')),
    dayKey: DAY_KEY_BY_JS_DAY[jsDay]!,
  };
}

/** Offset of `timeZone` from UTC at `instant`, in minutes (CEST = +120). */
export function offsetMinutes(instant: Date, timeZone: string): number {
  const p = toZonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * The instant at which the wall clock in `timeZone` reads the given date/time.
 *
 * Inverting a timezone is a fixed-point problem: to know the offset you need
 * the instant, and to know the instant you need the offset. Guess with UTC,
 * correct with the offset at that guess, then correct once more — the second
 * pass only matters within an hour of a DST transition, and a third is never
 * needed for whole-hour transitions.
 *
 * Spring-forward gaps (02:30 on a transition day simply does not exist) settle
 * on the instant just after the jump. Frontly never books at 02:30 — clinic
 * hours cannot overlap a 02:00-03:00 transition — but it resolves rather than
 * throwing so a mis-typed setting cannot take a phone line down.
 */
export function fromZonedWallClock(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  let instant = new Date(target);
  for (let pass = 0; pass < 2; pass++) {
    const offset = offsetMinutes(instant, timeZone);
    const corrected = new Date(target - offset * 60_000);
    if (corrected.getTime() === instant.getTime()) break;
    instant = corrected;
  }
  return instant;
}

/** Midnight (00:00 wall-clock) of the given local day, as an instant. */
export function startOfZonedDay(
  timeZone: string,
  year: number,
  month: number,
  day: number,
): Date {
  return fromZonedWallClock(timeZone, year, month, day, 0, 0);
}

/** "YYYY-MM-DD" for the local day containing `instant`. */
export function toLocalDateString(instant: Date, timeZone: string): string {
  const p = toZonedParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Parse "YYYY-MM-DD" into its numeric parts. Throws on anything else. */
export function parseLocalDateString(value: string): {
  year: number;
  month: number;
  day: number;
} {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`Expected a date as YYYY-MM-DD, got "${value}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Not a valid calendar date: "${value}"`);
  }
  return { year, month, day };
}

/** Walk local calendar days from `from` to `to` inclusive, as YYYY-MM-DD. */
export function eachLocalDate(from: string, to: string, maxDays = 60): string[] {
  const start = parseLocalDateString(from);
  const end = parseLocalDateString(to);

  // Iterate in UTC: calendar arithmetic has no timezone, only the conversion
  // back to an instant does.
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day));
  const last = new Date(Date.UTC(end.year, end.month - 1, end.day));

  const out: string[] = [];
  while (cursor.getTime() <= last.getTime() && out.length < maxDays) {
    out.push(
      `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-${String(
        cursor.getUTCDate(),
      ).padStart(2, '0')}`,
    );
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** The DayKey ("mon".."sun") for a local calendar date. */
export function dayKeyForLocalDate(dateString: string): DayKey {
  const { year, month, day } = parseLocalDateString(dateString);
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return DAY_KEY_BY_JS_DAY[jsDay]!;
}
