import { describe, expect, it } from 'vitest';
import { groupPhoneDigits, speakPhoneNumber } from './phone.js';
import { speakDate, speakDateTime, speakDuration, speakTime } from './speech.js';
import {
  dayKeyForLocalDate,
  eachLocalDate,
  fromZonedWallClock,
  offsetMinutes,
  toLocalDateString,
  toZonedParts,
} from './zone.js';

const SKOPJE = 'Europe/Skopje';

describe('wall clock <-> instant', () => {
  it('resolves summer wall clock at CEST (UTC+2)', () => {
    // 10:30 in Ohrid on 3 September is 08:30 UTC.
    expect(fromZonedWallClock(SKOPJE, 2026, 9, 3, 10, 30).toISOString()).toBe(
      '2026-09-03T08:30:00.000Z',
    );
  });

  it('resolves winter wall clock at CET (UTC+1)', () => {
    expect(fromZonedWallClock(SKOPJE, 2026, 1, 15, 10, 30).toISOString()).toBe(
      '2026-01-15T09:30:00.000Z',
    );
  });

  it('tracks the October DST transition', () => {
    // Skopje leaves CEST on Sunday 25 October 2026. The same 09:00 opening
    // time is a different instant either side of it — a fixed +2 offset would
    // put every Monday appointment an hour out.
    expect(fromZonedWallClock(SKOPJE, 2026, 10, 24, 9, 0).toISOString()).toBe(
      '2026-10-24T07:00:00.000Z',
    );
    expect(fromZonedWallClock(SKOPJE, 2026, 10, 26, 9, 0).toISOString()).toBe(
      '2026-10-26T08:00:00.000Z',
    );
  });

  it('reports the offset that actually applies at an instant', () => {
    expect(offsetMinutes(new Date('2026-09-03T08:30:00Z'), SKOPJE)).toBe(120);
    expect(offsetMinutes(new Date('2026-01-15T09:30:00Z'), SKOPJE)).toBe(60);
  });

  it('round-trips through zoned parts', () => {
    const instant = fromZonedWallClock(SKOPJE, 2026, 9, 3, 14, 45);
    const parts = toZonedParts(instant, SKOPJE);
    expect(parts).toMatchObject({ year: 2026, month: 9, day: 3, hour: 14, minute: 45 });
    expect(parts.dayKey).toBe('thu');
  });

  it('names local days and calendar ranges', () => {
    expect(toLocalDateString(new Date('2026-09-03T22:30:00Z'), SKOPJE)).toBe('2026-09-04');
    expect(dayKeyForLocalDate('2026-09-08')).toBe('tue');
    expect(eachLocalDate('2026-09-03', '2026-09-06')).toEqual([
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
    ]);
  });

  it('keeps a late-evening UTC instant on the correct local day', () => {
    // 23:30 UTC is already tomorrow in Skopje. Getting this wrong shows the
    // caller yesterday's availability.
    expect(toLocalDateString(new Date('2026-09-03T23:30:00Z'), SKOPJE)).toBe('2026-09-04');
  });
});

describe('speaking dates and times in Macedonian', () => {
  const far = new Date('2026-08-01T09:00:00Z'); // "now", far from the targets

  it('says a date the way a receptionist would', () => {
    // 8 September 2026 is a Tuesday — the phrasing from the spec.
    const instant = fromZonedWallClock(SKOPJE, 2026, 9, 8, 10, 30);
    expect(speakDate(instant, SKOPJE, 'mk', { now: far })).toBe('во вторник, осми септември');
  });

  it('says half past as "и половина", never as digits', () => {
    const instant = fromZonedWallClock(SKOPJE, 2026, 9, 8, 10, 30);
    expect(speakTime(instant, SKOPJE, 'mk')).toBe('во десет и половина наутро');
  });

  it('builds the full confirmation phrase', () => {
    const instant = fromZonedWallClock(SKOPJE, 2026, 9, 8, 10, 30);
    expect(speakDateTime(instant, SKOPJE, 'mk', { now: far })).toBe(
      'во вторник, осми септември, во десет и половина наутро',
    );
  });

  it('never emits ISO or bare digits for the date', () => {
    const instant = fromZonedWallClock(SKOPJE, 2026, 9, 3, 14, 0);
    const spoken = speakDateTime(instant, SKOPJE, 'mk', { now: far });
    expect(spoken).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(spoken).not.toMatch(/T\d{2}:\d{2}/);
    expect(spoken).toBe('во четврток, трети септември, во два часот попладне');
  });

  it('uses the afternoon form for 13:00-17:00', () => {
    const instant = fromZonedWallClock(SKOPJE, 2026, 9, 3, 15, 15);
    expect(speakTime(instant, SKOPJE, 'mk')).toBe('во три и петнаесет попладне');
  });

  it('inflects ordinals past twenty', () => {
    const twentyFirst = fromZonedWallClock(SKOPJE, 2026, 9, 21, 9, 0);
    const thirtieth = fromZonedWallClock(SKOPJE, 2026, 9, 30, 9, 0);
    expect(speakDate(twentyFirst, SKOPJE, 'mk', { now: far })).toContain('дваесет и први');
    expect(speakDate(thirtieth, SKOPJE, 'mk', { now: far })).toContain('триесетти');
  });

  it('prefers "утре" when the date is tomorrow', () => {
    const now = fromZonedWallClock(SKOPJE, 2026, 9, 3, 9, 0);
    const tomorrow = fromZonedWallClock(SKOPJE, 2026, 9, 4, 11, 0);
    expect(speakDate(tomorrow, SKOPJE, 'mk', { now })).toBe('утре');
    expect(speakDateTime(tomorrow, SKOPJE, 'mk', { now })).toBe('утре, во единаесет часот наутро');
  });

  it('speaks durations', () => {
    expect(speakDuration(45, 'mk')).toBe('45 минути');
    expect(speakDuration(60, 'mk')).toBe('еден час');
  });
});

