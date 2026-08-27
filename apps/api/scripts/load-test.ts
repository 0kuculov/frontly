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
 * Five callers at once, on one instance.
 *
 *   pnpm --filter @frontly/api load:test
 *   LOAD_CALLS=8 pnpm --filter @frontly/api load:test
 *
 * WHAT THIS CAN AND CANNOT TELL YOU
 *
 * Simulated audio has misled this project twice on timing, and nothing here
 * fixes that: injected TTS carries its own trailing silence, so the numbers a
 * simulator prints for "how long until the caller hears something" are not the
 * caller's numbers. Those come from a real call and nowhere else.
 *
 * Three things it CAN answer honestly, all of which are about the machine
 * rather than the ear:
 *
 *  1. **Does the booking guard hold when callers race?** Every caller here
 *     asks for the SAME slot on the same day. The double-booking guard is a
 *     partial unique index in SQLite, not application logic, and the only way
 *     to see it work is to make several inserts collide for real. This is the
 *     measurement worth the runtime.
 *
 *  2. **Can one process keep the frames flowing?** A phone call is 50 frames a
 *     second in each direction, forever. If the event loop stalls under load
 *     the audio stutters — and unlike latency, frame pacing is real work being
 *     done on a real clock, so a simulator measures it truthfully. Jitter here
 *     is jitter on a live call.
 *
 *  3. **Does anything fall over?** Azure concurrency limits, model rate limits,
 *     a session that throws and takes its call with it.
 *
 * Everything runs in ONE process on purpose: that is how Render would serve
 * five simultaneous callers, so a leak or a stall shows up the way it would in
 * production rather than being spread across five machines.
 */

loadRootEnv();

const key = process.env.AZURE_SPEECH_KEY;
const region = process.env.AZURE_SPEECH_REGION ?? 'italynorth';
if (!key || !process.env.ANTHROPIC_API_KEY) {
  console.error('Needs AZURE_SPEECH_KEY and ANTHROPIC_API_KEY.');
  process.exit(1);
}

const CALLS = Number(process.env.LOAD_CALLS ?? 5);
const azure = new AzureSpeechProvider({ key, region });
const CALLER_VOICE = { ...DEFAULT_VOICE_CONFIG.mk, voiceName: 'mk-MK-MarijaNeural' };

/**
 * Every caller wants the same appointment.
 *
 * Deliberate: the clinic has two staff, so at most two of these can legally
 * be booked at 10:30 and the rest must be offered something else. A run where
 * everybody books is a broken guard, not a good day.
 */
const callerTurns = (name: string): string[] => [
  'Добар ден, сакам да закажам стоматолошки преглед.',
  'Утре наутро, ако може.',
  'Може ли во десет и половина?',
  `Се викам ${name}.`,
  /**
   * The fifth turn exists because of the confirmation gate.
   *
   * `book_appointment` refuses until the caller has heard their own name and
   * number read back and agreed. A four-turn script books nothing and reports
   * every call as "abandoned", which looks like a load failure and is really
   * a safety feature doing its job.
   */
  'Да, точно е. Закажете го.',
];

const bold = (t: string) => `[1m${t}[0m`;
const dim = (t: string) => `[2m${t}[0m`;

interface CallReport {
  index: number;
  name: string;
  turns: number;
  errors: string[];
  booked: boolean;
  outcome: string | undefined;
  /** Not the caller's latency. See the header. */
  replyMs: number[];
  pacing: PacingMeter;
}

async function synthesizeCaller(text: string): Promise<Buffer> {
  const tts = azure.createSynthesizer();
  try {
    return await tts.synthesize({ text, language: 'mk' as Language, profile: CALLER_VOICE });
  } finally {
    tts.close();
  }
}

/**
 * How late each 20ms tick actually fired.
 *
 * `setInterval(fn, 20)` promises no such thing under load; the gap between
 * scheduled and actual is exactly the audio glitch a caller would hear, and it
 * is the one number here that a simulation measures as truthfully as a real
 * call would.
 */
class PacingMeter {
  /**
   * One meter per call, and the readings pooled at the end.
   *
   * A single shared meter looked obvious and was wrong: five pumps tick into
   * it independently, so each one advanced a clock the other four were also
   * advancing and the arithmetic produced lateness of minus two minutes. The
   * gap only means anything measured against the pump that scheduled it.
   */
  private readonly lateness: number[] = [];
  private previous = 0;

  tick(now: number): void {
    // Gap between consecutive ticks of THIS pump, against the 20ms it asked
    // for. Interval drift accumulates, so comparing against a projected
    // absolute schedule would report the drift rather than the stall.
    if (this.previous !== 0) this.lateness.push(now - this.previous - 20);
    this.previous = now;
  }

  readings(): number[] {
    return this.lateness;
  }
}

function summarize(values: number[]): { count: number; p50: number; p95: number; worst: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), worst: sorted.at(-1) ?? 0 };
}

