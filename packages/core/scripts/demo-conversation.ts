import { eq } from 'drizzle-orm';
import { appointments, businesses, services, staff } from '../src/db/schema.js';
import { DEMO_IDS } from '../src/db/seed.js';
import { loadRootEnv } from '../src/db/paths.js';
import { createTestDb } from '../src/db/testing.js';
import { fromZonedWallClock } from '../src/time/zone.js';
import { handleTurn } from '../src/engine/handle-turn.js';
import { AnthropicLanguageModel, ScriptedLanguageModel } from '../src/engine/model.js';
import { emptyConversationState, type TurnContext } from '../src/engine/types.js';

/**
 * Drives a whole booking conversation against the real model and prints the
 * transcript, so the engine can be seen working without a phone line.
 *
 *   bash:       ANTHROPIC_API_KEY=... pnpm --filter @frontly/core demo
 *   PowerShell: pnpm --filter @frontly/core demo
 *
 * Runs against a throwaway database seeded with the Ohrid clinic; nothing it
 * books touches the real one.
 */

const SKOPJE = 'Europe/Skopje';
/** Pinned so the transcript reads the same every time it is run. */
const NOW = fromZonedWallClock(SKOPJE, 2026, 9, 7, 8, 0);

const CALLER_TURNS = [
  'Добар ден, сакам да закажам стоматолошки преглед.',
  'Утре наутро ако може.',
  'Може ли во десет и половина?',
  'Се викам Марко Петровски.',
  'Да, точно. Закажете го.',
];

function bold(text: string): string {
  return `[1m${text}[0m`;
}
function dim(text: string): string {
  return `[2m${text}[0m`;
}

async function main(): Promise<void> {
  loadRootEnv();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set — this demo talks to the real model.');
    process.exit(1);
  }

  const t = await createTestDb();
  const db = t.db;

  const business = (
    await db.select().from(businesses).where(eq(businesses.id, DEMO_IDS.business))
  )[0]!;
  const svc = await db.select().from(services).where(eq(services.businessId, DEMO_IDS.business));
  const stf = await db.select().from(staff).where(eq(staff.businessId, DEMO_IDS.business));

  const model = new AnthropicLanguageModel();
  void ScriptedLanguageModel; // kept importable for the test suite

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
    now: NOW,
    onLatinLeak: (leak) => {
      console.log(
        dim(`             ⚠ latin leak  converted=${JSON.stringify(leak.converted)} ` +
            `unconverted=${JSON.stringify(leak.unconverted)}`),
      );
    },
  };

  console.log(bold(`\n  ${business.name} — демо повик`));
  console.log(dim(`  понеделник, 7 септември 2026, 08:00 (${business.timezone})\n`));

  let totalMs = 0;

  for (const [index, said] of CALLER_TURNS.entries()) {
    console.log(`${bold('  Пациент  ')} ${said}`);

    const startedAt = Date.now();
    const result = await handleTurn(`demo_${index}`, said, ctx);
    const elapsed = Date.now() - startedAt;
    totalMs += elapsed;
    ctx.state = result.state;

    for (const call of result.toolCalls) {
      const status = call.error ? `✕ ${call.error}` : '✓';
      console.log(dim(`             ↳ ${call.name}(…) ${status}  ${call.durationMs}ms`));
    }

    console.log(`${bold('  Frontly  ')} ${result.reply}`);
    console.log(dim(`             ${elapsed}ms\n`));
  }

  const booked = await db.select().from(appointments).where(eq(appointments.businessId, business.id));

  console.log(bold('  Резултат'));
  console.log(`  исход:        ${ctx.state.outcome ?? '—'}`);
  console.log(`  термини:      ${booked.length}`);
  for (const row of booked) {
    console.log(
      `    ${row.customerName} · ${row.startsAt.toISOString()} · ${row.status} · ${row.channel}`,
    );
  }
  console.log(dim(`  вкупно ${totalMs}ms за ${CALLER_TURNS.length} реплики\n`));

  t.cleanup();
}

main().catch((error: unknown) => {
  console.error('demo failed:', error);
  process.exit(1);
});
