import { toZonedParts, type DailySummary, type DueAppointment } from '@frontly/core';
import type { Language } from '@frontly/shared';

/**
 * What the follow-up messages say.
 *
 * Deliberately NOT run through `sanitizeForSpeech`. That pass exists because
 * Azure reads a bare numeral as a cardinal — "26 август" comes out as
 * "дваесет и шест август" — so spoken dates have to be spelled out. An SMS is
 * read with the eyes, where "27.08 во 14:00" is clearer and shorter than
 * "дваесет и седми август", and shortness is not cosmetic here: a message
 * that crosses 160 GSM-7 characters is billed and delivered as two.
 *
 * Cyrillic costs more than that. GSM-7 does not cover it, so a Macedonian SMS
 * is UCS-2 at **70 characters per part** — which is why every template below
 * is terse, and why `partsFor()` exists to say out loud how many parts a
 * message will cost rather than discovering it on the bill.
 */

const DAY_NAMES: Record<Language, Record<string, string>> = {
  mk: {
    mon: 'понеделник',
    tue: 'вторник',
    wed: 'среда',
    thu: 'четврток',
    fri: 'петок',
    sat: 'сабота',
    sun: 'недела',
  },
  sq: {
    mon: 'e hënë',
    tue: 'e martë',
    wed: 'e mërkurë',
    thu: 'e enjte',
    fri: 'e premte',
    sat: 'e shtunë',
    sun: 'e diel',
  },
  en: {
    mon: 'Monday',
    tue: 'Tuesday',
    wed: 'Wednesday',
    thu: 'Thursday',
    fri: 'Friday',
    sat: 'Saturday',
    sun: 'Sunday',
  },
};

/**
 * "вторник 27.08 во 14:00" — short, unambiguous, and read not spoken.
 *
 * `withDay: false` drops the weekday, which is the last thing given up when a
 * message will not fit one part: the date is unambiguous on its own, and a
 * second SMS costs more than the convenience is worth.
 */
