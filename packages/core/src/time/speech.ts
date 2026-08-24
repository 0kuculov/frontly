import type { Language } from '@frontly/shared';
import { toLocalDateString, toZonedParts } from './zone.js';

/**
 * Turning an instant into something a person would actually say.
 *
 * This exists because the agent is heard, not read. "2026-09-03T08:30:00Z" is
 * correct and useless; "во четврток, трети септември, во десет и половина
 * наутро" is what a receptionist says. Every date or time the model is allowed
 * to speak comes from here — the system prompt forbids it from formatting
 * dates itself, precisely so this stays the single source of phrasing.
 *
 * Words, not digits: "3-ти" is read aloud inconsistently by TTS engines,
 * whereas "трети" is unambiguous.
 */

// --- Macedonian --------------------------------------------------------------

const MK_WEEKDAYS = [
  'недела',
  'понеделник',
  'вторник',
  'среда',
  'четврток',
  'петок',
  'сабота',
] as const;

const MK_MONTHS = [
  'јануари',
  'февруари',
  'март',
  'април',
  'мај',
  'јуни',
  'јули',
  'август',
  'септември',
  'октомври',
  'ноември',
  'декември',
] as const;

/** Masculine ordinals 1-31, the form used with "ден"/a date. */
const MK_ORDINALS_1_TO_20 = [
  'први',
  'втори',
  'трети',
  'четврти',
  'петти',
  'шести',
  'седми',
  'осми',
  'деветти',
  'десетти',
  'единаесетти',
  'дванаесетти',
  'тринаесетти',
  'четиринаесетти',
  'петнаесетти',
  'шеснаесетти',
  'седумнаесетти',
  'осумнаесетти',
  'деветнаесетти',
  'дваесетти',
] as const;

function mkOrdinalDay(day: number): string {
  if (day <= 20) return MK_ORDINALS_1_TO_20[day - 1]!;
  if (day === 30) return 'триесетти';
  const tens = day < 30 ? 'дваесет' : 'триесет';
  return `${tens} и ${MK_ORDINALS_1_TO_20[(day % 10) - 1]!}`;
}

/** Cardinal hours as spoken on a clock face. */
const MK_HOURS = [
  'дванаесет',
  'еден',
  'два',
  'три',
  'четири',
  'пет',
  'шест',
  'седум',
  'осум',
  'девет',
  'десет',
  'единаесет',
] as const;

const MK_MINUTES: Record<number, string> = {
  5: 'пет',
  10: 'десет',
  15: 'петнаесет',
  20: 'дваесет',
  25: 'дваесет и пет',
  35: 'триесет и пет',
  40: 'четириесет',
  45: 'четириесет и пет',
  50: 'педесет',
  55: 'педесет и пет',
};

function mkPartOfDay(hour24: number): string {
  // 11:00 is still morning; "напладне" is noon itself, not the hour before it.
  if (hour24 < 12) return 'наутро';
  if (hour24 < 13) return 'напладне';
  if (hour24 < 18) return 'попладне';
  return 'навечер';
}

function mkTime(hour24: number, minute: number): string {
  const clockHour = MK_HOURS[hour24 % 12]!;
  const suffix = mkPartOfDay(hour24);

  if (minute === 0) return `во ${clockHour} часот ${suffix}`;
  if (minute === 30) return `во ${clockHour} и половина ${suffix}`;

  const spokenMinutes = MK_MINUTES[minute] ?? String(minute);
  return `во ${clockHour} и ${spokenMinutes} ${suffix}`;
}

// --- Albanian ----------------------------------------------------------------
// Provisional. Phase 8 verifies this against real sq-AL speech and tunes the
// phrasing; the shapes are right but the register has not been checked by a
// native speaker.

const SQ_WEEKDAYS = [
  'të dielën',
  'të hënën',
  'të martën',
  'të mërkurën',
  'të enjten',
  'të premten',
  'të shtunën',
] as const;

const SQ_MONTHS = [
  'janar',
  'shkurt',
  'mars',
  'prill',
  'maj',
  'qershor',
  'korrik',
  'gusht',
  'shtator',
  'tetor',
  'nëntor',
  'dhjetor',
] as const;

