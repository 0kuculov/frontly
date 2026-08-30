import {
  AnthropicLanguageModel,
  appointments,
  createTestDb,
  DEMO_IDS,
  emptyConversationState,
  getBusinessContext,
  handleTurn,
  loadRootEnv,
  resolveModelId,
  type TurnContext,
} from '@frontly/core';
import type { Language } from '@frontly/shared';

/**
 * Does this model actually CALL the tools, or does it just say it did?
 *
 *   pnpm --filter @frontly/api probe:tools
 *   PROBE_MODEL=claude-haiku-4-5 PROBE_RUNS=5 pnpm --filter @frontly/api probe:tools
 *
 * Written after Haiku 4.5 finished a booking conversation with
 * "Ви го закажав преглед… Терминот е потврден" and no tool call at all —
 * telling the caller the appointment was confirmed while nothing was written
 * to the database. On a stage that is a judge hearing "you are booked" beside
 * a dashboard that stays empty, which is worse than any latency.
 *
 * A single run cannot tell a bad model from an unlucky sample, so this runs
 * the same conversation N times and reports rates. The number that matters is
 * the last column: conversations that ended with a real row in `appointments`.
 */

loadRootEnv();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Needs ANTHROPIC_API_KEY.');
  process.exit(1);
}

const RUNS = Number(process.env.PROBE_RUNS ?? 3);
const MODEL = resolveModelId(process.env.PROBE_MODEL ?? process.env.ANTHROPIC_MODEL);

const TURNS = [
  'Добар ден, сакам да закажам стоматолошки преглед.',
  'Утре наутро, ако може.',
  'Може ли во десет и половина?',
  'Се викам Марко Петровски, бројот ми е нула седумдесет сто единаесет двесте дваесет и два.',
  'Да, точно е. Закажете го.',
];

/** Words a reply uses when it is claiming the booking is done. */
const CLAIMS_BOOKED = /закажав|закажан|потврден|резервиран|booked|confirmed/i;

const bold = (t: string) => `[1m${t}[0m`;
const dim = (t: string) => `[2m${t}[0m`;
const green = (t: string) => `[32m${t}[0m`;
const red = (t: string) => `[31m${t}[0m`;

interface RunResult {
  tools: string[];
  booked: boolean;
  /** Said it was done without doing it. The failure worth naming. */
  hallucinated: boolean;
  lastReply: string;
  refusals: string[];
}

async function runOnce(): Promise<RunResult> {
  const t = await createTestDb({ seed: true });
  const context = (await getBusinessContext(t.db, DEMO_IDS.business))!;
  const language: Language = 'mk';
  const state = emptyConversationState(language);
  const model = new AnthropicLanguageModel({ model: MODEL });

  const tools: string[] = [];
  const refusals: string[] = [];
  let lastReply = '';

  for (const said of TURNS) {
    const ctx: TurnContext = {
      db: t.db,
      model,
      business: context.business,
      services: context.services,
      staff: context.staff,
      channel: 'voice',
      language,
      customerPhone: '+38970111222',
      state,
    };
    const result = await handleTurn('probe', said, ctx);
    Object.assign(state, result.state);
    tools.push(...result.toolCalls.map((c) => c.name));
    // Why a call was refused is the whole question: a rejected
    // book_appointment is the gate working, not the model failing to try.
    for (const call of result.toolCalls) {
      const out = call.output as { error?: string; message?: string } | undefined;
      if (out?.error) refusals.push(`${call.name}: ${out.error}`);
    }
    lastReply = result.reply;
  }

  const rows = await t.db.select().from(appointments);
  const booked = rows.length > 0;
  t.cleanup();

  return {
    tools,
    booked,
    hallucinated: !booked && CLAIMS_BOOKED.test(lastReply),
    lastReply,
    refusals,
  };
}

async function main(): Promise<void> {
  console.log(bold(`\n  Tool discipline — ${MODEL}, ${RUNS} run(s)\n`));
  console.log('  run  confirm_details  book_appointment  appointment row');
  console.log('  ' + '-'.repeat(60));

  const results: RunResult[] = [];
  for (let i = 1; i <= RUNS; i++) {
    const r = await runOnce();
    results.push(r);
    const confirmed = r.tools.includes('confirm_details');
    const bookedCall = r.tools.includes('book_appointment');
    console.log(
      `  ${String(i).padStart(3)}  ${(confirmed ? green('yes') : red('NO ')).padEnd(20)}` +
        `${(bookedCall ? green('yes') : red('NO ')).padEnd(21)}` +
        `${r.booked ? green('yes') : red('NO')}` +
        (r.hallucinated ? red('   ← CLAIMED IT ANYWAY') : ''),
    );
    for (const refusal of r.refusals) console.log(dim(`       refused: ${refusal}`));
  }

  const booked = results.filter((r) => r.booked).length;
  const lied = results.filter((r) => r.hallucinated).length;

  console.log('  ' + '-'.repeat(60));
  console.log(`  booked ${booked}/${RUNS}`);
  if (lied > 0) {
    console.log(
      red(`  ${lied}/${RUNS} told the caller it was booked when it was not.`),
    );
    const example = results.find((r) => r.hallucinated);
    if (example) console.log(dim(`    "${example.lastReply}"`));
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
