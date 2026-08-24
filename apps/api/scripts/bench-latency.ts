import {
  AnthropicLanguageModel,
  appointments,
  createTestDb,
  DEMO_IDS,
  emptyConversationState,
  getBusinessContext,
  handleTurn,
  loadRootEnv,
  type TurnResult,
} from '@frontly/core';
import { DEFAULT_VOICE_CONFIG, type Language } from '@frontly/shared';
import { AzureSpeechProvider } from '../src/voice/azure.js';

/**
 * Where the 1.8–4.4 seconds actually goes.
 *
 * A single "time to first audio" number cannot say whether a slow turn was the
 * model thinking or the database answering, and those have opposite fixes: a
 * smaller model does nothing for a slow `check_availability`. So every stage is
 * timed separately and reported as a distribution, because the p95 turn is the
 * one a caller remembers and the mean hides it.
 *
 * Real Claude, real Turso, real Azure TTS. The caller's own audio is not
 * simulated — STT is upstream of everything measured here.
 *
 *   pnpm --filter @frontly/api bench:latency
 *   BENCH_RUNS=12 pnpm --filter @frontly/api bench:latency
 */

loadRootEnv();

const key = process.env.AZURE_SPEECH_KEY;
const region = process.env.AZURE_SPEECH_REGION ?? 'italynorth';
if (!key || !process.env.ANTHROPIC_API_KEY) {
  console.error('Needs AZURE_SPEECH_KEY and ANTHROPIC_API_KEY.');
  process.exit(1);
}

const RUNS = Number(process.env.BENCH_RUNS ?? 6);
const MODEL = process.env.BENCH_MODEL ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';

/** A whole booking, so the sample includes both tool and non-tool turns. */
const CONVERSATION = [
  'Добар ден, сакам да закажам стоматолошки преглед.',
  'Утре наутро, ако може.',
  'Може ли во десет и половина?',
  'Се викам Марко Петровски. Да, потврдувам.',
];

interface Sample {
  turn: number;
  usedTools: boolean;
  toolNames: string[];
  /** Pure model latency: first call, first token. No tool has run yet. */
  modelFirstTokenMs?: number;
  firstCallMs?: number;
  toolMs: number;
  laterCallsMs: number;
  /**
   * First token of whichever call actually spoke.
   *
   * On a tool turn that is the SECOND call — the first only asks for the tool
   * and emits no text at all. Without this row the table has a hole exactly
   * where a tool turn's real generation cost sits.
   */
  speakingCallFirstTokenMs?: number;
  /** Every model round trip summed: what a faster model would actually shrink. */
  modelTotalMs: number;
  ttsFirstMs?: number;
  /** What the caller experiences: turn start until audio exists. */
  toFirstAudioMs?: number;
  totalMs: number;
}

const bold = (t: string) => `[1m${t}[0m`;
const dim = (t: string) => `[2m${t}[0m`;

async function main(): Promise<void> {
  const t = await createTestDb();
  const context = (await getBusinessContext(t.db, DEMO_IDS.business))!;
  const provider = new AzureSpeechProvider({ key: key!, region });
  const model = new AnthropicLanguageModel({ model: MODEL });
  const profile = context.business.voiceConfig?.mk ?? DEFAULT_VOICE_CONFIG.mk;

  const samples: Sample[] = [];

  console.log(bold(`\n  Latency breakdown — ${MODEL}`));
  console.log(dim(`  ${RUNS} conversations x ${CONVERSATION.length} turns, Azure ${region}\n`));

  for (let run = 0; run < RUNS; run++) {
    // A fresh slate each run, or the second booking collides with the first.
    await t.db.delete(appointments);
    const state = emptyConversationState('mk' as Language);
    process.stdout.write(dim(`  run ${run + 1}/${RUNS} `));

    for (const [index, utterance] of CONVERSATION.entries()) {
      const tts = provider.createSynthesizer();
      const turnStartedAt = Date.now();
      let firstAudioAt: number | undefined;
      let ttsFirstMs: number | undefined;
      let synthesised = false;

      /**
       * Synthesize only the first sentence, and await it.
       *
       * The rest of the reply is irrelevant to time-to-first-audio, and letting
       * later sentences overlap would make the TTS number measure contention
       * rather than latency.
       */
      const pending: Promise<void>[] = [];
      const onSentence = (sentence: string): void => {
        if (synthesised) return;
        synthesised = true;
        const startedAt = Date.now();
        pending.push(
          tts
            .synthesize({ text: sentence, language: 'mk' as Language, profile })
            .then(() => {
              ttsFirstMs = Date.now() - startedAt;
              firstAudioAt = Date.now();
            })
            .catch(() => {
              /* a failed synthesis is not a latency measurement */
            }),
        );
      };

      let result: TurnResult;
      try {
        result = await handleTurn('bench', utterance, {
          db: t.db,
          model,
          business: context.business,
          services: context.services,
          staff: context.staff,
          channel: 'voice',
          language: 'mk' as Language,
          customerPhone: '+38970111222',
          state,
          onSentence,
        });
      } catch (error) {
        console.log(`\n  turn ${index} failed: ${error instanceof Error ? error.message : error}`);
        tts.close();
        continue;
      }

      await Promise.all(pending);
      tts.close();
      Object.assign(state, result.state);

      const [firstCall, ...laterCalls] = result.timings.calls;
      const speaking = result.timings.calls.find((c) => c.toFirstTokenMs !== undefined);
      samples.push({
        turn: index,
        usedTools: result.timings.tools.length > 0,
        toolNames: result.timings.tools.map((x) => x.name),
        ...(firstCall?.toFirstTokenMs !== undefined
          ? { modelFirstTokenMs: firstCall.toFirstTokenMs }
          : {}),
        ...(firstCall ? { firstCallMs: firstCall.totalMs } : {}),
        toolMs: result.timings.toolMs,
        laterCallsMs: laterCalls.reduce((sum, c) => sum + c.totalMs, 0),
        ...(speaking?.toFirstTokenMs !== undefined
          ? { speakingCallFirstTokenMs: speaking.toFirstTokenMs }
          : {}),
        modelTotalMs: result.timings.calls.reduce((sum, c) => sum + c.totalMs, 0),
        ...(ttsFirstMs !== undefined ? { ttsFirstMs } : {}),
        ...(firstAudioAt !== undefined ? { toFirstAudioMs: firstAudioAt - turnStartedAt } : {}),
        totalMs: result.timings.totalMs,
      });

      process.stdout.write(dim('.'));
    }
    process.stdout.write('\n');
  }

  report(samples);
  t.cleanup();
}

