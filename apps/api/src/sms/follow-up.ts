import {
  appointmentsAwaitingConfirmation,
  appointmentsDueForReminder,
  dailySummary,
  listBusinesses,
  markFollowUpSent,
  startOfZonedDay,
  toZonedParts,
  type Database,
  type DueAppointment,
} from '@frontly/core';
import { confirmationText, dailySummaryText, messageLanguage, partsFor, reminderText } from './messages.js';
import type { ISmsProvider } from './sms.js';

/**
 * Sending the follow-ups.
 *
 * Split from the queries in `packages/core` and from the carrier in `sms.ts`,
 * so this file holds only the decisions: what to send, to whom, and what to
 * record afterwards.
 *
 * Every function here is safe to run twice. That is not politeness — it is
 * the entire durability story. There is no queue and no retry table; the
 * cron simply runs again, and anything whose column is still NULL gets
 * another attempt. Which means the ONE rule that must never be broken is:
 * stamp after the carrier accepts, never before.
 */

export interface FollowUpLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface FollowUpDeps {
  db: Database;
  sms: ISmsProvider;
  logger: FollowUpLogger;
  now?: () => Date;
}

export interface FollowUpResult {
  sent: number;
  skipped: number;
  failed: number;
}

const empty = (): FollowUpResult => ({ sent: 0, skipped: 0, failed: 0 });

/**
 * One appointment's message, sent and recorded.
 *
 * Returns rather than throws, because a single bad phone number must not stop
 * the sweep: the next appointment in the list is someone else's reminder.
 */
async function deliver(
  deps: FollowUpDeps,
  appointment: DueAppointment,
  kind: 'confirmation' | 'reminder',
  result: FollowUpResult,
): Promise<void> {
  const language = messageLanguage(appointment.languages);
  const text =
    kind === 'confirmation'
      ? confirmationText(appointment, language)
      : reminderText(appointment, language);
  const cost = partsFor(text);

  try {
    const outcome = await deps.sms.send({ to: appointment.customerPhone, text });

    if (outcome.status === 'undeliverable') {
      /**
       * Not stamped, and deliberately so — but also not retried into
       * oblivion: this is a configuration problem (a US long code aimed at
       * +389, a sender ID not yet approved), so it will fail identically
       * every hour until a variable changes. The log names the reason so the
       * hour it starts working is obvious.
       */
      result.skipped++;
      deps.logger.warn(
        { appointment: appointment.id, kind, to: appointment.customerPhone, reason: outcome.reason },
        'follow-up not deliverable with the current sender',
      );
      return;
    }

    // Only now. A stamp before the carrier accepts turns a transient failure
    // into a message nobody ever receives.
    await markFollowUpSent(deps.db, appointment.id, kind, (deps.now ?? (() => new Date()))());
    result.sent++;
    deps.logger.info(
      {
        appointment: appointment.id,
        kind,
        language,
        providerId: outcome.providerId,
        encoding: cost.encoding,
        parts: cost.parts,
        ...(outcome.sentFrom ? { sentFrom: outcome.sentFrom } : {}),
      },
      /**
       * A substitution is still a delivery. Telnyx may swap an alphanumeric
       * sender for a generic one to get the message through on some networks,
       * so this is said out loud rather than treated as a fault — but it IS
       * said, because a text arriving from a short code instead of FRONTLY
       * looks like a different product to the person holding the phone.
       */
      outcome.senderSubstituted ? 'follow-up sent (carrier substituted the sender)' : 'follow-up sent',
    );
  } catch (error) {
    result.failed++;
    deps.logger.error(
      {
        appointment: appointment.id,
        kind,
        err: error instanceof Error ? error.message : String(error),
      },
      'follow-up failed — will be retried on the next sweep',
    );
  }
}

/**
 * Confirmations that have not gone out.
 *
 * On a live call the adapter sends this immediately, so in the normal case
 * this sweep finds nothing. It exists for the abnormal one: the process
 * restarted mid-turn, or Telnyx was briefly unreachable. Bounded to future
 * appointments — a confirmation for something that already happened is noise.
 */
export async function sweepConfirmations(deps: FollowUpDeps): Promise<FollowUpResult> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await appointmentsAwaitingConfirmation(deps.db, now);
  const result = empty();
  for (const appointment of due) await deliver(deps, appointment, 'confirmation', result);
  if (due.length > 0) deps.logger.info({ ...result, considered: due.length }, 'confirmation sweep');
  return result;
}

