import {
  createTestDb,
  DEMO_IDS,
  getBusinessContext,
  loadRootEnv,
  speakDateTime,
  speakDuration,
} from '@frontly/core';
import { DEFAULT_VOICE_CONFIG, type Language } from '@frontly/shared';
import { AzureSpeechProvider } from '../src/voice/azure.js';
import { TELEPHONY_SAMPLE_RATE, type TranscriptionResult } from '../src/voice/types.js';

/**
 * Is Albanian demo-grade, or only present?
 *
 *   pnpm --filter @frontly/api verify:albanian
 *
 * "Macedonian and Albanian" is a much larger market claim than Macedonian
 * alone, and it is the kind of claim one person in the room can disprove by
 * listening. So this measures the same things the Macedonian pipeline was
 * measured on — round-trip accuracy, confidence, and whether the date and
 * time phrasing survives being spoken — rather than checking that the API
 * returns a 200.
 *
 * Word accuracy is reported alongside confidence because they fail
 * differently: Azure returns a healthy score for a fluent transcription of the
 * wrong words, which is exactly how the phrase-list truncation hid for so
 * long (0.87 on a sentence cut in half).
 */

loadRootEnv();

const key = process.env.AZURE_SPEECH_KEY;
const region = process.env.AZURE_SPEECH_REGION ?? 'italynorth';

if (!key) {
  console.error('AZURE_SPEECH_KEY is not set.');
  process.exit(1);
}

const provider = new AzureSpeechProvider({ key, region });

const bold = (t: string) => `[1m${t}[0m`;
const dim = (t: string) => `[2m${t}[0m`;
const green = (t: string) => `[32m${t}[0m`;
const yellow = (t: string) => `[33m${t}[0m`;
const red = (t: string) => `[31m${t}[0m`;

/** What a caller and the agent actually say on a booking call, in Albanian. */
const CONVERSATION: string[] = [
  'Mirë se erdhët në Dental Ohrid. Si mund t’ju ndihmoj?',
  'Dëshiroj të rezervoj një kontroll dentar për nesër.',
  'Sigurisht. Cila ditë ju përshtatet më shumë?',
  'Të enjten pasdite, nëse është e mundur.',
  'Kam të lirë në orën dhjetë e gjysmë dhe në orën katërmbëdhjetë.',
  'Emri im është Marko Petrovski dhe numri im është shtatë zero një dy tre.',
];

async function synthesize(text: string, language: Language) {
  const tts = provider.createSynthesizer();
  const startedAt = Date.now();
  const audio = await tts.synthesize({
    text,
    language,
    profile: DEFAULT_VOICE_CONFIG[language],
    breakAfterFirstSentence: false,
  });
  const ms = Date.now() - startedAt;
  tts.close();
  return { audio, ms };
}

async function recognize(
  audio: Buffer,
  languages: Language[],
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
      handlers: {
        onFinal: (result) => finish(result),
        onError: (error) => {
          console.error('   STT error:', error.message);
          finish(undefined);
        },
      },
    });

    void stt.ready.then(() => {
      for (let offset = 0; offset < audio.length; offset += 160) {
        stt.write(audio.subarray(offset, offset + 160));
      }
      // Comfortably past the segmentation timeout.
      stt.write(Buffer.alloc(TELEPHONY_SAMPLE_RATE * 3, 0xff));
    });

    setTimeout(() => finish(undefined), 20_000);
  });
}

/**
 * Word accuracy, ignoring punctuation and case.
 *
 * Albanian diacritics are NOT folded away: "ë" and "e" are different letters
 * and treating them as the same would flatter every result — "mire" for
 * "mirë" is a mispronunciation waiting to happen, not a match.
 */
