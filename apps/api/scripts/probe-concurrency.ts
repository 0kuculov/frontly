import { loadRootEnv } from '@frontly/core';
import type { Language } from '@frontly/shared';
import { AzureSpeechProvider } from '../src/voice/azure.js';
import { MULAW_SILENCE } from '../src/voice/audio.js';
import { FRAME_BYTES } from '../src/voice/types.js';

/**
 * How many callers can this Azure resource actually hear at once?
 *
 *   pnpm --filter @frontly/api probe:concurrency
 *
 * The load test turned up `websocket error code: 4429` — "the number of
 * parallel requests exceeded the number of allowed concurrent transcriptions"
 * — on a five-call run, and a ceiling that low is a deployment fact worth
 * knowing precisely rather than as an anecdote. Every other number in this
 * repo describes how *well* a call goes; this one decides how many there can
 * be, and no amount of tuning gets past it.
 *
 * Recognizers only: TTS has its own separate quota, and the error named
 * transcriptions.
 */

loadRootEnv();

const key = process.env.AZURE_SPEECH_KEY;
const region = process.env.AZURE_SPEECH_REGION ?? 'italynorth';
if (!key) {
  console.error('Needs AZURE_SPEECH_KEY.');
  process.exit(1);
}

const MAX = Number(process.env.PROBE_MAX ?? 8);
const provider = new AzureSpeechProvider({ key, region });
const SILENCE = Buffer.alloc(FRAME_BYTES, MULAW_SILENCE);

/**
 * One recognizer, fed real silence for a couple of seconds.
 *
 * Silence rather than speech on purpose: the question is how many sessions the
 * service will hold open, not what it transcribes, and silence keeps the probe
 * cheap and its result unambiguous.
 */
async function openRecognizer(index: number): Promise<{ ok: boolean; error?: string }> {
  let failure: string | undefined;

  const recognizer = provider.createRecognizer({
    languages: ['mk'] as Language[],
    handlers: {
      onFinal: () => {},
      onError: (error: Error) => {
        failure ??= String(error);
      },
    },
  });
  void index;

  try {
    await recognizer.ready;
    const until = Date.now() + 2500;
    while (Date.now() < until) {
      recognizer.write(SILENCE);
      await sleep(20);
    }
  } catch (error) {
    failure ??= String(error);
  } finally {
    await recognizer.stop().catch(() => {});
  }

  return failure ? { ok: false, error: failure } : { ok: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log(`\n  Azure ${region} — how many simultaneous recognizers hold?\n`);
  console.log('  concurrent   opened   refused   verdict');
  console.log('  ' + '-'.repeat(62));

  let ceiling = 0;

  for (let n = 1; n <= MAX; n++) {
    const results = await Promise.all(Array.from({ length: n }, (_, i) => openRecognizer(i)));
    const opened = results.filter((r) => r.ok).length;
    const refused = results.length - opened;
    const throttled = results.some((r) => r.error?.includes('4429'));

    console.log(
      `  ${String(n).padStart(9)}   ${String(opened).padStart(6)}   ${String(refused).padStart(7)}   ` +
        (refused === 0 ? 'ok' : throttled ? 'THROTTLED (4429)' : 'failed'),
    );

    if (refused === 0) ceiling = n;
    else {
      const first = results.find((r) => !r.ok);
      if (first?.error) console.log(`             ${first.error.slice(0, 120)}`);
      break;
    }

    // Sessions are released asynchronously; crowding the next round straight
    // after a teardown measures the teardown, not the limit.
    await sleep(8000);
  }

  console.log('\n  ' + '-'.repeat(62));
  console.log(`  Highest concurrency with no refusal: ${ceiling}`);
  console.log(
    `\n  That is the number of simultaneous CALLERS this Speech resource can\n` +
      `  serve. Every call holds one recognizer open for its whole duration,\n` +
      `  so this is a hard ceiling on the product, not a tuning parameter.\n`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
