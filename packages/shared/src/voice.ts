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

/**
 * When Azure decides the caller has stopped talking, and when the caller is
 * allowed to stop the agent.
 *
 * Both are tuning knobs that can only really be set by ear on a real line, so
 * they live in per-business config rather than as constants: changing one is a
 * database write that the next call picks up, with no restart and no deploy.
 *
 * The default that shipped first was Azure's own 500 ms, which treats an
 * ordinary mid-sentence pause as end-of-turn. On a real call the agent talked
 * over the caller constantly.
 */
export const recognitionConfigSchema = z.object({
  /**
   * "Time"     — silence-based, and the only strategy that honours the
   *              timeout below. This is the tunable one.
   * "Default"  — the service's own strategy; the silence timeout is advisory.
   * "Semantic" — an AI model infers phrase boundaries from meaning rather
   *              than from silence. No parameters. Worth trying if tuning by
   *              ear does not converge, but unverified for mk-MK.
   */
  segmentationStrategy: z.enum(['Default', 'Time', 'Semantic']).default('Time'),
  /**
   * Silence inside a phrase before Azure calls it finished. Azure's range is
   * 100-5000 ms and its default is 500 ms, which is far too eager for someone
   * thinking about a date.
   */
  segmentationSilenceMs: z.number().int().min(100).max(5000).default(900),
  /**
   * Hard cap on a single phrase, so a caller who never pauses still gets
   * transcribed. Azure's range is 20000-70000 ms.
   */
  segmentationMaximumMs: z.number().int().min(20_000).max(70_000).default(30_000),
  /**
   * Sustained speech required before the agent stops talking.
   *
   * Azure raises speech-start on energy alone, so a cough or a door used to
   * cut the agent off mid-sentence. Barge-in now waits for either this much
   * continuous speech or a partial transcript with real words in it.
   */
  bargeInMs: z.number().int().min(0).max(3000).default(350),
  /** Characters in a partial transcript that count as actually talking. */
  bargeInMinChars: z.number().int().min(0).max(40).default(2),
});

export type RecognitionConfig = z.infer<typeof recognitionConfigSchema>;

export const DEFAULT_RECOGNITION_CONFIG: RecognitionConfig =
  recognitionConfigSchema.parse({});

export const voiceConfigSchema = z.object({
  mk: voiceProfileSchema,
  sq: voiceProfileSchema,
  en: voiceProfileSchema,
  /**
   * Optional so every row seeded before this existed still parses; absent
   * means the defaults above.
   */
  recognition: recognitionConfigSchema.optional(),
});

export type VoiceConfig = z.infer<typeof voiceConfigSchema>;

/** The recognition settings for a business, falling back to the defaults. */
export function recognitionFor(config: VoiceConfig | null | undefined): RecognitionConfig {
  const parsed = recognitionConfigSchema.safeParse(config?.recognition ?? {});
  return parsed.success ? parsed.data : DEFAULT_RECOGNITION_CONFIG;
}

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