describe('speaking in the other two languages', () => {
  const far = new Date('2026-08-01T09:00:00Z');
  const instant = fromZonedWallClock(SKOPJE, 2026, 9, 8, 10, 30);

  it('formats English naturally', () => {
    expect(speakDateTime(instant, SKOPJE, 'en', { now: far })).toBe(
      'on Tuesday, September 8th, at 10:30 am',
    );
  });

  it('formats Albanian, with the part of day the confirmation needs', () => {
    // Verified through real Azure TTS and STT by `verify:albanian`.
    expect(speakDateTime(instant, SKOPJE, 'sq', { now: far })).toBe(
      'të martën, 8 shtator, në orën 10 e gjysmë në mëngjes',
    );
  });
});

describe('Albanian phrasing', () => {
  /**
   * Verified against real sq-AL speech with `verify:albanian`: these exact
   * strings round-tripped through Azure TTS and STT at 100% word accuracy.
   */
  it('says an afternoon slot with a part of day, not a bare hour', () => {
    // 14:30 Skopje. Without the suffix this was "në orën 2 e gjysmë", which
    // does not say whether it is 2am or 2pm — on a booking confirmation,
    // exactly the wrong thing to make someone infer.
    const instant = new Date('2026-09-04T12:30:00.000Z');
    expect(speakTime(instant, SKOPJE, 'sq')).toBe('në orën 2 e gjysmë pasdite');
  });

  it('marks morning and evening too', () => {
    expect(speakTime(new Date('2026-09-04T07:00:00.000Z'), SKOPJE, 'sq')).toBe(
      'në orën 9 në mëngjes',
    );
    expect(speakTime(new Date('2026-09-04T17:00:00.000Z'), SKOPJE, 'sq')).toBe(
      'në orën 7 në mbrëmje',
    );
  });

  it('names the weekday and month for a date further out', () => {
    const instant = new Date('2026-09-04T07:00:00.000Z');
    const far = new Date('2026-08-20T09:00:00.000Z');
    expect(speakDate(instant, SKOPJE, 'sq', { now: far })).toBe('të premten, 4 shtator');
  });

  it('uses the relative word for tomorrow', () => {
    const now = new Date('2026-09-03T09:00:00.000Z');
    const instant = new Date('2026-09-04T07:00:00.000Z');
    expect(speakDate(instant, SKOPJE, 'sq', { now })).toBe('nesër');
  });

  it('phrases a duration', () => {
    expect(speakDuration(30, 'sq')).toBe('30 minuta');
    expect(speakDuration(60, 'sq')).toBe('një orë');
  });
});

describe('reading a phone number back', () => {
  it('groups a Macedonian mobile in threes, digit by digit', () => {
    expect(speakPhoneNumber('070123456', 'mk')).toBe(
      'нула седум нула, еден два три, четири пет шест',
    );
  });

  it('keeps the country code as its own group', () => {
    expect(speakPhoneNumber('+38970123456', 'mk')).toBe(
      'плус, три осум девет, седум нула еден, два три четири, пет шест',
    );
  });

  it('never strands a single digit at the end', () => {
    /**
     * "…четири пет шест, седум" sounds like a correction rather than part of
     * the number — the caller hears a stumble and starts again.
     */
    const groups = groupPhoneDigits('0701234567');
    expect(groups.at(-1)!.length).toBeGreaterThan(1);
  });

  it('speaks the same digits in Albanian and English', () => {
    expect(speakPhoneNumber('070123456', 'sq')).toBe('zero shtatë zero, një dy tre, katër pesë gjashtë');
    expect(speakPhoneNumber('070123456', 'en')).toBe('zero seven zero, one two three, four five six');
  });
});
