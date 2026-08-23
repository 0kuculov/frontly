import { z } from 'zod';

/**
 * The three languages Frontly speaks. Macedonian is the default everywhere:
 * if detection is uncertain, we fall back to `mk` rather than guessing.
 */
export const LANGUAGES = ['mk', 'sq', 'en'] as const;
export const languageSchema = z.enum(LANGUAGES);
export type Language = z.infer<typeof languageSchema>;

export const DEFAULT_LANGUAGE: Language = 'mk';

/** BCP-47 locales handed to Azure Speech (STT recognition + TTS synthesis). */
export const AZURE_LOCALE: Record<Language, string> = {
  mk: 'mk-MK',
  sq: 'sq-AL',
  en: 'en-US',
};

/** Language name in its own language — used by the chat widget picker. */
export const LANGUAGE_ENDONYM: Record<Language, string> = {
  mk: 'Македонски',
  sq: 'Shqip',
  en: 'English',
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * Narrow an arbitrary locale-ish string ("mk-MK", "sq", "en-GB") to a Language.
 * Returns undefined rather than defaulting, so callers decide what a miss means.
 */
export function parseLanguageTag(tag: string | null | undefined): Language | undefined {
  if (!tag) return undefined;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return isLanguage(primary) ? primary : undefined;
}
