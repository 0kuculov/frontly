import {
  AnthropicLanguageModel,
  appointments,
  createTestDb,
  DEMO_IDS,
  getBusinessContext,
  loadRootEnv,
} from '@frontly/core';
import { DEFAULT_VOICE_CONFIG, type Language } from '@frontly/shared';
import { AzureSpeechProvider } from '../src/voice/azure.js';
import { CallSession } from '../src/voice/session.js';
import { FRAME_BYTES } from '../src/voice/types.js';

/**
 * A whole phone call, without a phone.
 *
 * Real Azure STT, real Claude, real Azure TTS, real mulaw frames paced at
 * 20 ms — everything the live pipeline does except Twilio carrying the bytes.
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

const provider = new AzureSpeechProvider({ key, region });
/** The caller gets a different voice from the agent. */
const CALLER_VOICE = { ...DEFAULT_VOICE_CONFIG.mk, voiceName: 'mk-MK-MarijaNeural' };

const CALLER_TURNS = [
  'Добар ден, сакам да закажам стоматолошки преглед.',
  'Утре наутро, ако може.',
  'Може ли во десет и половина?',
  'Се викам Марко Петровски. Да, потврдувам.',
];

const bold = (t: string) => `[1m${t}[0m`;
const dim = (t: string) => `[2m${t}[0m`;

async function synthesizeCaller(text: string): Promise<Buffer> {
  const tts = provider.createSynthesizer();
  const audio = await tts.synthesize({ text, language: 'mk' as Language, profile: CALLER_VOICE });
  tts.close();
  return audio;
}

async function main(): Promise<void> {
  const t = await createTestDb();
  const context = (await getBusinessContext(t.db, DEMO_IDS.business))!;

  let outboundFrames = 0;
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
    callSid: `CA_sim_${Date.now()}`,
    from: '+38970111222',
    logger: {
      info: (payload, message) => {
        if (message === 'turn complete') {
          console.log(
            dim(
              `             ⏱  first audio ${String(payload.toFirstAudioMs)}ms · ` +
                `turn ${String(payload.totalMs)}ms · tools ${JSON.stringify(payload.tools)}`,
            ),
          );
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

  await session.start();
  await waitForQuiet(() => outboundFrames);

  for (const text of CALLER_TURNS) {
    console.log(`${bold('  Пациент  ')} ${text}`);
    const audio = await synthesizeCaller(text);

    firstReplyFrameAt = 0;
    lastCallerFrameAt = 0;

    // Feed it exactly as Twilio would: 20 ms per frame, in real time.
    for (let offset = 0; offset < audio.length; offset += FRAME_BYTES) {
      session.onMedia(audio.subarray(offset, offset + FRAME_BYTES).toString('base64'));
      await sleep(20);
    }
    lastCallerFrameAt = Date.now();

    // Let the agent finish thinking, then finish speaking, before the next
    // caller turn. A real caller would not talk straight over the answer.
    await waitForQuiet(() => outboundFrames, 30_000, () => session.isThinking);
  }

  await session.stop('simulation complete');

  const booked = await t.db.select().from(appointments);
  console.log(bold('\n  Резултат'));
  console.log(`  термини:      ${booked.length}`);
  for (const row of booked) {
    console.log(`    ${row.customerName} · ${row.startsAt.toISOString()} · ${row.status}`);
  }
  if (latencies.length > 0) {
    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    console.log(
      bold('\n  Time to first audio (what the caller feels)') +
        `\n    per turn: ${latencies.map((l) => `${l}ms`).join(', ')}` +
        `\n    average : ${avg}ms\n`,
    );
  }

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
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = count();
  let quietFor = 0;

  while (Date.now() < deadline) {
    await sleep(100);
    const now = count();
    if (now === last && !thinking()) {
      quietFor += 100;
      if (quietFor >= 800) return;
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