function report(samples: Sample[]): void {
  const withTools = samples.filter((s) => s.usedTools);
  const withoutTools = samples.filter((s) => !s.usedTools);

  console.log(bold('\n  All turns') + dim(`  (n=${samples.length})`));
  table(samples);

  if (withoutTools.length > 0) {
    console.log(bold('\n  Turns with no tool call') + dim(`  (n=${withoutTools.length})`));
    table(withoutTools);
  }
  if (withTools.length > 0) {
    const names = [...new Set(withTools.flatMap((s) => s.toolNames))].join(', ');
    console.log(bold('\n  Turns that called a tool') + dim(`  (n=${withTools.length}: ${names})`));
    table(withTools);
  }

  verdict(withTools, withoutTools);
}

function table(samples: Sample[]): void {
  const rows: [string, (s: Sample) => number | undefined][] = [
    ['first model call', (s) => s.firstCallMs],
    ['tool round trip', (s) => (s.usedTools ? s.toolMs : undefined)],
    ['later model calls', (s) => (s.laterCallsMs > 0 ? s.laterCallsMs : undefined)],
    ['speaking call TTFT', (s) => s.speakingCallFirstTokenMs],
    ['all model calls', (s) => s.modelTotalMs],
    ['TTS first sentence', (s) => s.ttsFirstMs],
    ['-> to first audio', (s) => s.toFirstAudioMs],
    ['   whole turn', (s) => s.totalMs],
  ];

  console.log(dim('    stage                    n     p50      p95      max'));
  for (const [label, pick] of rows) {
    const values = samples.map(pick).filter((v): v is number => v !== undefined);
    if (values.length === 0) continue;
    console.log(
      `    ${label.padEnd(22)} ${String(values.length).padStart(3)}  ` +
        `${ms(percentile(values, 0.5))} ${ms(percentile(values, 0.95))} ${ms(Math.max(...values))}`,
    );
  }
}

/**
 * The one sentence the numbers are for: does a faster model help, or is the
 * time somewhere a model change cannot reach?
 */
function verdict(withTools: Sample[], withoutTools: Sample[]): void {
  console.log(bold('\n  Reading'));

  const all = [...withTools, ...withoutTools];
  const audio = all.map((s) => s.toFirstAudioMs).filter((v): v is number => v !== undefined);
  if (audio.length === 0) return;

  const p50Audio = percentile(audio, 0.5);
  const p95Audio = percentile(audio, 0.95);
  const modelP50 = percentile(all.map((s) => s.modelTotalMs), 0.5);
  const toolP50 = withTools.length > 0 ? percentile(withTools.map((s) => s.toolMs), 0.5) : 0;
  const ttsP50 = percentile(
    all.map((s) => s.ttsFirstMs).filter((v): v is number => v !== undefined),
    0.5,
  );

  console.log(`    to first audio   p50 ${p50Audio}ms   p95 ${p95Audio}ms`);
  console.log(`    of that p50:     model ${modelP50}ms · tools ${toolP50}ms · TTS ${ttsP50}ms`);

  if (withTools.length > 0 && withoutTools.length > 0) {
    const pick = (rows: Sample[]) =>
      percentile(
        rows.map((s) => s.toFirstAudioMs).filter((v): v is number => v !== undefined),
        0.5,
      );
    const extra = pick(withTools) - pick(withoutTools);
    const secondCall = percentile(
      withTools.map((s) => s.laterCallsMs).filter((v) => v > 0),
      0.5,
    );

    console.log(
      `\n    A tool turn costs ${extra}ms more than a plain one — but the tool itself is ` +
        `only ${toolP50}ms.`,
    );
    console.log(
      `    The cost is a SECOND model round trip (${secondCall}ms). The first call emits no text,`,
    );
    console.log('    it only asks for the tool, so the spoken reply needs a whole extra generation.');
  }

  console.log(
    modelP50 > Math.max(toolP50, 1) * 10
      ? dim('\n    Generation dominates. A faster model is the lever; the database is not.')
      : dim('\n    Tools dominate. A faster model will not fix this.'),
  );
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function ms(value: number): string {
  return `${value}ms`.padStart(8);
}

main().catch((error: unknown) => {
  console.error('bench failed:', error);
  process.exit(1);
});