export function formatWhen(
  instant: Date,
  timeZone: string,
  language: Language,
  withDay = true,
): string {
  const p = toZonedParts(instant, timeZone);
  const day = withDay ? `${DAY_NAMES[language][p.dayKey] ?? ''} ` : '';
  const date = `${pad(p.day)}.${pad(p.month)}`;
  const time = `${pad(p.hour)}:${pad(p.minute)}`;

  if (language === 'en') return `${day}${date} at ${time}`;
  if (language === 'sq') return `${day}${date} në ${time}`;
  return `${day}${date} во ${time}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Which language to write in.
 *
 * The business's first configured language, not the caller's detected one:
 * detection is per call and a reminder goes out a day later, by which time
 * the only durable signal is what the clinic actually operates in. Getting
 * this wrong is a mild embarrassment; guessing from a stale call is worse.
 */
export function messageLanguage(languages: string[]): Language {
  const first = languages[0];
  return first === 'sq' || first === 'en' ? first : 'mk';
}

/**
 * The confirmation, composed to fit ONE part rather than written and hoped for.
 *
 * This was measured, not guessed. The previous wording cost two parts in both
 * languages that matter:
 *
 *   mk  79 chars UCS-2 → 2 parts
 *   sq 118 chars UCS-2 → 2 parts
 *   en 111 chars GSM-7 → 1 part
 *
 * Albanian was the worse of the two and the reason a fixed string cannot be
 * trusted here: `ë` and lowercase `ç` are NOT in GSM-7, so Albanian is UCS-2 at
 * **70 characters per part** exactly like Cyrillic — but the Albanian template
 * was the longest of the three, written as though it had 160 to spend. English
 * really does get 160 and is the only one that ever fit.
 *
 * At the rate Telnyx actually charged for a Macedonian mobile ($0.118/part,
 * from the invoice, not a rate card) that second part cost more than carrying
 * the entire phone call that produced it.
 *
 * So the message degrades in a defined order instead of being tuned to the
 * length of "Дентал Охрид":
 *
 *   1. clinic, when, staff        — everything
 *   2. drop the staff name        — the reminder already omits it
 *   3. drop the weekday           — the date says it unambiguously
 *
 * Tuning the wording to one clinic would have worked for this demo and broken
 * for the first customer with a longer name; the service name is gone from all
 * three because the patient chose it thirty seconds ago and it is the least
 * useful word in the message.
 */
export function confirmationText(appointment: DueAppointment, language: Language): string {
  const candidates = [
    compose(appointment, language, { staff: true, day: true }),
    compose(appointment, language, { staff: false, day: true }),
    compose(appointment, language, { staff: false, day: false }),
  ];

  // The last one is sent even if it still overflows: a clinic name long enough
  // to break it is a real case, and `partsFor()` logs what it actually cost.
  return candidates.find((text) => partsFor(text).parts === 1) ?? candidates.at(-1)!;
}

function compose(
  appointment: DueAppointment,
  language: Language,
  include: { staff: boolean; day: boolean },
): string {
  const when = formatWhen(appointment.startsAt, appointment.timezone, language, include.day);
  const name = appointment.businessName;

  if (language === 'en') {
    const who = include.staff ? `, with ${appointment.staffName}` : '';
    return `Confirmed: ${name}, ${when}${who}.`;
  }
  if (language === 'sq') {
    const who = include.staff ? `, ${appointment.staffName}` : '';
    return `Konfirmuar: ${name}, ${when}${who}.`;
  }
  const who = include.staff ? `, ${appointment.staffName}` : '';
  return `Потврдено: ${name}, ${when}${who}.`;
}

/**
 * The reminder drops the staff name; the confirmation keeps it.
 *
 * Not a style choice — a measurement. With the doctor included, the Macedonian
 * reminder came to 71 UCS-2 characters, one over the 70-character single-part
 * limit, and so cost and delivered as two messages. The patient was already
 * told who they are seeing when they booked; the reminder's job is the time.
 *
 * A long clinic name can still push this to two parts, which is why
 * `partsFor()` is logged on every send rather than assumed here.
 */
export function reminderText(appointment: DueAppointment, language: Language): string {
  const when = formatWhen(appointment.startsAt, appointment.timezone, language);
  if (language === 'en') return `Reminder: ${appointment.businessName}, ${when}.`;
  if (language === 'sq') return `Kujtesë: ${appointment.businessName}, ${when}.`;
  return `Потсетник: ${appointment.businessName}, ${when}.`;
}

/**
 * The owner's 20:00 message.
 *
 * Numbers first, because that is what gets read on a phone screen between
 * patients, and tomorrow's diary after it. Capped at a handful of entries: a
 * clinic with a full day would otherwise get a six-part SMS, and the point is
 * a glance, not a report — the dashboard is where the full day lives.
 */
export function dailySummaryText(
  summary: DailySummary,
  language: Language,
  maxListed = 5,
): string {
  const listed = summary.tomorrow.slice(0, maxListed);
  const overflow = summary.tomorrow.length - listed.length;

  const lines = listed.map((a) => {
    const p = toZonedParts(a.startsAt, summary.timezone);
    return `${pad(p.hour)}:${pad(p.minute)} ${a.customerName}`;
  });

  if (language === 'en') {
    const head = `${summary.businessName}: ${summary.conversations} calls today, ${summary.booked} booked, ${summary.transferred} for you.`;
    const body = lines.length > 0 ? ` Tomorrow: ${lines.join(', ')}` : ' Nothing booked tomorrow.';
    return head + body + (overflow > 0 ? ` +${overflow} more.` : '');
  }
  if (language === 'sq') {
    const head = `${summary.businessName}: ${summary.conversations} telefonata sot, ${summary.booked} të rezervuara, ${summary.transferred} për ju.`;
    const body = lines.length > 0 ? ` Nesër: ${lines.join(', ')}` : ' Nesër asnjë term.';
    return head + body + (overflow > 0 ? ` +${overflow} të tjera.` : '');
  }

  const head = `${summary.businessName}: ${summary.conversations} повици денес, ${summary.booked} закажани, ${summary.transferred} за вас.`;
  const body = lines.length > 0 ? ` Утре: ${lines.join(', ')}` : ' Утре нема закажани.';
  return head + body + (overflow > 0 ? ` +${overflow} уште.` : '');
}

/**
 * How many SMS parts this message costs.
 *
 * Any character outside GSM-7 forces the whole message to UCS-2, so a single
 * Cyrillic letter takes the limit from 160 to 70 — and one stray "ќ" in an
 * otherwise English template silently more than doubles the bill. Logged on
 * every send so that shows up in a log line rather than an invoice.
 */
export function partsFor(text: string): { encoding: 'GSM-7' | 'UCS-2'; parts: number } {
  // The GSM 03.38 basic set, plus the extension characters that cost two.
  const gsm7 =
    /^[A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\r\n^{}\\[~\]|€]*$/;
  if (gsm7.test(text)) {
    const single = 160;
    const multi = 153;
    return { encoding: 'GSM-7', parts: text.length <= single ? 1 : Math.ceil(text.length / multi) };
  }
  const single = 70;
  const multi = 67;
  // UCS-2 counts code units, so an emoji outside the BMP costs two.
  const units = [...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  return { encoding: 'UCS-2', parts: units <= single ? 1 : Math.ceil(units / multi) };
}
