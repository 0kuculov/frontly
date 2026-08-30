import type { Language } from '@frontly/shared';

/**
 * Reading a phone number back to the caller.
 *
 * This exists because the prompt could not be trusted to do it, and the
 * evidence was in the prompt itself: it said "Бројот изговарај го по цифри"
 * — say the number digit by digit — and then gave a worked example in grouped
 * CARDINALS, "нула седумдесет, сто дваесет и три". The model followed the
 * example, not the instruction, and read 070 123 456 as "zero seventy, one
 * hundred twenty three, four hundred fifty six". A caller checking their own
 * number against that has to do arithmetic to agree with it.
 *
 * Same reasoning as `spellNumeralDates` and the markdown stripper: the prompt
 * is the request, a function is the floor. The confirmation gate is the one
 * place in the product where a mis-heard digit becomes a booking nobody keeps,
 * so it is the last place to rely on the model's goodwill.
 *
 * Pauses come from COMMAS, not from `<break/>`. Every reply is XML-escaped on
 * its way into SSML — `buildSsml` escapes the whole body — so a break tag
 * written here would be read out as literal angle brackets. A comma is honoured
 * by Azure as a short prosodic pause and survives escaping untouched.
 */

const DIGITS: Record<Language, readonly string[]> = {
  mk: ['нула', 'еден', 'два', 'три', 'четири', 'пет', 'шест', 'седум', 'осум', 'девет'],
  sq: ['zero', 'një', 'dy', 'tre', 'katër', 'pesë', 'gjashtë', 'shtatë', 'tetë', 'nëntë'],
  en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
};

const PLUS: Record<Language, string> = { mk: 'плус', sq: 'plus', en: 'plus' };

/**
 * Group a Balkan number the way a person says it.
 *
 * A Macedonian mobile is an operator prefix and then six digits — 070 123 456
 * — so threes are what a native speaker groups into, and what a caller listens
 * for when checking their own number. A country code is its own group because
 * it is a unit in the caller's head, not part of the rhythm that follows.
 */
export function groupPhoneDigits(phone: string): string[] {
  const trimmed = phone.trim();
  const international = trimmed.startsWith('+') || trimmed.startsWith('00');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 0) return [];

  const groups: string[] = [];
  let rest = digits;

  if (international) {
    // +389 and 00389 both mean the same country; 00 is not part of the code.
    if (trimmed.startsWith('00')) rest = rest.slice(2);
    const code = rest.slice(0, 3);
    groups.push(code);
    rest = rest.slice(3);
  }

  for (let i = 0; i < rest.length; i += 3) groups.push(rest.slice(i, i + 3));

  /**
   * Never leave a single digit stranded.
   *
   * "…, four five six, seven" sounds like a correction rather than part of the
   * number, and a caller hears it as the agent having stumbled. Fold it back.
   */
  if (groups.length > 1) {
    const last = groups[groups.length - 1]!;
    if (last.length === 1) {
      groups[groups.length - 2] += last;
      groups.pop();
    }
  }

  return groups;
}

/**
 * "+38970123456" -> "плус, три осум девет, нула седум нула, еден два три, четири пет шест"
 *
 * Digit by digit, grouped, with a comma between groups so the synthesizer
 * breathes where a person would.
 */
export function speakPhoneNumber(phone: string, language: Language): string {
  const words = DIGITS[language];
  const groups = groupPhoneDigits(phone);
  if (groups.length === 0) return '';

  const spoken = groups.map((group) =>
    [...group].map((d) => words[Number(d)] ?? d).join(' '),
  );

  return phone.trim().startsWith('+') || phone.trim().startsWith('00')
    ? `${PLUS[language]}, ${spoken.join(', ')}`
    : spoken.join(', ');
}

/**
 * The floor: any bare run of digits long enough to be a phone number, spoken
 * as digits instead of as a cardinal.
 *
 * Deliberately narrow at SIX digits and up. Shorter runs are prices, durations,
 * years and house numbers, all of which are read correctly as cardinals and
 * would sound absurd spelled out. A Macedonian mobile without its prefix is
 * six digits, which is the shortest thing that must never be read as a number.
 */
export function spellLongDigitRuns(text: string, language: Language): string {
  return text.replace(/(\+?\d[\d\s-]{5,}\d)/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 6 || digits.length > 15) return match;
    return speakPhoneNumber(match, language);
  });
}
