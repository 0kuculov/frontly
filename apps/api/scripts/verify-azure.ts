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
  console.log(`phrase list: ${vocabulary.mk?.length ?? 0} phrases for mk
`);
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
     * The same audio again with the clinic's vocabulary biased in.
     *
     * Side by side because "phrase lists help telephony STT" is a claim worth
     * checking against this account, this locale and this audio rather than
     * being taken from a docs page.
     */
    const biased = await recognize(audio, [language], vocabulary[language] ?? []);
    if (biased) {
      const delta = biased.confidence - (heard?.confidence ?? 0);
      console.log(
        `   +list: "${biased.text}" (confidence ${biased.confidence.toFixed(2)}, ` +
          `${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`,
      );
    }
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
}

main().catch((error: unknown) => {
  console.error('verify-azure failed:', error);
  process.exit(1);
});