async function runCall(
  index: number,
  db: Awaited<ReturnType<typeof createTestDb>>['db'],
  context: Awaited<ReturnType<typeof getBusinessContext>>,
  cache: SpeechCache,
): Promise<CallReport> {
  const name = `Пациент ${index + 1}`;
  const meter = new PacingMeter();
  const report: CallReport = {
    index,
    name,
    turns: 0,
    errors: [],
    booked: false,
    outcome: undefined,
    replyMs: [],
    pacing: meter,
  };

  let outboundFrames = 0;
  let lastCallerFrameAt = 0;
  let firstReplyFrameAt = 0;

  const session = new CallSession({
    db,
    business: context!.business,
    services: context!.services,
    staff: context!.staff,
    provider: azure,
    model: new AnthropicLanguageModel(),
    callRef: `CA_load_${Date.now()}_${index}`,
    from: `+3897011100${index}`,
    cache,
    logger: {
      info: () => {},
      warn: (payload, message) => report.errors.push(`warn: ${message} ${JSON.stringify(payload)}`),
      error: (payload, message) => report.errors.push(`error: ${message} ${JSON.stringify(payload)}`),
    },
    onHangUp: () => {},
    sink: {
      sendFrame: () => {
        outboundFrames++;
        if (lastCallerFrameAt && !firstReplyFrameAt) {
          firstReplyFrameAt = Date.now();
          report.replyMs.push(firstReplyFrameAt - lastCallerFrameAt);
        }
      },
      clear: () => {},
    },
  });

  const SILENCE = Buffer.alloc(FRAME_BYTES, MULAW_SILENCE);
  let injected: Buffer[] = [];
  const pump = setInterval(() => {
    meter.tick(Date.now());
    const frame = injected.shift() ?? SILENCE;
    session.onMedia(frame.toString('base64'));
  }, 20);

  try {
    await session.start();
    await waitForQuiet(() => outboundFrames);

    // Each caller says their own name, so a booking can be traced back to the
    // call that made it rather than being one of five identical rows.
    for (const said of callerTurns(name)) {
      const audio = await synthesizeCaller(said);

      firstReplyFrameAt = 0;
      lastCallerFrameAt = 0;

      const frames: Buffer[] = [];
      for (let offset = 0; offset < audio.length; offset += FRAME_BYTES) {
        frames.push(audio.subarray(offset, offset + FRAME_BYTES));
      }
      injected = frames;
      while (injected.length > 0) await sleep(20);
      lastCallerFrameAt = Date.now();
      report.turns++;

      await waitForQuiet(() => outboundFrames, 40_000, () => session.isThinking);
    }
  } catch (error) {
    report.errors.push(`threw: ${String(error)}`);
  } finally {
    clearInterval(pump);
    await session.stop('load test complete').catch(() => {});
  }

  return report;
}

