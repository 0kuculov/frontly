import {
  createTestDb,
  DEMO_IDS,
  getBusinessContext,
  loadRootEnv,
  recognitionPhrases,
} from '@frontly/core';
import { DEFAULT_VOICE_CONFIG, type Language } from '@frontly/shared';
import { AzureSpeechProvider } from '../src/voice/azure.js';
import { TELEPHONY_SAMPLE_RATE, type TranscriptionResult } from '../src/voice/types.js';

/**
 * Proves the speech pipeline without a phone.
 *
 * Synthesizes Macedonian to the exact bytes the carrier would carry, then feeds
 * those same bytes back into the recognizer. If a sentence survives the round
 * trip, both directions and the mulaw framing are correct — which is most of
 * what can go wrong before a real call.
 *
 *   pnpm --filter @frontly/api verify:azure
 */

loadRootEnv();

const key = process.env.AZURE_SPEECH_KEY;
const region = process.env.AZURE_SPEECH_REGION ?? 'italynorth';

if (!key) {
  console.error('AZURE_SPEECH_KEY is not set.');
  process.exit(1);
}

const provider = new AzureSpeechProvider({ key, region });

const PHRASES: { language: Language; text: string }[] = [
  { language: 'mk', text: 'Добар ден, се јавивте во Дентал Охрид. Како можам да ви помогнам?' },
  { language: 'en', text: 'Good afternoon, you have reached Dental Ohrid.' },
];

async function synthesize(language: Language, text: string, breakAfterFirst: boolean) {
  const tts = provider.createSynthesizer();
  const startedAt = Date.now();
  const audio = await tts.synthesize({
    text,
    language,
    profile: DEFAULT_VOICE_CONFIG[language],
    breakAfterFirstSentence: breakAfterFirst,
  });
  const ms = Date.now() - startedAt;
  tts.close();
  return { audio, ms };
}

async function recognize(
  audio: Buffer,
  languages: Language[],
  phrases?: string[],
): Promise<TranscriptionResult | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r?: TranscriptionResult) => {
      if (settled) return;
      settled = true;
      void stt.stop().then(() => resolve(r));
    };

    const stt = provider.createRecognizer({
      languages,
      ...(phrases ? { phrases } : {}),
      handlers: {
        onFinal: (result) => finish(result),
        onError: (error) => {
          console.error('   STT error:', error.message);
          finish(undefined);
        },
      },
    });

    // Wait for the recognizer, then feed it the way the carrier would: 20 ms frames.
    void stt.ready.then(() => {
      for (let offset = 0; offset < audio.length; offset += 160) {
        stt.write(audio.subarray(offset, offset + 160));
      }
      /**
       * Trailing silence so Azure decides the utterance has ended.
       *
       * Must comfortably exceed the segmentation timeout, which is now tuned
       * per business and can be raised well above the old default. Three
       * seconds leaves room for that; one second used to sit only just past
       * it, which is a test that passes until someone tunes by ear.
       */
      stt.write(Buffer.alloc(TELEPHONY_SAMPLE_RATE * 3, 0xff));
    });

    setTimeout(() => finish(undefined), 15_000);
  });
}

/**
 * Feed several utterances through ONE recognizer and collect every final.
 *
 * This is the shape that matters for language switching: a call is a single
 * recognizer connection, and `AtStart` decides once for the whole of it. Two
 * separate `recognize()` calls would each get their own detection and would
 * therefore both succeed — measuring nothing, and saying the opposite of what
 * a real call does.
 *
 * Silence between utterances, and after the last, because Azure's end-of-phrase
 * timer measures silence in the audio it RECEIVES; stop feeding and the final
 * never arrives.
 */
async function recognizeSequence(
  clips: { language: Language; audio: Buffer }[],
  languages: Language[],
  languageIdMode: 'AtStart' | 'Continuous',
): Promise<TranscriptionResult[]> {
  const heard: TranscriptionResult[] = [];

  const stt = provider.createRecognizer({
    languages,
    languageIdMode,
    handlers: {
      onFinal: (result) => heard.push(result),
      onError: (error) => console.error('   STT error:', error.message),
    },
  });

  await stt.ready;
  for (const clip of clips) {
    for (let offset = 0; offset < clip.audio.length; offset += 160) {
      stt.write(clip.audio.subarray(offset, offset + 160));
    }
    // Comfortably past the segmentation timeout, so this utterance finalizes
    // before the next one starts rather than merging into it.
    stt.write(Buffer.alloc(TELEPHONY_SAMPLE_RATE * 3, 0xff));
  }

  // Azure finalizes asynchronously; give the last one room to land.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await stt.stop();
  return heard;
}

/** The clinic's own vocabulary, loaded once from the seeded database. */
let vocabulary: Partial<Record<Language, string[]>> = {};

