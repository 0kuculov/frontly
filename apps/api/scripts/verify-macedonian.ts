import {
  createTestDb,
  DEMO_IDS,
  getBusinessContext,
  loadRootEnv,
  sanitizeForSpeech,
  speakDateTime,
  speakDuration,
  speakPhoneNumber,
  renderGreeting,
} from '@frontly/core';
import { DEFAULT_VOICE_CONFIG, type Language } from '@frontly/shared';
import { AzureSpeechProvider } from '../src/voice/azure.js';
import { cacheablePhrases } from '../src/voice/phrases.js';
import { TELEPHONY_SAMPLE_RATE, type TranscriptionResult } from '../src/voice/types.js';

/**
 * The listening pass: every Macedonian string this product can say, spoken by
 * the real voice and heard back by the real recognizer.
 *
 *   pnpm --filter @frontly/api verify:macedonian
 *
 * WHAT THIS CAN AND CANNOT TELL YOU.
 *
 * It cannot hear. A round trip proves a string is INTELLIGIBLE — Azure's own
 * recognizer got the words back — which is exactly the failure mode that
 * matters for abbreviations and digit runs, where the synthesizer says
 * something other than the word written down. It cannot catch "understood, but
 * sounds slightly foreign to someone from Skopje". That still needs a person.
 *
 * Word accuracy is reported next to confidence because they fail differently:
 * Azure returns a healthy score for a fluent transcription of the WRONG words,
 * which is how the phrase-list truncation hid for so long at 0.87 on a
 * sentence cut in half.
 */

loadRootEnv();

const key = process.env.AZURE_SPEECH_KEY;
const region = process.env.AZURE_SPEECH_REGION ?? 'italynorth';
if (!key) {
  console.error('AZURE_SPEECH_KEY is not set.');
  process.exit(1);
}

const provider = new AzureSpeechProvider({ key, region });
const LANG: Language = 'mk';

const bold = (t: string) => `[1m${t}[0m`;
const dim = (t: string) => `[2m${t}[0m`;
const green = (t: string) => `[32m${t}[0m`;
const yellow = (t: string) => `[33m${t}[0m`;
const red = (t: string) => `[31m${t}[0m`;

async function synthesize(text: string) {
  const tts = provider.createSynthesizer();
  const audio = await tts.synthesize({
    text,
    language: LANG,
    profile: DEFAULT_VOICE_CONFIG[LANG],
    breakAfterFirstSentence: false,
  });
  tts.close();
  return audio;
}

async function recognize(audio: Buffer): Promise<TranscriptionResult | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r?: TranscriptionResult) => {
      if (settled) return;
      settled = true;
      void stt.stop().then(() => resolve(r));
    };

    const stt = provider.createRecognizer({
      languages: [LANG],
      handlers: { onFinal: (r) => done(r), onError: () => done(undefined) },
    });

    void stt.ready.then(() => {
      const frame = TELEPHONY_SAMPLE_RATE / 50;
      for (let i = 0; i < audio.length; i += frame) stt.write(audio.subarray(i, i + frame));
      // Trailing silence, or the recognizer waits for more speech forever.
      const silence = Buffer.alloc(frame, 0xff);
      for (let i = 0; i < 60; i++) stt.write(silence);
    });

    setTimeout(() => done(undefined), 20_000);
  });
}

/**
 * Azure's recognizer writes spoken numbers back as NUMERALS.
 *
 * This is inverse text normalisation, and it made the first run of this script
 * lie about the single most important string in the product: the number
 * readback was synthesized correctly as "нула седум нула, еден два три…" and
 * came back transcribed as "070123456", which a naive word comparison scored
 * at 36% and flagged as broken. It was perfect.
 *
 * So both sides are folded to digits before comparing. Getting this wrong in
 * the other direction would have been worse — it would have sent someone off
 * to fix a pronunciation bug that does not exist.
 */
/**
 * Lookarounds, never `\b`.
 *
 * JavaScript defines `\b` over [A-Za-z0-9_], so it does not fire around
 * Cyrillic AT ALL — every pattern here silently matched nothing on the first
 * attempt, and the fold appeared to do its job while doing none of it. The
 * same trap is already recorded against `spellNumeralDates`; it caught me
 * again one file over.
 *
 * Longest first: "единаесет" contains "еден", and "десет" contains... nothing,
 * but "триесет" would be eaten by "три" if three ran first.
 */
const NUMBER_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<!\p{L})четиринаесет(?!\p{L})/gu, '14'],
  [/(?<!\p{L})тринаесет(?!\p{L})/gu, '13'],
  [/(?<!\p{L})дванаесет(?!\p{L})/gu, '12'],
  [/(?<!\p{L})единаесет(?!\p{L})/gu, '11'],
  [/(?<!\p{L})триесет(?!\p{L})/gu, '30'],
  [/(?<!\p{L})десет(?!\p{L})/gu, '10'],
  [/(?<!\p{L})нула(?!\p{L})/gu, '0'],
  [/(?<!\p{L})(?:еден|една)(?!\p{L})/gu, '1'],
  [/(?<!\p{L})(?:два|две)(?!\p{L})/gu, '2'],
  [/(?<!\p{L})три(?!\p{L})/gu, '3'],
  [/(?<!\p{L})четири(?!\p{L})/gu, '4'],
  [/(?<!\p{L})пет(?!\p{L})/gu, '5'],
  [/(?<!\p{L})шест(?!\p{L})/gu, '6'],
  [/(?<!\p{L})седум(?!\p{L})/gu, '7'],
  [/(?<!\p{L})осум(?!\p{L})/gu, '8'],
  [/(?<!\p{L})девет(?!\p{L})/gu, '9'],
];

