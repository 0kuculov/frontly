import { eq } from 'drizzle-orm';
import { businesses, services, staff } from '../src/db/schema.js';
import { DEMO_IDS } from '../src/db/seed.js';
import { loadRootEnv } from '../src/db/paths.js';
import { createTestDb } from '../src/db/testing.js';
import { handleTurn } from '../src/engine/handle-turn.js';
import { AnthropicLanguageModel } from '../src/engine/model.js';
import { emptyConversationState, type TurnContext } from '../src/engine/types.js';

/**
 * Where the latency in a turn actually goes.
 *
 * Splits the model's contribution into time-to-first-token (pure model
 * latency, which a smaller model reduces) and time-to-first-sentence (which
 * also depends on how long a sentence the model chooses to write, and which
 * only prompting changes). Optimising the wrong one wastes the budget.
 *
 *   pnpm --filter @frontly/core bench
 */

loadRootEnv();

const MODELS = (process.env.BENCH_MODELS ?? 'claude-sonnet-5,claude-haiku-4-5').split(',');
const PROMPTS = [
  'Добар ден, сакам да закажам стоматолошки преглед.',
  'Утре наутро ако може.',
];

async function main(): Promise<void> {
  const t = await createTestDb();
  const db = t.db;
  const business = (await db.select().from(businesses).where(eq(businesses.id, DEMO_IDS.business)))[0]!;
  const svc = await db.select().from(services).where(eq(services.businessId, DEMO_IDS.business));
  const stf = await db.select().from(staff).where(eq(staff.businessId, DEMO_IDS.business));

  console.log('\n  model                first-token   first-sentence   total    tools');
  console.log('  ' + '-'.repeat(70));

  for (const modelId of MODELS) {
    const model = new AnthropicLanguageModel({ model: modelId.trim() });

    for (const prompt of PROMPTS) {
      const ctx: TurnContext = {
        db,
        model,
        business,
        services: svc,
        staff: stf,
        channel: 'voice',
        language: 'mk',
        customerPhone: '+38970111222',
        state: emptyConversationState('mk'),
        onSentence: () => {},
      };

      try {
        const result = await handleTurn('bench', prompt, ctx);
        const tools = result.toolCalls.map((c) => c.name).join(',') || '—';
        console.log(
          `  ${modelId.padEnd(20)} ${pad(result.timings.toFirstTokenMs)} ${pad(
            result.timings.toFirstSentenceMs,
          )}   ${pad(result.timings.totalMs)}   ${tools}`,
        );
      } catch (error) {
        console.log(`  ${modelId.padEnd(20)} FAILED: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  console.log();
  t.cleanup();
}

function pad(ms: number | undefined): string {
  return `${ms ?? '—'}ms`.padStart(11);
}

main().catch((error: unknown) => {
  console.error('bench failed:', error);
  process.exit(1);
});
