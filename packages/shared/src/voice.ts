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
  /**
   * How long the line may be quiet before the agent checks the caller is
   * still there.
   *
   * Measured from the moment the agent stops *speaking*, not from when the
   * model finished generating — a caller listening to a reply has not gone
   * quiet. Tuned by ear alongside the segmentation timeout, because the two
   * compound: a caller who pauses to think spends the segmentation timeout
   * before their turn even ends.
   */
  repromptAfterMs: z.number().int().min(2000).max(30_000).default(8000),
  /** Reprompts before offering a callback and ending the call cleanly. */
  maxReprompts: z.number().int().min(1).max(5).default(2),
  /**
   * How hard to bias recognition towards the business's own vocabulary.
   *
   * **Defaults to 0 — OFF — because it was measured and it is actively
   * harmful on mk-MK.** Azure's documented range is 0.0-2.0; 0 disables it.
   *
   * The 119-phrase clinic list truncated recognition at the first list entry
   * it matched. "Добар ден, се јавивте во Дентал Охрид. Како можам да ви
   * помогнам?" came back as "Добар ден." — an entry in the list — at
   * confidence 0.19 against 0.83 with no list. Three utterances, same result.
   *
   * Two things make this a disable rather than a retune:
   *   - The weight does nothing. 0.5, 1.0, 1.5 and 2.0 produce byte-identical
   *     output, so `setWeight` is inert here and there is no value to tune to.
   *   - Nothing ever beat the baseline. The best any configuration managed was
   *     +0.00 — identical text, identical confidence.
   *
   * What truncates is a large list of short generic phrases: the 102 entries of
   * 1-2 words cost -0.58 to -0.63 on their own, while the 17 entries of 3+
   * words were harmless. It is volume combined with shortness rather than
   * shortness alone — a 9-entry list of just staff and service names did not
   * truncate anything. But it did not help either: +0.00 even on "Сакам термин
   * кај доктор Ана Смилевска…", the exact utterance a name list exists for.
   *
   * So there is no setting worth shipping — the safe configurations are
   * worthless and the substantial ones are destructive.
   * `pnpm --filter @frontly/api sweep:phrases` re-measures it; worth re-running
   * against sq-AL, en-US, or a future SDK before assuming this still holds.
   */
  phraseListWeight: z.number().min(0).max(2).default(0),
  /**
   * Below this recognition confidence the agent admits it did not catch it
   * rather than answering something the caller did not say.
   */
  minConfidence: z.number().min(0).max(1).default(0.4),
  /**
   * Low-confidence results met with SILENCE before the agent apologises at all.
   *
   * The apology is a pre-synthesized phrase, so it plays about 35 ms after the
   * result lands — faster than any human could have processed the sentence. A
   * caller who merely paused mid-thought (and so got finalized on a fragment,
   * which scores badly precisely because it is a fragment) hears the apology
   * while still talking. That derails them into a disfluent restart, which
   * finalizes as another fragment, which scores badly again. Self-sustaining,
   * and driven by timing rather than by any tunable delay.
   *
   * A caller mid-sentence who gets silence just keeps talking, and their next
   * result is a whole sentence that scores fine. So the first ones say nothing.
   */
  silentLowConfidenceTurns: z.number().int().min(0).max(5).default(2),
  /**
   * How long to wait before an apology, and — the point — a window in which the
   * caller resuming cancels it entirely.
   *
   * A delay alone would only move the collision later. What breaks the loop is
   * abandoning the apology when the caller turns out to have been mid-sentence.
   *
   * Generous on purpose. A caller working out which day suits them is the
   * NORMAL case on a booking call, not an error state, and 500 ms was still
   * tight enough to fire while someone was thinking. The cost of waiting too
   * long is a beat of silence; the cost of waiting too little is talking over
   * the caller, which is what starts the loop.
   */
  lowConfidenceHoldMs: z.number().int().min(0).max(8000).default(1500),
  /**
   * A caller who made any sound within this window counts as PRESENT, and the
   * agent will never hang up on a present caller for any reason.
   *
   * Bumped by speech energy, partials and finals — never by our own audio.
   */
  presenceWindowMs: z.number().int().min(1000).max(120_000).default(20_000),
  /**
   * Total caller silence — no energy at all, not merely nothing recognised —
   * before the line is accepted as abandoned and actually hung up.
   *
   * Deliberately long. Every other escape path now keeps listening instead of
   * ending the call, so this is the ONLY route to an agent-initiated hangup,
   * and it exists so a genuinely dead line does not stay billable forever.
   */
  abandonAfterMs: z.number().int().min(15_000).max(600_000).default(120_000),
  /**
   * How long to keep the line open after the agent has said goodbye.
   *
   * A concluded conversation is NOT an abandoned caller, and the two used to be
   * indistinguishable: the agent said "пријатен ден", nothing marked the call
   * as over, and the silence ladder reprompted the caller it had just dismissed
   * — farewell, dead air, then "сè уште сте тука?". Heard on a real call.
   *
   * Long enough for a "довидување" back, short enough that it does not read as
   * the agent having forgotten to hang up. This window is a courtesy, not a
   * question: whatever the caller does or does not say, the call ends when it
   * expires — unless they start a real turn, which cancels the close outright.
   */
  farewellGraceMs: z.number().int().min(0).max(10_000).default(2500),
  /**
   * Apologies actually SPOKEN before the agent stops retrying and offers a way
   * out. Silent holds do not count against it, so raising the silent budget
   * never shortens the caller's real number of chances.
   *
   * A caller the system genuinely cannot hear gets a graceful exit. Retrying
   * indefinitely is what turned a bad line into a loop.
   */
  maxLowConfidenceTurns: z.number().int().min(1).max(5).default(2),
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
