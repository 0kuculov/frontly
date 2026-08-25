import {
  AnthropicLanguageModel,
  appointments,
  conversations,
  createTestDb,
  DEMO_IDS,
  getBusinessContext,
  loadRootEnv,
} from '@frontly/core';
import { DEFAULT_VOICE_CONFIG, type Language } from '@frontly/shared';
import { AzureSpeechProvider } from '../src/voice/azure.js';
import { CallSession } from '../src/voice/session.js';
import { SpeechCache } from '../src/voice/speech-cache.js';
import { warmBusiness } from '../src/voice/warm.js';
import { MULAW_SILENCE } from '../src/voice/audio.js';
import { FRAME_BYTES } from '../src/voice/types.js';

/**
 * A whole phone call, without a phone.
 *
 * Real Azure STT, real Claude, real Azure TTS, real mulaw frames paced at
 * 20 ms — everything the live pipeline does except Telnyx carrying the bytes.
 * The caller is synthesized with a different voice so the recognizer is
 * hearing genuine speech rather than replayed text.
 *
 * The number it exists to print is time-to-first-audio: how long after the
 * caller stops talking before they hear anything back. That is the only
 * latency a caller actually perceives.
 *
 *   pnpm --filter @frontly/api simulate:call
 */

loadRootEnv();

const key = process.env.AZURE_SPEECH_KEY;
const region = process.env.AZURE_SPEECH_REGION ?? 'italynorth';
if (!key || !process.env.ANTHROPIC_API_KEY) {
  console.error('Needs AZURE_SPEECH_KEY and ANTHROPIC_API_KEY.');
  process.exit(1);
}

const azure = new AzureSpeechProvider({ key, region });

/**
 * Every string that actually reaches the synthesizer, and whether any Latin
 * survived `sanitizeForSpeech`.
 *
 * Checked here rather than on the model's reply because this is the last point
 * before the audio exists: a token that gets this far is a token the caller
 * hears spelled out letter by letter, or read in the wrong language.
 */