async function main(): Promise<void> {
  const t = await createTestDb({ seed: true });
  const context = await getBusinessContext(t.db, DEMO_IDS.business);
  const cache = new SpeechCache(azure);
  const meter = new PacingMeter();

  console.log(bold(`\n  ${CALLS} concurrent calls — ${context!.business.name}`));
  console.log(dim(`  Azure ${region} · ${new AnthropicLanguageModel().model}`));
  console.log(dim('  every caller asks for the same 10:30 slot, on purpose\n'));

  // Warmed once, shared by every session — exactly as the server does it, and
  // the reason five simultaneous greetings do not mean five Azure round trips.
  const warmed = await warmBusiness(cache, context!.business);
  console.log(dim(`  ${warmed.warmed} phrases pre-synthesized (${warmed.failed} failed)\n`));

  const memoryBefore = process.memoryUsage().heapUsed;
  const startedAt = Date.now();

  const reports = await Promise.all(
    Array.from({ length: CALLS }, (_, index) => runCall(index, t.db, context, cache)),
  );

  const wallMs = Date.now() - startedAt;
  const memoryAfter = process.memoryUsage().heapUsed;

  // --- what got booked ------------------------------------------------------

  const booked = await t.db.select().from(appointments);
  const rows = await t.db.select().from(conversations);

  console.log(bold('  Calls\n'));
  for (const report of reports) {
    const row = rows.find((r) => r.externalId.endsWith(`_${report.index}`));
    const mine = booked.find((b) => b.customerName?.includes(String(report.index + 1)));
    console.log(
      `    ${report.name.padEnd(12)} ${String(report.turns).padStart(2)} turns  ` +
        `${(row?.outcome ?? '—').padEnd(12)} ` +
        `${mine ? `booked ${mine.startsAt.toISOString().slice(11, 16)}` : 'no booking'}` +
        `${report.errors.length > 0 ? dim(`  (${report.errors.length} logged)`) : ''}`,
    );
  }

  // --- the guard ------------------------------------------------------------

  const slots = new Map<string, number>();
  for (const row of booked) {
    const slotKey = `${row.staffId}@${row.startsAt.toISOString()}`;
    slots.set(slotKey, (slots.get(slotKey) ?? 0) + 1);
  }
  const collisions = [...slots.entries()].filter(([, count]) => count > 1);

  console.log(bold('\n  Double-booking guard\n'));
  console.log(`    appointments created:        ${booked.length}`);
  console.log(`    distinct (staff, start):     ${slots.size}`);
  console.log(
    `    collisions:                  ${collisions.length}` +
      (collisions.length === 0
        ? dim('   ← the partial unique index held')
        : bold('   ← DOUBLE BOOKED')),
  );
  for (const row of booked) {
    console.log(
      dim(`      ${row.startsAt.toISOString().slice(11, 16)}  ${row.staffId}  ${row.customerName}`),
    );
  }

  /**
   * Losing the race is the CORRECT outcome, and it looks like a failure.
   *
   * Only Dr Ana works at 10:30 — Dr Stefan is afternoons only — so exactly one
   * of these callers can have the slot they all asked for. The others should
   * be offered something else, and a scripted caller has no answer to that, so
   * they end the run unbooked. Printing what they were last told is the
   * difference between "the guard worked" and "two calls broke", which the
   * outcome column alone cannot distinguish.
   */
  const unbooked = reports.filter(
    (r) => !booked.some((b) => b.customerName?.includes(String(r.index + 1))),
  );
  if (unbooked.length > 0) {
    console.log(bold('\n  What the callers who did not book were last told\n'));
    for (const report of unbooked) {
      const row = rows.find((r) => r.externalId.endsWith(`_${report.index}`));
      const lastAgent = [...(row?.transcript ?? [])].reverse().find((t) => t.role === 'agent');
      console.log(`    ${report.name}: ${dim(lastAgent?.text ?? '(nothing)')}`);
    }
  }

  // --- frame pacing ---------------------------------------------------------

  const pacing = summarize(reports.flatMap((r) => r.pacing.readings()));
  console.log(bold('\n  Frame pacing (20ms ticks across every call)\n'));
  console.log(`    ticks measured:              ${pacing.count}`);
  console.log(`    lateness p50 / p95 / worst:  ${pacing.p50}ms / ${pacing.p95}ms / ${pacing.worst}ms`);
  console.log(
    dim(
      '    A tick that fires late is audio that arrives late. This is the one\n' +
        '    timing number here a simulation measures as truthfully as a real call.',
    ),
  );

  // --- everything else ------------------------------------------------------

  const errors = reports.flatMap((r) => r.errors);

  /**
   * The ceiling deserves its own headline, not a line in a log dump.
   *
   * `4429` is Azure refusing a fourth simultaneous transcription. It is not a
   * timeout, a tuning problem or something a retry fixes — the resource will
   * not open the session, so the fourth caller is deaf for the whole call. No
   * amount of latency work matters above this line.
   */
  const throttled = errors.filter((e) => e.includes('4429')).length;
  if (throttled > 0) {
    console.log(bold('\n  ⚠  AZURE REFUSED CONCURRENT TRANSCRIPTIONS\n'));
    console.log(`    ${throttled} of ${CALLS} calls could not open a recognizer (websocket 4429).`);
    console.log('    Those callers hear the greeting and are never heard back.');
    console.log(dim('    Measure the exact ceiling with: pnpm --filter @frontly/api probe:concurrency'));
  }

  console.log(bold('\n  Health\n'));
  console.log(`    wall clock:                  ${(wallMs / 1000).toFixed(1)}s`);
  console.log(
    `    heap:                        ${(memoryBefore / 1e6).toFixed(1)}MB → ${(memoryAfter / 1e6).toFixed(1)}MB`,
  );
  console.log(`    warnings + errors logged:    ${errors.length}`);
  for (const error of errors.slice(0, 12)) console.log(dim(`      ${error}`));
  if (errors.length > 12) console.log(dim(`      … and ${errors.length - 12} more`));

  const replies = reports.flatMap((r) => r.replyMs).sort((a, b) => a - b);
  if (replies.length > 0) {
    const p = (q: number) => replies[Math.min(replies.length - 1, Math.floor(replies.length * q))];
    console.log(bold('\n  Turn latency under load — NOT the caller\'s number\n'));
    console.log(`    p50 ${p(0.5)}ms · p95 ${p(0.95)}ms · worst ${replies.at(-1)}ms`);
    console.log(
      dim(
        '    Injected speech carries its own trailing silence, so this is a\n' +
          '    floor, not an experience. Compare runs against each other, never\n' +
          '    against a real call.',
      ),
    );
  }

  console.log('');
  cache.close();
  t.cleanup();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve once the agent has stopped thinking and stopped speaking. */
async function waitForQuiet(
  count: () => number,
  timeoutMs = 25_000,
  thinking: () => boolean = () => false,
  quietMs = 1600,
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
  console.error('load test failed:', error);
  process.exit(1);
});