async function main(): Promise<void> {
  console.log(`\nAzure Speech — region ${region}\n`);

  const scratch = await createTestDb();
  const context = (await getBusinessContext(scratch.db, DEMO_IDS.business))!;
  vocabulary = {
    mk: recognitionPhrases({ ...context, language: 'mk' }),
    en: recognitionPhrases({ ...context, language: 'en' }),
  };
  /**
   * Say that it is OFF, because the number alone read as "119 phrases are
   * biasing this call" and that is exactly backwards.
   *
   * The list is still built from the clinic's record — it costs nothing and
   * the sweep needs it — but `phraseListWeight` defaults to 0 and the
   * recognizer skips attaching a grammar entirely at 0. Measured: the list
   * TRUNCATED Macedonian at the first entry it matched (0.19 against 0.83),
   * and no weight ever beat the baseline.
   */
  console.log(
    `phrase list: ${vocabulary.mk?.length ?? 0} phrases built for mk, NOT applied ` +
      '(phraseListWeight 0 — measured harmful; pnpm sweep:phrases re-measures)',
  );
  console.log();
  scratch.cleanup();

  for (const { language, text } of PHRASES) {
    const profile = DEFAULT_VOICE_CONFIG[language];
    console.log(`[${language}] ${profile.voiceName}  rate=${profile.rate}`);
    console.log(`   text : ${text}`);

    const { audio, ms } = await synthesize(language, text, true);
    const seconds = audio.length / TELEPHONY_SAMPLE_RATE;
    console.log(`   tts  : ${audio.length} bytes = ${seconds.toFixed(2)}s of mulaw in ${ms}ms`);

    // The carrier carries 160-byte frames; a partial frame means bad framing.
    console.log(`   frame: ${Math.floor(audio.length / 160)} full frames, remainder ${audio.length % 160}`);

    const heard = await recognize(audio, [language]);
    console.log(`   stt  : ${heard ? `"${heard.text}" (confidence ${heard.confidence.toFixed(2)})` : 'NOTHING RECOGNISED'}`);

    /**
     * No "+list" row here any more, because it was not measuring what it said.
     *
     * It called recognize() with the phrases but no recognition config, so the
     * run fell back to DEFAULT_RECOGNITION_CONFIG — weight 0 — and the
     * recognizer skipped the grammar. Both rows were therefore the baseline,
     * and the +0.00 delta it printed was two identical runs agreeing with each
     * other. Read as an A/B it says "the list is harmless", which is the
     * opposite of what the real sweep found.
     *
     * A/B belongs in the script that actually sets the weight:
     * `pnpm --filter @frontly/api sweep:phrases`.
     */
    console.log();
  }

  // Language detection, which is what picks mk vs sq vs en on the first turn.
  console.log('language auto-detection on the first utterance:');
  for (const { language, text } of PHRASES) {
    const { audio } = await synthesize(language, text, false);
    const heard = await recognize(audio, ['mk', 'sq', 'en']);
    const detected = heard?.detectedLanguage ?? '—';
    const verdict = detected === language ? 'OK' : `MISMATCH (wanted ${language})`;
    console.log(
      `   spoke ${language} -> detected ${detected}  ${verdict}` +
        (heard ? `  [heard "${heard.text.slice(0, 40)}" conf ${heard.confidence.toFixed(2)}]` : ''),
    );
  }
  console.log();

  await measureLanguageSwitch();
}

/**
 * What happens when a caller changes language mid-call.
 *
 * A judge on stage may well greet in English and carry on in Macedonian, and
 * "the session locks to the detected language" does not say whether the second
 * half is merely answered in the wrong language or cannot be transcribed at
 * all. Those are very different stage risks, so this measures rather than
 * reasons: two utterances, one recognizer, both modes, both orders.
 */
async function measureLanguageSwitch(): Promise<void> {
  console.log('language switching mid-call (two utterances, ONE recognizer):');
  console.log();

  const mk = await synthesize('mk', 'Сакам да закажам стоматолошки преглед за утре наутро.', false);
  const en = await synthesize('en', 'Actually, could we make that Thursday afternoon instead?', false);

  const orders: { label: string; clips: { language: Language; audio: Buffer }[] }[] = [
    { label: 'mk then en', clips: [{ language: 'mk', audio: mk.audio }, { language: 'en', audio: en.audio }] },
    { label: 'en then mk', clips: [{ language: 'en', audio: en.audio }, { language: 'mk', audio: mk.audio }] },
  ];

  for (const mode of ['AtStart', 'Continuous'] as const) {
    console.log(`  LanguageIdMode = ${mode}${mode === 'AtStart' ? '   (what ships)' : '   (NOT shipped)'}`);
    for (const { label, clips } of orders) {
      const heard = await recognizeSequence(clips, ['mk', 'sq', 'en'], mode);
      console.log(`    ${label}:`);
      if (heard.length === 0) {
        console.log('      nothing recognised at all');
        continue;
      }
      for (const [i, result] of heard.entries()) {
        const wanted = clips[i]?.language ?? '?';
        const detected = result.detectedLanguage ?? '—';
        const flag = detected === wanted ? 'OK ' : 'BAD';
        console.log(
          `      [${flag}] utterance ${i + 1} spoken ${wanted}, detected ${detected}, ` +
            `conf ${result.confidence.toFixed(2)}`,
        );
        console.log(`            "${result.text}"`);
      }
      // Fewer finals than clips means one utterance produced nothing at all,
      // which is the worst outcome and the easiest to miss in a table.
      if (heard.length < clips.length) {
        console.log(`      only ${heard.length} of ${clips.length} utterances finalized`);
      }
    }
    console.log();
  }
}

main().catch((error: unknown) => {
  console.error('verify-azure failed:', error);
  process.exit(1);
});
