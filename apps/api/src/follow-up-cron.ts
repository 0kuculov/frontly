import { createDb, loadRootEnv } from '@frontly/core';
import { serverEnvSchema, smsSender } from '@frontly/shared';
import { sendDailySummaries, sweepConfirmations, sweepReminders } from './sms/follow-up.js';
import { TelnyxSmsProvider } from './sms/sms.js';

/**
 * The follow-up cron: confirmations that did not go out, reminders that are
 * due, and the owner's evening summary.
 *
 * Lives in `src/` rather than `scripts/` for one reason: the build compiles
 * only `src/` into `dist/`, and Render must run compiled JavaScript. A cron
 * entry under `scripts/` would need `tsx` — a dev dependency — in the
 * production image, which is exactly what `db:migrate:dist` already avoids.
 *
 * Runs HOURLY and decides for itself what is due. It does not need to know
 * what time it is meant to be: `sendDailySummaries` checks each business's
 * own local clock, because Render's scheduler is UTC and `Europe/Skopje` is
 * UTC+1 or +2 depending on the season — a summary pinned to a UTC hour would
 * arrive at 19:00 for half the year.
 *
 * Exits non-zero only if it could not run at all. Individual failures are
 * logged and left for the next hour: every sweep is idempotent because the
 * "has this been sent?" state is a column on the appointment, so a retry is
 * free and a crash costs nothing.
 */

loadRootEnv();

/** Plain console logging: Render captures stdout, and a cron has no request context. */
const logger = {
  info: (payload: Record<string, unknown>, message: string) =>
    console.log(JSON.stringify({ level: 'info', message, ...payload })),
  warn: (payload: Record<string, unknown>, message: string) =>
    console.warn(JSON.stringify({ level: 'warn', message, ...payload })),
  error: (payload: Record<string, unknown>, message: string) =>
    console.error(JSON.stringify({ level: 'error', message, ...payload })),
};

async function main(): Promise<void> {
  const env = serverEnvSchema.parse(process.env);
  const sender = smsSender(env);

  if (!env.TELNYX_API_KEY || !sender) {
    /**
     * Not an error. Until the messaging profile exists there is nothing to
     * send from, and a cron that exits 1 every hour would bury the log that
     * matters under alerts about a phase that has not started.
     */
    logger.warn(
      { hasApiKey: Boolean(env.TELNYX_API_KEY), hasSender: Boolean(sender) },
      'follow-up cron: SMS not configured, nothing to do',
    );
    return;
  }

  const db = createDb({ url: env.DATABASE_URL, authToken: env.DATABASE_AUTH_TOKEN });
  const sms = new TelnyxSmsProvider({ apiKey: env.TELNYX_API_KEY, sender });
  const deps = { db, sms, logger };

  logger.info({ from: sender.from, alphanumeric: sender.alphanumeric }, 'follow-up cron: start');

  const confirmations = await sweepConfirmations(deps);
  const reminders = await sweepReminders(deps);
  const summaries = await sendDailySummaries(deps);

  logger.info(
    {
      confirmations,
      reminders,
      summaries,
    },
    'follow-up cron: done',
  );

  db.$client.close();
}

main().catch((error: unknown) => {
  logger.error(
    { err: error instanceof Error ? error.message : String(error) },
    'follow-up cron failed',
  );
  process.exit(1);
});
