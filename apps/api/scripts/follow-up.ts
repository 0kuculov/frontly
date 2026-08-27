import {
  appointmentsAwaitingConfirmation,
  appointmentsDueForReminder,
  createDb,
  dailySummary,
  listBusinesses,
  loadRootEnv,
} from '@frontly/core';
import { serverEnvSchema, smsSender } from '@frontly/shared';
import {
  confirmationText,
  dailySummaryText,
  messageLanguage,
  partsFor,
  reminderText,
} from '../src/sms/messages.js';
import {
  sendDailySummaries,
  summaryWindow,
  sweepConfirmations,
  sweepReminders,
} from '../src/sms/follow-up.js';
import { TelnyxSmsProvider } from '../src/sms/sms.js';

/**
 * Run a follow-up sweep by hand.
 *
 *   pnpm --filter @frontly/api follow-up -- --dry-run
 *   pnpm --filter @frontly/api follow-up -- --only reminders
 *   pnpm --filter @frontly/api follow-up -- --only summaries --hour 20
 *
 * The hourly cron decides for itself what is due, which is right for a server
 * and useless five minutes before a demo, when the question is "will the owner
 * actually get their 20:00 summary, and what will it say?".
 *
 * TWO RULES SHAPE THIS FILE.
 *
 * **It is a CLI, not an endpoint.** An HTTP route that sends SMS to real
 * customers is the demo-reset mistake with a worse blast radius: `/demo/reset`
 * only cost numbers on a screen, and this costs money and reaches patients.
 * A command needs the API key on the machine running it, which is the access
 * control.
 *
 * **`--dry-run` shares the QUERIES with the sender and none of the sending.**
 * It resolves what is due through the same functions the sweeps use, then
 * formats and prints. It deliberately does NOT run the sweeps against a fake
 * provider: `deliver()` stamps `confirmation_sent_at` after a successful send,
 * so a dry run routed through it would either mutate the database or need a
 * branch inside the real send path — and a preview that can change the sender
 * is not a preview. Nothing here writes.
 */

loadRootEnv();

type Sweep = 'confirmations' | 'reminders' | 'summaries';
const ALL: Sweep[] = ['confirmations', 'reminders', 'summaries'];

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');

function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

const only = (flag('only') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is Sweep => ALL.includes(s as Sweep));
const sweeps = only.length > 0 ? only : ALL;
const hour = Number(flag('hour') ?? 20);

const logger = {
  info: (payload: Record<string, unknown>, message: string) =>
    console.log(`  · ${message} ${JSON.stringify(payload)}`),
  warn: (payload: Record<string, unknown>, message: string) =>
    console.warn(`  ! ${message} ${JSON.stringify(payload)}`),
  error: (payload: Record<string, unknown>, message: string) =>
    console.error(`  ✕ ${message} ${JSON.stringify(payload)}`),
};

const bold = (t: string) => `[1m${t}[0m`;
const dim = (t: string) => `[2m${t}[0m`;

/** One message, shown exactly as it will arrive, with what it will cost. */
function preview(label: string, to: string, text: string): void {
  const cost = partsFor(text);
  const flagged = cost.parts > 1 ? bold(` ${cost.parts} PARTS`) : dim(` ${cost.parts} part`);
  console.log(`    → ${to}${flagged}${dim(` ${cost.encoding} ${[...text].length} chars`)}`);
  console.log(`      ${dim(label)} ${text}`);
}

async function main(): Promise<void> {
  const env = serverEnvSchema.parse(process.env);
  const db = createDb({ url: env.DATABASE_URL, authToken: env.DATABASE_AUTH_TOKEN });
  const now = new Date();

  console.log(bold(`\n  Follow-up: ${sweeps.join(', ')}${dryRun ? '  (dry run)' : ''}`));
  /**
   * Which database, said out loud.
   *
   * `.env` points at the same Turso the live service uses, so a sweep run from
   * a laptop is a production client — and unlike the demo reset, the damage
   * here leaves the building as a text message. Naming the target is cheap.
   */
  const target = env.DATABASE_URL.startsWith('file:') ? env.DATABASE_URL : 'TURSO (production)';
  console.log(dim(`  database: ${target}\n`));

  if (dryRun) {
    if (sweeps.includes('confirmations')) {
      const due = await appointmentsAwaitingConfirmation(db, now, 50);
      console.log(bold(`  Confirmations due: ${due.length}`));
      for (const appointment of due) {
        const language = messageLanguage(appointment.languages);
        preview('confirmation', appointment.customerPhone, confirmationText(appointment, language));
      }
    }

    if (sweeps.includes('reminders')) {
      const due = await appointmentsDueForReminder(db, now);
      console.log(bold(`\n  Reminders due: ${due.length}`));
      for (const appointment of due) {
        const language = messageLanguage(appointment.languages);
        preview('reminder', appointment.customerPhone, reminderText(appointment, language));
      }
    }

    if (sweeps.includes('summaries')) {
      console.log(bold('\n  Owner summaries'));
      for (const business of await listBusinesses(db)) {
        const localHour = Number(
          new Intl.DateTimeFormat('en-GB', {
            timeZone: business.timezone,
            hour: '2-digit',
            hour12: false,
          }).format(now),
        );
        const w = summaryWindow(business.timezone, now);
        const summary = await dailySummary(
          db,
          business.id,
          w.dayStart,
          w.dayEnd,
          w.tomorrowStart,
          w.tomorrowEnd,
        );

        console.log(
          `  ${business.name} ${dim(`local ${String(localHour).padStart(2, '0')}:00, sends at ${hour}:00`)}` +
            (localHour === hour ? bold('  DUE NOW') : dim('  not yet')),
        );
        if (!summary?.ownerMobile) {
          console.log(dim('    no owner mobile set — this business gets no summary'));
          continue;
        }
        preview('summary', summary.ownerMobile, dailySummaryText(summary, messageLanguage(summary.languages)));
      }
    }

    console.log(dim('\n  Dry run: nothing was sent and nothing was written.\n'));
    db.$client.close();
    return;
  }

  // --- for real -------------------------------------------------------------

  const sender = smsSender(env);
  if (!env.TELNYX_API_KEY || !sender) {
    console.error('  TELNYX_API_KEY and a sender are required to send. Use --dry-run to preview.');
    process.exit(1);
  }

  const sms = new TelnyxSmsProvider({ apiKey: env.TELNYX_API_KEY, sender });
  const deps = { db, sms, logger };
  console.log(dim(`  sending from ${sender.from}${sender.alphanumeric ? ' (alphanumeric)' : ''}\n`));

  if (sweeps.includes('confirmations')) {
    console.log(bold('  confirmations'), await sweepConfirmations(deps));
  }
  if (sweeps.includes('reminders')) {
    console.log(bold('  reminders'), await sweepReminders(deps));
  }
  if (sweeps.includes('summaries')) {
    console.log(bold('  summaries'), await sendDailySummaries(deps, { hour }));
  }

  console.log('');
  db.$client.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