export async function sweepReminders(
  deps: FollowUpDeps,
  options: { leadHours?: number; windowHours?: number } = {},
): Promise<FollowUpResult> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await appointmentsDueForReminder(deps.db, now, options);
  const result = empty();
  for (const appointment of due) await deliver(deps, appointment, 'reminder', result);
  deps.logger.info({ ...result, considered: due.length }, 'reminder sweep');
  return result;
}

/**
 * Send one confirmation now, by appointment id.
 *
 * Used by the voice adapter the moment a booking succeeds, because a
 * confirmation that lands while the caller is still holding the phone is the
 * feature — one that arrives on the next cron tick is a receipt.
 *
 * Looks the appointment up through the same "awaiting confirmation" query
 * rather than taking it on trust: if it has already been confirmed, this
 * finds nothing and sends nothing, so a retried turn cannot double-text.
 */
export async function confirmNow(
  deps: FollowUpDeps,
  appointmentId: string,
): Promise<FollowUpResult> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await appointmentsAwaitingConfirmation(deps.db, now, 200);
  const appointment = due.find((a) => a.id === appointmentId);
  const result = empty();

  if (!appointment) {
    deps.logger.info({ appointment: appointmentId }, 'nothing to confirm — already sent or past');
    return result;
  }

  await deliver(deps, appointment, 'confirmation', result);
  return result;
}

/**
 * The owner's end-of-day message, for every business whose local clock has
 * just reached the summary hour.
 *
 * The hour is checked here, per business, rather than being trusted to the
 * cron: Render's scheduler is UTC, `Europe/Skopje` is UTC+1 or +2 depending on
 * the season, and a summary that arrives at 19:00 half the year reads as
 * broken. So the cron fires hourly and this decides whose evening it is.
 */
export async function sendDailySummaries(
  deps: FollowUpDeps,
  { hour = 20 }: { hour?: number } = {},
): Promise<FollowUpResult> {
  const now = (deps.now ?? (() => new Date()))();
  const result = empty();

  for (const business of await listBusinesses(deps.db)) {
    const localHour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: business.timezone,
        hour: '2-digit',
        hour12: false,
      }).format(now),
    );
    if (localHour !== hour) continue;

    /**
     * Day boundaries via the calendar, not by adding 86,400,000ms.
     *
     * `Europe/Skopje` changes offset twice a year, so on those two days a
     * fixed-millisecond "tomorrow" lands an hour inside today or inside the
     * day after. Stepping 26 hours puts us unambiguously somewhere in
     * tomorrow whichever way the clock moved, and the local date is then read
     * back off the calendar.
     */
    const today = toZonedParts(now, business.timezone);
    const dayStart = startOfZonedDay(business.timezone, today.year, today.month, today.day);

    const someTimeTomorrow = new Date(dayStart.getTime() + 26 * 3_600_000);
    const t = toZonedParts(someTimeTomorrow, business.timezone);
    const tomorrowStart = startOfZonedDay(business.timezone, t.year, t.month, t.day);

    const someTimeAfter = new Date(tomorrowStart.getTime() + 26 * 3_600_000);
    const a = toZonedParts(someTimeAfter, business.timezone);
    const dayAfterStart = startOfZonedDay(business.timezone, a.year, a.month, a.day);

    const dayEnd = new Date(tomorrowStart.getTime() - 1);
    const tomorrowEnd = new Date(dayAfterStart.getTime() - 1);

    const summary = await dailySummary(
      deps.db,
      business.id,
      dayStart,
      dayEnd,
      tomorrowStart,
      tomorrowEnd,
    );
    if (!summary) continue;

    if (!summary.ownerMobile) {
      result.skipped++;
      deps.logger.warn(
        { business: business.id },
        'no owner_mobile — nowhere to send the daily summary',
      );
      continue;
    }

    const language = messageLanguage(summary.languages);
    const text = dailySummaryText(summary, language);
    const cost = partsFor(text);

    try {
      const outcome = await deps.sms.send({ to: summary.ownerMobile, text });
      if (outcome.status === 'undeliverable') {
        result.skipped++;
        deps.logger.warn({ business: business.id, reason: outcome.reason }, 'summary not deliverable');
        continue;
      }
      result.sent++;
      deps.logger.info(
        {
          business: business.id,
          providerId: outcome.providerId,
          ...cost,
          ...(outcome.sentFrom ? { sentFrom: outcome.sentFrom } : {}),
        },
        outcome.senderSubstituted
          ? 'daily summary sent (carrier substituted the sender)'
          : 'daily summary sent',
      );
    } catch (error) {
      result.failed++;
      deps.logger.error(
        { business: business.id, err: error instanceof Error ? error.message : String(error) },
        'daily summary failed',
      );
    }
  }

  return result;
}
