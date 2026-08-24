import type { Language } from '@frontly/shared';

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
  language?: Language;
  /**
   * Proper nouns that must survive untouched — business name, staff names,
   * service names. Passed as whole strings; matching is per word.
   */
  protectedTerms?: readonly string[];
  /** Called when a Cyrillic reply contains Latin-script words. */
  onLatinLeak?: (leak: LatinLeak) => void;
}

export function sanitizeForSpeech(text: string, options: SanitizeOptions = {}): string {
  const stripped = stripMarkdown(text);

  // Only Macedonian replies get the script pass. An English or Albanian reply
  // is Latin by definition.
  const language = options.language ?? 'mk';
  if (language !== 'mk' || !CYRILLIC.test(stripped)) return stripped;

  return fixLatinInCyrillic(stripped, language, options);
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
