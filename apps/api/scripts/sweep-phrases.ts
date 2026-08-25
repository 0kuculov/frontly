import {
  createTestDb,
  DEMO_IDS,
  getBusinessContext,
  loadRootEnv,
  recognitionPhrases,
} from '@frontly/core';
import { DEFAULT_RECOGNITION_CONFIG, DEFAULT_VOICE_CONFIG, type Language } from '@frontly/shared';
import { AzureSpeechProvider } from '../src/voice/azure.js';
import { TELEPHONY_SAMPLE_RATE, type TranscriptionResult } from '../src/voice/types.js';

/**
 * Does the phrase list actually help, and at what weight and granularity?
 *
 * It did not. On the first real measurement the clinic's 119-phrase list took
 * the greeting from confidence 0.77 to 0.19 and truncated it to its first two
 * words — and both surviving fragments ("Добар ден", "Преглед") were literal
 * entries in the list. That is a decoder being constrained, not biased.
 *
 * "Phrase lists help telephony STT" is a docs claim; this measures it against
 * this account, this locale, this audio. Nothing here is worth believing
 * without numbers.
 *
 *   pnpm --filter @frontly/api sweep:phrases
 */

loadRootEnv();

const key = process.env.AZURE_SPEECH_KEY;
const region = process.env.AZURE_SPEECH_REGION ?? 'italynorth';
if (!key) {
  console.error('AZURE_SPEECH_KEY is not set.');
  process.exit(1);
}

const provider = new AzureSpeechProvider({ key, region });

/** The greeting that regressed, and the utterance that fragments into two turns. */
const UTTERANCES: { language: Language; label: string; text: string }[] = [
  { language: 'mk', label: 'greeting', text: 'Добар ден, се јавивте во Дентал Охрид. Како можам да ви помогнам?' },
  { language: 'mk', label: 'booking ', text: 'Добар ден, сакам да закажам стоматолошки преглед.' },
  // The case a phrase list exists for: a proper name a general model cannot know.
  { language: 'mk', label: 'name    ', text: 'Сакам термин кај доктор Ана Смилевска за чистење на забен камен.' },
];

async function synthesize(language: Language, text: string): Promise<Buffer> {
  const tts = provider.createSynthesizer();
  const audio = await tts.synthesize({
    text,
    language,
    profile: DEFAULT_VOICE_CONFIG[language],
    breakAfterFirstSentence: false,
  });
  tts.close();
  return audio;
}

async function recognize(
  audio: Buffer,
  language: Language,
  phrases: string[],
  weight: number,
): Promise<TranscriptionResult | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r?: TranscriptionResult) => {
      if (settled) return;
      settled = true;
      void stt.stop().then(() => resolve(r));
    };

    const stt = provider.createRecognizer({
      // Deliberately ONE locale: auto-detection is a separate variable and
      // mixing it in here would confound the result.
      languages: [language],
      ...(phrases.length > 0 ? { phrases } : {}),
      recognition: { ...DEFAULT_RECOGNITION_CONFIG, phraseListWeight: weight },
      handlers: {
        onFinal: (result) => finish(result),
        onError: () => finish(undefined),
      },
    });

    void stt.ready.then(() => {
      for (let offset = 0; offset < audio.length; offset += 160) {
        stt.write(audio.subarray(offset, offset + 160));
      }
      stt.write(Buffer.alloc(TELEPHONY_SAMPLE_RATE * 3, 0xff));
    });

    setTimeout(() => finish(undefined), 15_000);
  });
}

const words = (p: string) => p.trim().split(/\s+/).length;

async function main(): Promise<void> {
  const scratch = await createTestDb();
  const context = (await getBusinessContext(scratch.db, DEMO_IDS.business))!;
  const full = recognitionPhrases({ ...context, language: 'mk' });
  scratch.cleanup();

  // Granularity buckets, to test whether short generic words are the problem.
  // "преглед" and "добар ден" are exactly the fragments that survived.
  const longOnly = full.filter((p) => words(p) >= 3);
  const shortOnly = full.filter((p) => words(p) <= 2);
  // What the feature is actually for: the clinic's own proper nouns.
  const proper = new Set<string>();
  for (const svc of context.services) proper.add(svc.nameMk);
  for (const m of context.staff) {
    proper.add(m.name);
    for (const part of m.name.replace(/^д-р\s+/i, '').split(/\s+/)) if (part.length > 2) proper.add(part);
  }
  const names = [...proper];

  console.log(`\nAzure Speech — region ${region}`);
  console.log(`phrase list: ${full.length} total, ${longOnly.length} of 3+ words, ${shortOnly.length} of 1-2 words\n`);

  const configs: { label: string; phrases: string[]; weight: number }[] = [
    { label: 'no list (baseline)', phrases: [], weight: 0 },
    { label: `full ${full.length} @ 0.5`, phrases: full, weight: 0.5 },
    { label: `full ${full.length} @ 1.0`, phrases: full, weight: 1.0 },
    { label: `full ${full.length} @ 1.5`, phrases: full, weight: 1.5 },
    { label: `full ${full.length} @ 2.0`, phrases: full, weight: 2.0 },
    { label: `3+ words (${longOnly.length}) @ 1.0`, phrases: longOnly, weight: 1.0 },
    { label: `1-2 words (${shortOnly.length}) @ 1.0`, phrases: shortOnly, weight: 1.0 },
    { label: `3+ words (${longOnly.length}) @ 0.5`, phrases: longOnly, weight: 0.5 },
    // Staff and service names only — no generic booking chatter at all.
    { label: `names only (${names.length}) @ 1.0`, phrases: names, weight: 1.0 },
  ];

  for (const u of UTTERANCES) {
    console.log(`── [${u.label}] "${u.text}"`);
    const audio = await synthesize(u.language, u.text);
    let baseline = 0;

    for (const c of configs) {
      const r = await recognize(audio, u.language, c.phrases, c.weight);
      const conf = r?.confidence ?? 0;
      if (c.label.startsWith('no list')) baseline = conf;
      const delta = conf - baseline;
      const mark = c.label.startsWith('no list') ? '    ' : delta >= 0.02 ? ' ++ ' : delta <= -0.02 ? ' -- ' : '    ';
      console.log(
        `  ${mark}${c.label.padEnd(22)} conf ${conf.toFixed(2)}  ` +
          `${c.label.startsWith('no list') ? '     ' : (delta >= 0 ? '+' : '') + delta.toFixed(2)}  ` +
          `"${r?.text ?? 'NOTHING'}"`,
      );
    }
    console.log();
  }
}

main().catch((error: unknown) => {
  console.error('sweep failed:', error);
  process.exit(1);
});
