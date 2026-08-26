import type { Language } from './language.js';

/**
 * Who an SMS comes from, and what Telnyx needs alongside it.
 *
 * The one place in the codebase that knows the difference between sending
 * from a phone number and sending from a name, so that switching between them
 * is a variable rather than a rewrite.
 *
 * This matters because the two are not interchangeable for this product. The
 * account's only number is a US long code with `international_outbound: false`
 * — checked on the live account, not assumed — so it can reach US handsets and
 * nothing else. Every actual customer is a +389 Macedonian mobile, reached by
 * alphanumeric sender ID, which is the normal way to send one-way
 * notifications across the Balkans and needs no A2P 10DLC registration
 * (that framework is US-domestic and would not have helped).
 *
 * So the US number is what can be tested with today, and `FRONTLY` is what
 * ships once Telnyx enables MK. `TELNYX_SMS_FROM` is the switch.
 */
export interface SmsSender {
  /** E.164 number or alphanumeric sender ID, exactly as Telnyx wants it. */
  from: string;
  /**
   * Telnyx requires this whenever `from` is alphanumeric — there is no number
   * to look the profile up from, so it must be named. Harmless when sending
   * from a number, so it is passed whenever it is configured.
   */
  messagingProfileId?: string | undefined;
  /** True when `from` is a name rather than a number. */
  alphanumeric: boolean;
}

/**
 * A sender is a number if it is digits (optionally with a leading +).
 *
 * Deliberately not a full E.164 validation: the question here is only which
 * of the two Telnyx modes to use, and a malformed number should be rejected
 * by Telnyx with its own error rather than silently reinterpreted as a name.
 */
export function isPhoneNumberSender(from: string): boolean {
  return /^\+?\d+$/.test(from.trim());
}

export interface SmsSenderEnv {
  TELNYX_SMS_FROM?: string | undefined;
  TELNYX_MESSAGING_PROFILE_ID?: string | undefined;
  TELNYX_PHONE_NUMBER?: string | undefined;
}

/**
 * Resolve the sender, or explain what is missing.
 *
 * Falls back to the voice number when no SMS sender is configured, so a
 * deployment that has a Telnyx number but has not thought about messaging yet
 * can still send to a US handset for testing.
 */
export function smsSender(env: SmsSenderEnv): SmsSender | undefined {
  const from = (env.TELNYX_SMS_FROM ?? env.TELNYX_PHONE_NUMBER ?? '').trim();
  if (!from) return undefined;

  const alphanumeric = !isPhoneNumberSender(from);
  return {
    from,
    ...(env.TELNYX_MESSAGING_PROFILE_ID
      ? { messagingProfileId: env.TELNYX_MESSAGING_PROFILE_ID }
      : {}),
    alphanumeric,
  };
}

/**
 * Can this sender reach this destination at all?
 *
 * A US long code cannot deliver to +389, and Telnyx accepts the request and
 * then fails delivery — so without this check the failure is invisible until
 * someone notices no reminders arrived. Returning a reason rather than a
 * boolean means the log says which configuration problem it hit.
 */
export function undeliverableReason(sender: SmsSender, to: string): string | undefined {
  if (sender.alphanumeric) return undefined;
  const destinationIsUs = /^\+?1\d{10}$/.test(to.replace(/[\s-]/g, ''));
  if (destinationIsUs) return undefined;

  return (
    `${sender.from} is a US long code and ${to} is an international destination. ` +
    'Telnyx reports international_outbound: false for this number, so the message ' +
    'would be accepted and never delivered. Set TELNYX_SMS_FROM to an approved ' +
    'alphanumeric sender ID (with TELNYX_MESSAGING_PROFILE_ID) to reach it.'
  );
}

/** Which language a follow-up message should be written in. */
export type SmsLanguage = Language;