function wordAccuracy(expected: string, heard: string): number {
  const tokens = (s: string) =>
    s
      .toLowerCase()
      .replace(/[.,!?;:()"]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

  const want = tokens(expected);
  const got = new Set(tokens(heard));
  if (want.length === 0) return 0;
  return want.filter((w) => got.has(w)).length / want.length;
}

function verdictFor(accuracy: number, confidence: number): string {
  if (accuracy >= 0.85 && confidence >= 0.7) return green('demo-grade');
  if (accuracy >= 0.65) return yellow('usable, audibly imperfect');
  return red('NOT demo-grade');
}

async function main(): Promise<void> {
  console.log(`\n${bold('Albanian (sq-AL)')} — region ${region}\n`);
  console.log(`voice: ${DEFAULT_VOICE_CONFIG.sq.voiceName}  rate=${DEFAULT_VOICE_CONFIG.sq.rate}\n`);

  const accuracies: number[] = [];
  const confidences: number[] = [];

  console.log(bold('  round trip: synthesized Albanian, recognised back'));
  for (const text of CONVERSATION) {
    const { audio, ms } = await synthesize(text, 'sq');
    const seconds = audio.length / TELEPHONY_SAMPLE_RATE;
    const heard = await recognize(audio, ['sq']);

    console.log(`\n   said : ${text}`);
    console.log(dim(`   tts  : ${seconds.toFixed(2)}s of mulaw in ${ms}ms`));

    if (!heard) {
      console.log(red('   heard: NOTHING RECOGNISED'));
      accuracies.push(0);
      confidences.push(0);
      continue;
    }

    const accuracy = wordAccuracy(text, heard.text);
    accuracies.push(accuracy);
    confidences.push(heard.confidence);
    console.log(`   heard: ${heard.text}`);
    console.log(
      `   ${(accuracy * 100).toFixed(0)}% of words, confidence ${heard.confidence.toFixed(2)}  ` +
        verdictFor(accuracy, heard.confidence),
    );
  }

  /**
   * The phrasing the agent generates itself, spoken and heard back.
   *
   * This is where a language goes wrong quietly: the sentences above are
   * hand-written and correct by construction, while these come out of
   * `speakDateTime`, whose Albanian table is marked provisional in the source.
   */
  console.log(`\n${bold('  generated date and time phrasing')}`);
  const scratch = await createTestDb();
  const context = (await getBusinessContext(scratch.db, DEMO_IDS.business))!;
  const tz = context.business.timezone;
  const now = new Date();

  /**
   * Real slot times, aligned to the hour and half hour.
   *
   * An arbitrary "now + 26h" produces 10:07, which no booking ever offers —
   * judging the phrasing on that would condemn a sentence the agent never
   * says. Services are 30, 45 and 60 minutes, so :00 and :30 are what a
   * caller actually hears.
   */
  const slot = (daysAhead: number, hour: number, minute: number): Date => {
    const d = new Date(now.getTime() + daysAhead * 86_400_000);
    d.setHours(hour, minute, 0, 0);
    return d;
  };

  const instants = [slot(1, 10, 30), slot(3, 9, 0), slot(9, 14, 30)];

  for (const instant of instants) {
    const phrase = speakDateTime(instant, tz, 'sq', { now });
    const { audio } = await synthesize(phrase, 'sq');
    const heard = await recognize(audio, ['sq']);
    const accuracy = heard ? wordAccuracy(phrase, heard.text) : 0;

    console.log(`\n   generated : ${phrase}`);
    console.log(`   heard     : ${heard?.text ?? red('NOTHING')}`);
    if (heard) {
      console.log(
        `   ${(accuracy * 100).toFixed(0)}% of words, confidence ${heard.confidence.toFixed(2)}`,
      );
    }
  }

  console.log(`\n   duration phrasing: ${speakDuration(30, 'sq')} / ${speakDuration(60, 'sq')}`);
  scratch.cleanup();

  /**
   * Detection, which is what actually picks Albanian on a real call. A caller
   * whose language is never detected is answered in Macedonian no matter how
   * good the Albanian pipeline is.
   */
  console.log(`\n${bold('  language detection among mk / sq / en')}`);
  for (const text of CONVERSATION.slice(0, 3)) {
    const { audio } = await synthesize(text, 'sq');
    const heard = await recognize(audio, ['mk', 'sq', 'en']);
    const detected = heard?.detectedLanguage ?? '—';
    const ok = detected === 'sq';
    console.log(
      `   ${ok ? green('OK ') : red('BAD')} detected ${detected}  ${dim(text.slice(0, 46))}`,
    );
    if (heard && !ok) console.log(dim(`        heard as: ${heard.text.slice(0, 70)}`));
  }

  /**
   * Is the confidence score informative at all?
   *
   * Every Albanian utterance above came back at exactly the same score, which
   * is the signature of a number that is not being computed. It matters
   * because `minConfidence` is the ONLY thing standing between a
   * mistranscription and the agent acting on it — if the score cannot move,
   * that defence is blind in Albanian and the apology path can never fire.
   *
   * The probe: feed the sq recogniser audio that is definitely not Albanian.
   * A real score collapses. An inert one does not.
   */
  console.log(`
${bold('  is confidence informative in sq-AL?')}`);
  const mkAudio = await synthesize('Добар ден, сакам да закажам стоматолошки преглед.', 'mk');
  const misheard = await recognize(mkAudio.audio, ['sq']);
  console.log(`   Macedonian audio into an sq-AL recogniser:`);
  console.log(`   heard      : ${misheard?.text ?? red('NOTHING')}`);
  console.log(
    `   confidence : ${misheard ? misheard.confidence.toFixed(2) : '—'}` +
      dim(`   (Albanian speech scored ${confidences[0]?.toFixed(2) ?? '?'})`),
  );

  const spread = confidences.length > 1
    ? Math.max(...confidences) - Math.min(...confidences)
    : 0;
  console.log(
    `   spread across ${confidences.length} real utterances: ${spread.toFixed(2)}` +
      (spread < 0.02
        ? red('  <- does not move; treat sq confidence as UNINFORMATIVE')
        : green('  <- moves, so it carries information')),
  );

  const meanAccuracy = accuracies.reduce((a, b) => a + b, 0) / (accuracies.length || 1);
  const meanConfidence = confidences.reduce((a, b) => a + b, 0) / (confidences.length || 1);

  console.log(`\n${bold('  summary')}`);
  console.log(`   mean word accuracy : ${(meanAccuracy * 100).toFixed(0)}%`);
  console.log(`   mean confidence    : ${meanConfidence.toFixed(2)}`);
  console.log(`   verdict            : ${verdictFor(meanAccuracy, meanConfidence)}\n`);
}

main().catch((error: unknown) => {
  console.error('verify-albanian failed:', error);
  process.exit(1);
});
