import { loadRootEnv } from '@frontly/core';

/**
 * Does the Telnyx account actually match what the code assumes?
 *
 * Read-only. Every request is a GET; nothing is bought, changed or dialled.
 * It exists because the alternative way to discover that a webhook URL has a
 * typo is to dial the number on stage.
 *
 *   pnpm --filter @frontly/api verify:telnyx
 */

loadRootEnv();

const KEY = process.env.TELNYX_API_KEY;
const NUMBER = process.env.TELNYX_PHONE_NUMBER;
/** A blank value in .env means "unset", not "set to the empty string". */
const BASE = process.env.PUBLIC_BASE_URL?.trim() || 'https://frontly.onrender.com';

if (!KEY) {
  console.error('TELNYX_API_KEY is not set in the repo-root .env.');
  process.exit(1);
}

const ok = (s: string) => `[32m✓[0m ${s}`;
const bad = (s: string) => `[31m✗[0m ${s}`;
const warn = (s: string) => `[33m![0m ${s}`;

let problems = 0;

async function get<T>(path: string): Promise<{ ok: boolean; status: number; body?: T; error?: string }> {
  const response = await fetch(`https://api.telnyx.com/v2${path}`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const errors = (parsed as { errors?: { detail?: string; title?: string }[] } | undefined)?.errors;
    return {
      ok: false,
      status: response.status,
      error: errors?.[0]?.detail ?? errors?.[0]?.title ?? text.slice(0, 200),
    };
  }
  return { ok: true, status: response.status, body: parsed as T };
}

interface PhoneNumber {
  id: string;
  phone_number: string;
  status: string;
  connection_id?: string;
  connection_name?: string;
}

interface Connection {
  id: string;
  connection_name?: string;
  active?: boolean;
  webhook_event_url?: string;
  webhook_api_version?: string;
  webhook_timeout_secs?: number;
  outbound?: { outbound_voice_profile_id?: string | null } | null;
}

async function main(): Promise<void> {
  console.log('\n  Telnyx configuration\n  ' + '-'.repeat(58));

  // --- the number ----------------------------------------------------------

  const numbers = await get<{ data: PhoneNumber[] }>('/phone_numbers?page[size]=50');
  if (!numbers.ok) {
    console.log(bad(`could not list phone numbers — HTTP ${numbers.status}: ${numbers.error}`));
    console.log('\n  The API key is wrong, revoked, or lacks permissions.\n');
    process.exit(1);
  }

  const owned = numbers.body!.data;
  console.log(ok(`API key works — ${owned.length} number(s) on the account`));

  const target = NUMBER
    ? owned.find((n) => n.phone_number.replace(/\D/g, '') === NUMBER.replace(/\D/g, ''))
    : owned[0];

  if (!target) {
    console.log(bad(`TELNYX_PHONE_NUMBER (${NUMBER ?? 'unset'}) is not on this account`));
    problems++;
  } else {
    console.log(ok(`${target.phone_number} — status ${target.status}`));
    if (target.status !== 'active') {
      console.log(warn(`  status is "${target.status}", not "active" — it may not receive calls`));
      problems++;
    }
    if (!target.connection_id) {
      console.log(bad('  no connection assigned — inbound calls have nowhere to go'));
      problems++;
    }
  }

  // --- the voice application ------------------------------------------------

  if (target?.connection_id) {
    const connection = await get<{ data: Connection }>(
      `/call_control_applications/${target.connection_id}`,
    );

    if (!connection.ok) {
      console.log(
        warn(
          `could not read the Call Control application (HTTP ${connection.status}: ${connection.error}) — ` +
            'the number may be on a different connection type',
        ),
      );
      problems++;
    } else {
      const app = connection.body!.data;
      const expected = `${BASE}/telnyx/voice`;

      console.log(ok(`application "${app.connection_name ?? app.id}"`));

      if (app.webhook_event_url === expected) {
        console.log(ok(`  webhook → ${app.webhook_event_url}`));
      } else {
        console.log(bad(`  webhook → ${app.webhook_event_url ?? '(none)'}`));
        console.log(`      expected ${expected}`);
        problems++;
      }

      if (app.webhook_api_version === '2') {
        console.log(ok('  webhook API version 2'));
      } else {
        console.log(
          bad(
            `  webhook API version is ${app.webhook_api_version ?? '(unset)'} — the adapter parses v2 events`,
          ),
        );
        problems++;
      }

      const profile = app.outbound?.outbound_voice_profile_id;
      if (profile) {
        console.log(ok('  outbound voice profile present — transfer_to_human can dial out'));
      } else {
        console.log(
          warn('  no outbound voice profile — transfer_to_human will apologise instead of transferring'),
        );
      }
    }
  }

  // --- webhook signing key --------------------------------------------------

  if (process.env.TELNYX_PUBLIC_KEY) {
    console.log(ok('TELNYX_PUBLIC_KEY is set — webhook signatures are verified'));
  } else {
    console.log(
      warn(
        'TELNYX_PUBLIC_KEY is not set — the webhook accepts unsigned requests. ' +
          'Telnyx portal → Account Settings → Keys & Credentials → Public Key.',
      ),
    );
    problems++;
  }

  // --- is a +389 number buyable yet? ---------------------------------------

  const mk = await get<{ data: { phone_number: string; phone_number_type?: string }[] }>(
    '/available_phone_numbers?filter[country_code]=MK&filter[features][]=voice&filter[limit]=5',
  );
  if (mk.ok) {
    const found = mk.body!.data ?? [];
    console.log(
      found.length > 0
        ? ok(`North Macedonia: ${found.length} voice number(s) available now (e.g. ${found[0]!.phone_number})`)
        : warn('North Macedonia: no +389 inventory available to this account yet'),
    );
  } else {
    console.log(warn(`North Macedonia lookup failed — HTTP ${mk.status}: ${mk.error}`));
  }

  console.log(
    '\n  ' +
      (problems === 0
        ? '[32mReady to take a call.[0m'
        : `[33m${problems} thing(s) to fix before calling.[0m`) +
      '\n',
  );
}

main().catch((error: unknown) => {
  console.error('verification failed:', error);
  process.exit(1);
});