function foldNumbers(text: string): string {
  let out = ` ${text.toLowerCase()} `;
  for (const [pattern, digit] of NUMBER_WORDS) out = out.replace(pattern, ` ${digit} `);
  // Join runs of single digits so "0 7 0 1 2 3" reads as one number, which is
  // how the recognizer returns it.
  return out.replace(/(?<=\d)\s+(?=\d)/g, '');
}

/**
 * Punctuation first, THEN the number fold.
 *
 * The other order leaves the comma between groups in place, so the expected
 * side folds to "070, 123, 456" while the recognizer returns "070123456" —
 * and the digit-joining step never fires across the comma. Same class of
 * mistake as the ITN one above: a measurement artefact that reads as a defect.
 */
const tokens = (s: string) =>
  foldNumbers(s.replace(/[.,!?;:()"„”]/g, ' ')).split(/\s+/).filter(Boolean);

function wordAccuracy(expected: string, heard: string): number {
  const want = tokens(expected);
  const got = new Set(tokens(heard));
  if (want.length === 0) return 1;
  return want.filter((w) => got.has(w)).length / want.length;
}

interface Case {
  group: string;
  /** What the engine produces, BEFORE the speech sanitiser runs. */
  raw: string;
  /** Words that must survive; empty means judge the whole string. */
  mustHear?: string[];
}

async function main(): Promise<void> {
  const t = await createTestDb({ seed: true });
  const context = (await getBusinessContext(t.db, DEMO_IDS.business))!;
  const tz = context.business.timezone;
  const now = new Date('2026-09-08T07:00:00.000Z');
  const slot = new Date('2026-09-09T08:30:00.000Z');

  const cases: Case[] = [
    // --- the fixed lines, straight from the phrase table ------------------
    { group: 'fixed', raw: renderGreeting(context.business) },
    ...cacheablePhrases(LANG).map((raw) => ({ group: 'fixed', raw })),

    // --- generated time and duration --------------------------------------
    { group: 'generated', raw: `Слободно е ${speakDateTime(slot, tz, LANG, { now })}.` },
    { group: 'generated', raw: `Прегледот трае ${speakDuration(30, LANG)}.` },

    // --- the two things this pass exists for -------------------------------
    {
      group: 'title',
      raw: `Закажано е кај ${context.staff[0]!.name}.`,
      mustHear: ['доктор'],
    },
    {
      group: 'phone',
      raw: `Ве запишав на бројот ${speakPhoneNumber('070123456', LANG)}. Точно?`,
      // Folded to digits before comparison, so this is really "070123456".
      mustHear: ['070123456'],
    },
    {
      group: 'phone',
      // The floor: a bare numeric number the model wrote itself.
      raw: 'Бројот е 070123456.',
      mustHear: ['070123456'],
    },
    {
      group: 'name',
      raw: `Добредојдовте во ${context.business.name}.`,
      mustHear: ['охрид'],
    },
  ];

  console.log(bold(`\n  Macedonian listening pass — ${DEFAULT_VOICE_CONFIG[LANG].voiceName}`));
  console.log(dim(`  Azure ${region} · synthesize, then hear it back\n`));

  const suspects: string[] = [];
  let lastGroup = '';

  for (const testCase of cases) {
    if (testCase.group !== lastGroup) {
      console.log(bold(`\n  ${testCase.group}`));
      lastGroup = testCase.group;
    }

    // Exactly what a call would synthesize — the sanitiser is part of the path.
    const spoken = sanitizeForSpeech(testCase.raw, { language: LANG });
    const heard = await recognize(await synthesize(spoken));

    if (!heard) {
      console.log(`  ${red('NOTHING HEARD')}  ${spoken}`);
      suspects.push(spoken);
      continue;
    }

    const accuracy = wordAccuracy(spoken, heard.text);
    const heardTokens = tokens(heard.text);
    const missing = (testCase.mustHear ?? []).filter(
      (w) => !heardTokens.includes(foldNumbers(w).trim()),
    );

    const bad = missing.length > 0 || accuracy < 0.7;
    const mark = bad ? red('✗') : accuracy < 0.9 ? yellow('~') : green('✓');

    console.log(`  ${mark} ${(accuracy * 100).toFixed(0).padStart(3)}%  ${spoken}`);
    if (spoken !== testCase.raw) console.log(dim(`        was: ${testCase.raw}`));
    if (bad || accuracy < 0.9) console.log(dim(`        heard: ${heard.text}`));
    if (missing.length > 0) {
      console.log(red(`        MISSING: ${missing.join(', ')}`));
      suspects.push(spoken);
    } else if (accuracy < 0.7) {
      suspects.push(spoken);
    }
  }

  console.log(bold('\n\n  Verdict\n'));
  if (suspects.length === 0) {
    console.log(green('  Every string came back intelligible.'));
  } else {
    console.log(red(`  ${suspects.length} string(s) to listen to yourself:`));
    for (const s of suspects) console.log(`    ${s}`);
  }
  console.log(
    dim(
      '\n  A round trip proves intelligibility, not naturalness. Anything above\n' +
        '  still needs an ear for whether it sounds like a person from Skopje.\n',
    ),
  );

  t.cleanup();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