const spokenToAzure: { text: string; latin: string[] }[] = [];
const LATIN_TOKEN = /[A-Za-z][A-Za-z'-]*/g;

const provider: typeof azure = Object.create(azure) as typeof azure;
provider.createSynthesizer = () => {
  const inner = azure.createSynthesizer();
  return {
    close: () => inner.close(),
    synthesize: (request) => {
      if (request.language === 'mk') {
        const latin = request.text.match(LATIN_TOKEN) ?? [];
        spokenToAzure.push({ text: request.text, latin });
      }
      return inner.synthesize(request);
    },
  };
};
/** The caller gets a different voice from the agent. */
const CALLER_VOICE = { ...DEFAULT_VOICE_CONFIG.mk, voiceName: 'mk-MK-MarijaNeural' };

/**
 * How long the line must be quiet before the harness calls a turn finished.
 *
 * Must exceed the segmentation timeout: the agent cannot begin answering until
 * Azure has waited that long for the caller to continue, so a shorter
 * threshold declares the turn over before it has started and drops the next
 * caller line on top of the answer.
 */
const QUIET_MS = 1600;

const CALLER_TURNS = [
  'Добар ден, сакам да закажам стоматолошки преглед.',
  'Утре наутро, ако може.',
  'Може ли во десет и половина?',
  'Се викам Марко Петровски. Да, потврдувам.',
];

const bold = (t: string) => `[1m${t}[0m`;
const dim = (t: string) => `[2m${t}[0m`;

async function synthesizeCaller(text: string): Promise<Buffer> {
  // Straight to Azure, bypassing the recorder: this is the caller talking.
  const tts = azure.createSynthesizer();
  const audio = await tts.synthesize({ text, language: 'mk' as Language, profile: CALLER_VOICE });
  tts.close();
  return audio;
}

async function main(): Promise<void> {
  const t = await createTestDb();
  const context = (await getBusinessContext(t.db, DEMO_IDS.business))!;

  /**
   * Pre-synthesize the fixed lines, exactly as the server does at boot, so the
   * greeting the simulated caller hears comes out of the cache rather than out
   * of Azure. Warming through the recording provider on purpose: the fixed
   * phrases reach the synthesizer too, so the Latin check should see them.
   */
  const useCache = process.env.SIM_CACHE !== '0';
  const cache = new SpeechCache(provider);
  const warmed = useCache
    ? await warmBusiness(cache, context.business)
    : { warmed: 0, failed: 0 };

  let outboundFrames = 0;
  let firstFrameAt = 0;
  let lastCallerFrameAt = 0;
  let firstReplyFrameAt = 0;
  const latencies: number[] = [];

  const session = new CallSession({
    db: t.db,
    business: context.business,
    services: context.services,
    staff: context.staff,
    provider,
    model: new AnthropicLanguageModel(),
    callRef: `CA_sim_${Date.now()}`,
    from: '+38970111222',
    ...(useCache ? { cache } : {}),
    logger: {
      info: (payload, message) => {
        if (message === 'turn complete') {
          console.log(
            dim(
              `             ⏱  first audio ${String(payload.toFirstAudioMs)}ms · ` +
                `turn ${String(payload.totalMs)}ms · tools ${JSON.stringify(payload.tools)}`,
            ),
          );
        } else if (message === 'filler played') {
          console.log(dim(`             ~ filler: ${String(payload.text)}`));
        } else if (message === 'barge-in' || message === 'language locked') {
          console.log(dim(`             · ${message} ${JSON.stringify(payload.language ?? '')}`));
        }
      },
      warn: (payload, message) => console.log(dim(`             ! ${message} ${JSON.stringify(payload)}`)),
      error: (payload, message) => console.log(dim(`             ✕ ${message} ${JSON.stringify(payload)}`)),
    },
    onHangUp: () => {},
    sink: {
      sendFrame: () => {
        outboundFrames++;
        if (!firstFrameAt) firstFrameAt = Date.now();
        if (lastCallerFrameAt && !firstReplyFrameAt) {
          firstReplyFrameAt = Date.now();
          latencies.push(firstReplyFrameAt - lastCallerFrameAt);
        }
      },
      clear: () => {},
    },
  });

  console.log(bold(`\n  Симулиран повик — ${context.business.name}`));
  console.log(dim(`  Azure ${region} · ${new AnthropicLanguageModel().model}\n`));

  /**
   * A carrier never stops sending.
   *
   * Telnyx delivers a 20 ms frame every 20 ms for the whole call, silence
   * included — the caller not talking is still audio. This simulation used to
   * simply stop feeding between turns, and Azure's end-of-phrase timer, which
   * measures silence in the audio it receives, had nothing to measure. Under
   * the Time segmentation strategy that meant utterances were never finalized
   * at all: partials arrived, finals never did.
   *
   * So the pump runs for the entire call and caller speech is injected into
   * it, exactly as a real line behaves.
   */
  const SILENCE = Buffer.alloc(FRAME_BYTES, MULAW_SILENCE);
  let injected: Buffer[] = [];
  const pump = setInterval(() => {
    const frame = injected.shift() ?? SILENCE;
    session.onMedia(frame.toString('base64'));
  }, 20);

  const greetingRequestedAt = Date.now();
  await session.start();
  const greetingLatency = firstFrameAt ? firstFrameAt - greetingRequestedAt : undefined;
  await waitForQuiet(() => outboundFrames);

  for (const text of CALLER_TURNS) {
    console.log(`${bold('  Пациент  ')} ${text}`);
    const audio = await synthesizeCaller(text);

    firstReplyFrameAt = 0;
    lastCallerFrameAt = 0;

    // Hand the speech to the pump; it goes out at 20 ms per frame in place of
    // the silence that would otherwise be flowing.
    const frames: Buffer[] = [];
    for (let offset = 0; offset < audio.length; offset += FRAME_BYTES) {
      frames.push(audio.subarray(offset, offset + FRAME_BYTES));
    }
    // `injected = frames` aliases the array the pump drains, so the count has
    // to be read before it is emptied.
    const frameCount = frames.length;
    injected = frames;
    while (injected.length > 0) await sleep(20);
    console.log(dim(`             (fed ${frameCount} frames, then silence)`));
    lastCallerFrameAt = Date.now();

    // Let the agent finish thinking, then finish speaking, before the next
    // caller turn. A real caller would not talk straight over the answer.
    await waitForQuiet(() => outboundFrames, 30_000, () => session.isThinking);
  }

  clearInterval(pump);
  await session.stop('simulation complete');

  // The transcript is the artefact the Phase 4 dashboard reads, and the only
  // way to see why a turn did not book.
  const [conversation] = await t.db.select().from(conversations);
  console.log(bold('\n  Транскрипт'));
  for (const turn of conversation?.transcript ?? []) {
    const who = turn.role === 'customer' ? 'Пациент' : 'Фронтли';
    const tools = 'toolCalls' in turn && turn.toolCalls?.length
      ? dim(`  [${turn.toolCalls.map((c) => c.name).join(', ')}]`)
      : '';
    console.log(`    ${bold(who.padEnd(8))} ${turn.text}${tools}`);
  }

  const booked = await t.db.select().from(appointments);
  console.log(bold('\n  Резултат'));
  console.log(`  термини:      ${booked.length}`);
  for (const row of booked) {
    console.log(`    ${row.customerName} · ${row.startsAt.toISOString()} · ${row.status}`);
  }
  console.log(bold('\n  Greeting'));
  console.log(`  phrases pre-synthesized: ${warmed.warmed} (${warmed.failed} failed)`);
  console.log(
    `  connect -> first audio byte: ${greetingLatency === undefined ? 'n/a' : `${greetingLatency}ms`}`,
  );

  const leaked = spokenToAzure.filter((s) => s.latin.length > 0);
  console.log(bold('\n  Latin script reaching Azure'));
  console.log(`  Macedonian utterances synthesized: ${spokenToAzure.length}`);
  if (leaked.length === 0) {
    console.log('  no Latin tokens — sanitizeForSpeech held');
  } else {
    for (const row of leaked) {
      console.log(`    ${row.latin.join(', ')}  in: ${row.text}`);
    }
    console.log('  ^ these are read aloud in the wrong language, or spelled out.');
  }

  if (latencies.length > 0) {
    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    console.log(
      bold('\n  Time to first audio (what the caller feels)') +
        `\n    per turn: ${latencies.map((l) => `${l}ms`).join(', ')}` +
        `\n    average : ${avg}ms\n`,
    );
  }

  cache.close();
  t.cleanup();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve once the agent has stopped thinking and stopped speaking. */
async function waitForQuiet(
  count: () => number,
  timeoutMs = 20_000,
  thinking: () => boolean = () => false,
  quietMs = QUIET_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = count();
  let quietFor = 0;

  while (Date.now() < deadline) {
    await sleep(100);
    const now = count();
    if (now === last && !thinking()) {
      quietFor += 100;
      if (quietFor >= quietMs) return;
    } else {
      quietFor = 0;
      last = now;
    }
  }
}

main().catch((error: unknown) => {
  console.error('simulation failed:', error);
  process.exit(1);
});
