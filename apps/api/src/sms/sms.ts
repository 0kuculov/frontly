import type { SmsSender } from '@frontly/shared';
import { undeliverableReason } from '@frontly/shared';

/**
 * Sending a text message, behind an interface for the same reason telephony
 * is: the carrier changed once already (Twilio to Telnyx, because Twilio sells
 * no +389 inventory) and assuming it never will again is how vendor names end
 * up in schemas.
 *
 * Channel adapters live in `apps/api` and nowhere else. `packages/core` asks
 * *which* appointments owe a message; this decides how one is delivered.
 */

export type SmsOutcome =
  | { status: 'sent'; providerId: string }
  /**
   * The carrier will not carry it, and no retry will change that — a US long
   * code aimed at a +389 handset, for instance. Distinct from a thrown error
   * because a retry loop must not treat it as transient, and distinct from
   * success because nothing was delivered.
   */
  | { status: 'undeliverable'; reason: string };

export interface SmsMessage {
  to: string;
  text: string;
}

export interface ISmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<SmsOutcome>;
}

const API_BASE = 'https://api.telnyx.com/v2';

export interface TelnyxSmsOptions {
  apiKey: string;
  sender: SmsSender;
  fetchImpl?: typeof fetch;
}

export class TelnyxSmsProvider implements ISmsProvider {
  public readonly name = 'telnyx';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TelnyxSmsOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(message: SmsMessage): Promise<SmsOutcome> {
    const { sender } = this.options;

    /**
     * Refuse before spending a request on it.
     *
     * Telnyx ACCEPTS a US long code aimed at a Macedonian number and then
     * fails delivery asynchronously, so without this the only evidence is a
     * delivery receipt nobody is watching and an owner wondering why no
     * reminders arrived.
     */
    const refusal = undeliverableReason(sender, message.to);
    if (refusal) return { status: 'undeliverable', reason: refusal };

    const response = await this.fetchImpl(`${API_BASE}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: sender.from,
        to: message.to,
        text: message.text,
        // Required when `from` is a name rather than a number, harmless when
        // it is a number, so it goes whenever it is configured.
        ...(sender.messagingProfileId
          ? { messaging_profile_id: sender.messagingProfileId }
          : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      /**
       * A sender ID the account is not approved for is a configuration
       * problem, not a transient one — retrying it every hour until the
       * deadline would be pure noise in the logs.
       */
      if (response.status === 422 && /sender|from|profile/i.test(body)) {
        return {
          status: 'undeliverable',
          reason:
            `Telnyx rejected sender "${sender.from}" (HTTP 422): ${describe(body)}. ` +
            (sender.alphanumeric
              ? 'Alphanumeric sender IDs need enabling per destination country — check the ticket for MK.'
              : 'Check the number is on the messaging profile.'),
        };
      }
      throw new Error(`telnyx send failed (HTTP ${response.status}): ${describe(body)}`);
    }

    const body = (await response.json().catch(() => ({}))) as { data?: { id?: unknown } };
    const providerId = typeof body.data?.id === 'string' ? body.data.id : 'unknown';
    return { status: 'sent', providerId };
  }
}

/** Trim a provider error to something a log line can hold. */
function describe(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}
