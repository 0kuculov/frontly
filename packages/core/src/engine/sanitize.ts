import type { Language } from '@frontly/shared';
import { MK_MONTHS, mkOrdinalDay } from '../time/speech.js';
import { spellLongDigitRuns } from '../time/phone.js';

/**
 * Make a model reply safe to hand to a speech synthesizer.
 *
 * The prompt already forbids markdown and demands Cyrillic, and the model
 * mostly obeys — but "mostly" is not good enough when the failure mode is
 * Azure reading "ѕвездичка ѕвездичка Преглед" to a caller on stage. This is a
 * floor under the prompt rules, not a substitute for them.
 *
 * Two problems, both observed on real calls:
 *
 *  1. Markdown. Models reach for bullet lists whenever they enumerate options,
 *     which is what a receptionist does all day.
 *
 *  2. Latin-script tokens inside Macedonian. The model writes "на ime" instead
 *     of "на име". Confirmed audibly wrong through mk-MK-AleksandarNeural: the
 *     Latin token is mispronounced while surrounding Cyrillic reads correctly.
 */

/** Anything with a Cyrillic letter in it is being spoken as Macedonian. */
const CYRILLIC = /[Ѐ-ӿ]/;
const WORD = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;
const IS_LATIN_WORD = /^[A-Za-z][A-Za-z'’-]*$/;

/**
 * Latin spellings the model actually emits, and their Cyrillic form.
 *
 * Deliberately an allowlist and deliberately tiny: a blanket Latin→Cyrillic
 * pass would mangle proper nouns, brand names and loan words. Only add an
 * entry after seeing the word leak in a real transcript — a guessed entry can
 * corrupt correct output, which is worse than the mispronunciation it fixes.
 */
export const MK_LATIN_TRANSLITERATIONS: Record<string, string> = {
  ime: 'име',
};

export interface LatinLeak {
  /** Tokens left in Latin script because nothing in the allowlist matched. */
  unconverted: string[];
  /** Tokens the allowlist rewrote. */
  converted: string[];
  /** The full reply, so the leak can be read in context. */
  reply: string;
  language: Language;
}

export interface SanitizeOptions {
  /**
   * REQUIRED, and deliberately not defaulted.
   *
   * The Latin->Cyrillic pass only runs for `mk`, which is the only thing
   * keeping it away from Albanian — and the allowlist's single entry, `ime`,
   * is a real Albanian word ("my"). A forgotten language used to default to
   * `mk`, so an Albanian reply that mentioned the clinic by its Cyrillic name
   * would have had `ime` rewritten to `име` and read aloud in Cyrillic by an
   * Albanian voice. Measured, not theorised.
   *
   * Making it required means the next channel adapter cannot reintroduce that
   * by omission.
   */
  language: Language;
  /**
   * Proper nouns that must survive untouched — business name, staff names,
   * service names. Passed as whole strings; matching is per word.
   */
  protectedTerms?: readonly string[];
  /** Called when a Cyrillic reply contains Latin-script words. */
  onLatinLeak?: (leak: LatinLeak) => void;
}

export function sanitizeForSpeech(text: string, options: SanitizeOptions): string {
  // Only Macedonian replies get the script pass. An English or Albanian reply
  // is Latin by definition.
  const language = options.language;

  /**
   * Dates before markdown, deliberately.
   *
   * "1. јануари" at the start of a line is indistinguishable from a numbered
   * list item, and the list stripper would eat the day before the date pass
   * ever saw it.
   */
  const dated = language === 'mk' ? spellNumeralDates(text) : text;

  /**
   * Titles before anything else, because they are read wrong in every language
   * and the fix is the same shape as the date pass: expand the written form
   * into the spoken one.
   *
   * "д-р" is the written Macedonian abbreviation and Azure does not say
   * "доктор" for it — it reads the letters, hyphen included. The clinic's own
   * staff names are stored that way, so this fires on every booking that names
   * a doctor, which is most of them.
   *
   * Speech only. The SMS templates deliberately keep "д-р": a text is read
   * with the eyes, where the abbreviation is both clear and four characters
   * cheaper against a 70-character UCS-2 part.
   */
  const expanded = expandSpokenAbbreviations(dated, language);

  /**
   * Long digit runs, spoken as digits.
   *
   * After the date pass so a numeral date has already become words, and before
   * markdown so nothing has been rearranged around the digits yet.
   */
  const numbered = spellLongDigitRuns(expanded, language);

  const stripped = stripMarkdown(numbered);
  if (language !== 'mk' || !CYRILLIC.test(stripped)) return stripped;

  return fixLatinInCyrillic(stripped, language, options);
}

/**
 * "26 август" -> "дваесет и шести август".
 *
 * `speakDate` already produces the spelled form, and the prompt forbids
 * digits — but the model writes dates itself often enough, and a numeral is
 * read aloud as a cardinal ("дваесет и шест август"), which is wrong and
 * audibly so. Same reasoning as markdown and the Latin-script pass: the
 * prompt is the request, this is the floor.
 *
 * Deliberately narrow. Only a 1-2 digit number immediately before a month
 * name is touched, so prices, durations and phone numbers are left alone.
 */
/**
 * Written abbreviations that a synthesizer reads as letters.
 *
 * Kept per language rather than global: "др" is a Macedonian doctor and an
 * English "dr" is a different string entirely, and a shared table would
 * eventually rewrite an Albanian word that happens to match.
 */
const SPOKEN_ABBREVIATIONS: Record<Language, readonly (readonly [RegExp, string])[]> = {
  mk: [
    // д-р / др. / Д-Р, with or without the hyphen or full stop.
    [/(?<![\p{L}])[Дд][\s.-]?[Рр](?=[\s.]|$)\.?/gu, 'доктор'],
    // м-р, the other title a clinic writes down.
    [/(?<![\p{L}])[Мм][\s.-]?[Рр](?=[\s.]|$)\.?/gu, 'магистер'],
    [/(?<![\p{L}])ул\.(?=\s)/gu, 'улица'],
    [/(?<![\p{L}])бр\.(?=\s)/gu, 'број'],
  ],
  sq: [[/(?<![\p{L}])[Dd]r\.?(?=\s|$)/gu, 'doktor']],
  en: [[/(?<![\p{L}])[Dd]r\.?(?=\s|$)/gu, 'doctor']],
};

export function expandSpokenAbbreviations(text: string, language: Language): string {
  let out = text;
  for (const [pattern, replacement] of SPOKEN_ABBREVIATIONS[language]) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function spellNumeralDates(text: string): string {
  const months = MK_MONTHS.join('|');
  /**
   * Lookarounds rather than word boundaries: JavaScript defines \b over
   * [A-Za-z0-9_], so it does not fire around Cyrillic at all. Nothing numeric
   * immediately before the day, no further letters after the month.
   */
  const pattern = new RegExp(
    `(?<![\\d.,])(\\d{1,2})\\.?(\\s+)(${months})(?![\\p{L}])`,
    'giu',
  );
  return text.replace(pattern, (whole, digits: string, gap: string, month: string) => {
    const day = Number(digits);
    if (!Number.isInteger(day) || day < 1 || day > 31) return whole;
    return `${mkOrdinalDay(day)}${gap}${month}`;
  });
}

function stripMarkdown(text: string): string {
  return (
    text
      // Fenced and inline code — never speakable.
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      // Emphasis: **bold**, __bold__, then single-marker italics, but only
      // where the marker is not inside a word.
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(?<![\p{L}\p{N}])[*_]([^*_\n]+)[*_](?![\p{L}\p{N}])/gu, '$1')
      // Headings and blockquotes.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      // List markers, bulleted and numbered.
      .replace(/^[ \t]*[-*•·]\s+/gm, '')
      .replace(/^[ \t]*\d+[.)]\s+/gm, '')
      // Links: keep the label, drop the target.
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Any stray markers the passes above did not pair up.
      .replace(/[*_`]/g, '')
      // A spoken reply is one continuous utterance.
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  );
}

function fixLatinInCyrillic(
  text: string,
  language: Language,
  options: SanitizeOptions,
): string {
  const protectedWords = buildProtectedWordSet(options.protectedTerms ?? []);
  const converted: string[] = [];
  const unconverted: string[] = [];

  const result = text.replace(WORD, (word) => {
    if (!IS_LATIN_WORD.test(word)) return word;

    // A proper noun keeps its script, whatever the allowlist says.
    if (protectedWords.has(word.toLowerCase())) return word;

    const replacement = MK_LATIN_TRANSLITERATIONS[word.toLowerCase()];
    if (replacement === undefined) {
      unconverted.push(word);
      return word;
    }

    converted.push(word);
    return matchCapitalisation(word, replacement);
  });

  if ((converted.length > 0 || unconverted.length > 0) && options.onLatinLeak) {
    // Logged even when everything was converted: the prompt is supposed to
    // prevent this, so a rising count means the prompt rule is decaying.
    options.onLatinLeak({ converted, unconverted, reply: text, language });
  }

  return result;
}

function buildProtectedWordSet(terms: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const term of terms) {
    for (const match of term.matchAll(WORD)) {
      const word = match[0].toLowerCase();
      // One-letter fragments would protect far too much.
      if (word.length > 1) set.add(word);
    }
  }
  return set;
}

/** "Ime" -> "Име", "IME" -> "ИМЕ", "ime" -> "име". */
function matchCapitalisation(source: string, replacement: string): string {
  if (source === source.toUpperCase() && source.length > 1) return replacement.toUpperCase();
  if (source[0] === source[0]?.toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * Every proper noun in a business's data, for `protectedTerms`.
 *
 * Service names in English are genuinely Latin ("Dental check-up"), and a
 * clinic may well be branded in Latin script — none of that should be touched.
 */
export function protectedTermsFor(input: {
  business: { name: string };
  services?: readonly { nameMk: string; nameSq: string | null; nameEn: string | null }[];
  staff?: readonly { name: string }[];
}): string[] {
  const terms: string[] = [input.business.name];
  for (const service of input.services ?? []) {
    terms.push(service.nameMk);
    if (service.nameSq) terms.push(service.nameSq);
    if (service.nameEn) terms.push(service.nameEn);
  }
  for (const member of input.staff ?? []) terms.push(member.name);
  return terms;
}