function sqTime(hour24: number, minute: number): string {
  const h = hour24 % 12 === 0 ? 12 : hour24 % 12;
  if (minute === 0) return `në orën ${h}`;
  if (minute === 30) return `në orën ${h} e gjysmë`;
  return `në orën ${h} e ${minute}`;
}

// --- English -----------------------------------------------------------------

const EN_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const EN_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function enOrdinal(day: number): string {
  if (day >= 11 && day <= 13) return `${day}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] ?? 'th';
  return `${day}${suffix}`;
}

function enTime(hour24: number, minute: number): string {
  const h = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const period = hour24 < 12 ? 'am' : 'pm';
  if (minute === 0) return `at ${h} ${period}`;
  return `at ${h}:${String(minute).padStart(2, '0')} ${period}`;
}

// --- public API --------------------------------------------------------------

function jsDayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export interface SpeakOptions {
  /** Reference instant for "today"/"tomorrow". Defaults to now. */
  now?: Date;
  /** Use "утре"/"tomorrow" instead of the weekday where it applies. */
  relative?: boolean;
}

/** "во четврток, трети септември" — the date alone. */
export function speakDate(
  instant: Date,
  timeZone: string,
  language: Language,
  options: SpeakOptions = {},
): string {
  const p = toZonedParts(instant, timeZone);
  const weekdayIndex = jsDayOf(p.year, p.month, p.day);

  if (options.relative !== false) {
    const relative = relativeDayWord(instant, timeZone, language, options.now ?? new Date());
    if (relative) return relative;
  }

  switch (language) {
    case 'mk':
      return `во ${MK_WEEKDAYS[weekdayIndex]!}, ${mkOrdinalDay(p.day)} ${MK_MONTHS[p.month - 1]!}`;
    case 'sq':
      return `${SQ_WEEKDAYS[weekdayIndex]!}, ${p.day} ${SQ_MONTHS[p.month - 1]!}`;
    case 'en':
      return `on ${EN_WEEKDAYS[weekdayIndex]!}, ${EN_MONTHS[p.month - 1]!} ${enOrdinal(p.day)}`;
  }
}

/** "во десет и половина наутро" — the time alone. */
export function speakTime(instant: Date, timeZone: string, language: Language): string {
  const p = toZonedParts(instant, timeZone);
  switch (language) {
    case 'mk':
      return mkTime(p.hour, p.minute);
    case 'sq':
      return sqTime(p.hour, p.minute);
    case 'en':
      return enTime(p.hour, p.minute);
  }
}

/**
 * "во четврток, трети септември, во десет и половина наутро" — what the agent
 * says when confirming an appointment back to the caller.
 */
export function speakDateTime(
  instant: Date,
  timeZone: string,
  language: Language,
  options: SpeakOptions = {},
): string {
  return `${speakDate(instant, timeZone, language, options)}, ${speakTime(instant, timeZone, language)}`;
}

/** "денес" / "утре" / "задутре" when the date is close, otherwise undefined. */
function relativeDayWord(
  instant: Date,
  timeZone: string,
  language: Language,
  now: Date,
): string | undefined {
  const target = toLocalDateString(instant, timeZone);
  const today = toLocalDateString(now, timeZone);
  if (target === today) return { mk: 'денес', sq: 'sot', en: 'today' }[language];

  const tomorrow = shiftLocalDate(today, 1);
  if (target === tomorrow) return { mk: 'утре', sq: 'nesër', en: 'tomorrow' }[language];

  const dayAfter = shiftLocalDate(today, 2);
  if (target === dayAfter) return { mk: 'задутре', sq: 'pasnesër', en: 'the day after tomorrow' }[language];

  return undefined;
}

function shiftLocalDate(dateString: string, days: number): string {
  const [y, m, d] = dateString.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(
    shifted.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** "45 минути" / "45 minuta" / "45 minutes" — service durations. */
export function speakDuration(minutes: number, language: Language): string {
  switch (language) {
    case 'mk':
      return minutes === 60 ? 'еден час' : `${minutes} минути`;
    case 'sq':
      return minutes === 60 ? 'një orë' : `${minutes} minuta`;
    case 'en':
      return minutes === 60 ? 'one hour' : `${minutes} minutes`;
  }
}
