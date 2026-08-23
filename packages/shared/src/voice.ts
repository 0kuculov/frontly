import { z } from 'zod';
import { AZURE_LOCALE, type Language } from './language.js';

/**
 * Per-language voice settings. Stored as a JSON column on `businesses` so a
 * clinic can be re-voiced from the dashboard without a deploy — deliberately
 * NOT hardcoded constants in the TTS adapter.
 */
export const voiceProfileSchema = z.object({
  /** Azure neural voice name, e.g. "mk-MK-AleksandarNeural". */
  voiceName: z.string().min(1),
  /** SSML prosody rate, e.g. "-6%". Slower reads clearer over a phone line. */
  rate: z.string().regex(/^[+-]?\d{1,3}%$/, 'Expected a percentage like "-6%"').default('0%'),
  /** SSML prosody pitch, e.g. "+2%". */
  pitch: z.string().regex(/^[+-]?\d{1,3}%$/, 'Expected a percentage like "+2%"').default('0%'),
  /**
   * Silence inserted between the greeting and the first question, in ms.
   * Without it the caller talks over the question on nearly every call.
   */
  greetingBreakMs: z.number().int().min(0).max(2000).default(300),
});

export type VoiceProfile = z.infer<typeof voiceProfileSchema>;

export const voiceConfigSchema = z.object({
  mk: voiceProfileSchema,
  sq: voiceProfileSchema,
  en: voiceProfileSchema,
});

export type VoiceConfig = z.infer<typeof voiceConfigSchema>;

/**
 * Tested defaults. mk-MK settings are the ones chosen on real calls; sq-AL is
 * provisional and gets verified against real Albanian speech in Phase 8.
 */
export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  mk: { voiceName: 'mk-MK-AleksandarNeural', rate: '-6%', pitch: '0%', greetingBreakMs: 300 },
  sq: { voiceName: 'sq-AL-IlirNeural', rate: '-6%', pitch: '0%', greetingBreakMs: 300 },
  en: { voiceName: 'en-US-AvaMultilingualNeural', rate: '0%', pitch: '0%', greetingBreakMs: 300 },
};

/** Alternative voices per language, offered in the Settings dropdown (Phase 4). */
export const AVAILABLE_VOICES: Record<Language, readonly string[]> = {
  mk: ['mk-MK-AleksandarNeural', 'mk-MK-MarijaNeural'],
  sq: ['sq-AL-IlirNeural', 'sq-AL-AnilaNeural'],
  en: ['en-US-AvaMultilingualNeural', 'en-US-AndrewMultilingualNeural', 'en-US-JennyNeural'],
};

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeSsml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);
}

/**
 * Build the SSML document handed to Azure TTS.
 *
 * Everything Frontly speaks goes through here — we never call the synthesizer
 * with plain text, because plain text silently drops the prosody rate that
 * makes the agent intelligible over an 8kHz phone line.
 *
 * `breakAfterFirstSentence` inserts the configured pause after the first
 * sentence, which is how the greeting gets separated from the question.
 */
export function buildSsml(
  text: string,
  language: Language,
  profile: VoiceProfile,
  options: { breakAfterFirstSentence?: boolean } = {},
): string {
  const locale = AZURE_LOCALE[language];
  const body = options.breakAfterFirstSentence
    ? withBreakAfterFirstSentence(text, profile.greetingBreakMs)
    : escapeSsml(text);

  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
    `<voice name="${escapeSsml(profile.voiceName)}">` +
    `<prosody rate="${profile.rate}" pitch="${profile.pitch}">${body}</prosody>` +
    `</voice></speak>`
  );
}

function withBreakAfterFirstSentence(text: string, breakMs: number): string {
  const match = /^(.*?[.!?])\s+(.*)$/s.exec(text.trim());
  if (!match || breakMs <= 0) return escapeSsml(text);
  return `${escapeSsml(match[1]!)}<break time="${breakMs}ms"/>${escapeSsml(match[2]!)}`;
}
