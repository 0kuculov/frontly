import { loadRootEnv } from '@frontly/core';

/**
 * Read-only survey of what phone numbers can actually be bought.
 *
 * Every figure printed comes from a live API response. Nothing here writes,
 * purchases, or provisions anything — the only verbs are GET.
 *
 *   pnpm --filter @frontly/api check:numbers
 *
 * When a query fails because the account cannot make it, that failure is the
 * answer and gets printed as one: an unavailable option is exactly what we are
 * trying to discover, and a workaround would hide it.
 */

loadRootEnv();

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;

if (!SID || !TOKEN) {
  console.error(
    'Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in the repo-root .env first.\n' +
      'Both are read-only here; nothing is purchased.',
  );
  process.exit(1);
}

const AUTH = `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`;
const COUNTRIES = ['MK', 'GB', 'US'] as const;
const TYPES = ['Local', 'Mobile', 'National', 'TollFree'] as const;

type Country = (typeof COUNTRIES)[number];
type NumberType = (typeof TYPES)[number];

interface Probe<T> {
  ok: boolean;
  status: number;
  body?: T;
  error?: string;
}

async function get<T>(url: string): Promise<Probe<T>> {
  try {
    const response = await fetch(url, { headers: { Authorization: AUTH } });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      const message =
        (parsed as { message?: string } | undefined)?.message ?? text.slice(0, 200);
      return { ok: false, status: response.status, error: message };
    }
    return { ok: true, status: response.status, body: parsed as T };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

// --- shapes we actually read -------------------------------------------------

interface CountriesList {
  countries: { country_code: string; country: string; beta: boolean }[];
}

interface CountryDetail {
  country: string;
  country_code: string;
  beta: boolean;
  subresource_uris: Record<string, string>;
}

interface AvailableNumbers {
  available_phone_numbers: {
    phone_number: string;
    friendly_name: string;
    iso_country: string;
    address_requirements: string;
    beta: boolean;
    capabilities: { voice: boolean; SMS: boolean; MMS: boolean };
  }[];
}

interface NumberPricing {
  country: string;
  iso_country: string;
  price_unit: string;
  phone_number_prices: { number_type: string; base_price: string; current_price: string }[];
}

interface VoicePricing {
  country: string;
  iso_country: string;
  price_unit: string;
  inbound_call_prices: { number_type: string; base_price: string; current_price: string }[];
}

interface Regulations {
  results: {
    sid: string;
    friendly_name: string;
    iso_country: string;
    number_type: string;
    end_user_type: string;
    requirements?: unknown;
  }[];
}

interface Row {
  country: Country;
  type: NumberType;
  available: string;
  addressRequirements: string;
  monthly: string;
  inbound: string;
  note: string;
}

// --- the survey --------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n=== 1. Countries Twilio sells numbers in ===\n');

  const countries = await get<CountriesList>(
    `https://api.twilio.com/2010-04-01/Accounts/${SID}/AvailablePhoneNumbers.json?PageSize=1000`,
  );

  if (!countries.ok) {
    console.log(`  FAILED (HTTP ${countries.status}): ${countries.error}`);
    console.log('  Everything below depends on this call, so stopping here.\n');
    return;
  }

  const list = countries.body!.countries;
  console.log(`  ${list.length} countries offered to this account.`);
  for (const cc of COUNTRIES) {
    const found = list.find((c) => c.country_code === cc);
    console.log(
      `  ${cc}: ${found ? `LISTED (${found.country}${found.beta ? ', beta' : ''})` : 'NOT LISTED'}`,
    );
  }

  console.log('\n=== 2. Number types offered per country ===\n');

  const subresources = new Map<Country, string[]>();
  for (const cc of COUNTRIES) {
    const detail = await get<CountryDetail>(
      `https://api.twilio.com/2010-04-01/Accounts/${SID}/AvailablePhoneNumbers/${cc}.json`,
    );
    if (!detail.ok) {
      console.log(`  ${cc}: FAILED (HTTP ${detail.status}) ${detail.error}`);
      subresources.set(cc, []);
      continue;
    }
    const kinds = Object.keys(detail.body!.subresource_uris ?? {});
    subresources.set(cc, kinds);
    console.log(`  ${cc}: ${kinds.length > 0 ? kinds.join(', ') : '(none)'}`);
  }

  console.log('\n=== 3. Live inventory + address requirements ===\n');

  const rows: Row[] = [];
  const inventory = new Map<string, { count: number; addressReq: string; voice: boolean; note: string }>();

  for (const cc of COUNTRIES) {
    for (const type of TYPES) {
      const probe = await get<AvailableNumbers>(
        `https://api.twilio.com/2010-04-01/Accounts/${SID}/AvailablePhoneNumbers/${cc}/${type}.json?PageSize=20&VoiceEnabled=true`,
      );

      const key = `${cc}:${type}`;

      if (!probe.ok) {
        // A 404 here means the country simply has no such type. Anything else
        // is an account restriction, which is itself the answer.
        const note =
          probe.status === 404
            ? 'type not offered in this country'
            : `HTTP ${probe.status}: ${probe.error}`;
        inventory.set(key, { count: 0, addressReq: '—', voice: false, note });
        console.log(`  ${cc} ${type.padEnd(9)} : ${note}`);
        continue;
      }

      const numbers = probe.body!.available_phone_numbers ?? [];
      const voiceCapable = numbers.filter((n) => n.capabilities.voice);
      const reqs = [...new Set(numbers.map((n) => n.address_requirements))];
      const beta = numbers.some((n) => n.beta);

      inventory.set(key, {
        count: voiceCapable.length,
        addressReq: reqs.join('/') || '—',
        voice: voiceCapable.length > 0,
        note: beta ? 'beta' : '',
      });

      console.log(
        `  ${cc} ${type.padEnd(9)} : ${voiceCapable.length} voice-capable in sample` +
          `, address_requirements=${reqs.join('/') || 'n/a'}${beta ? ' (beta)' : ''}` +
          (numbers[0] ? `  e.g. ${numbers[0].friendly_name}` : ''),
      );
    }
  }

  console.log('\n=== 4. Pricing (live, per this account) ===\n');

  const numberPrices = new Map<Country, Map<string, string>>();
  const inboundPrices = new Map<Country, Map<string, string>>();
  const currency = new Map<Country, string>();

  for (const cc of COUNTRIES) {
    const np = await get<NumberPricing>(`https://pricing.twilio.com/v1/PhoneNumbers/Countries/${cc}`);
    if (np.ok) {
      const map = new Map<string, string>();
      for (const p of np.body!.phone_number_prices) map.set(p.number_type.toLowerCase(), p.current_price);
      numberPrices.set(cc, map);
      currency.set(cc, np.body!.price_unit);
      console.log(
        `  ${cc} number rental (${np.body!.price_unit}/month): ` +
          np.body!.phone_number_prices.map((p) => `${p.number_type}=${p.current_price}`).join(', '),
      );
    } else {
      console.log(`  ${cc} number rental: FAILED (HTTP ${np.status}) ${np.error}`);
    }

    const vp = await get<VoicePricing>(`https://pricing.twilio.com/v2/Voice/Countries/${cc}`);
    if (vp.ok) {
      const map = new Map<string, string>();
      for (const p of vp.body!.inbound_call_prices) map.set(p.number_type.toLowerCase(), p.current_price);
      inboundPrices.set(cc, map);
      console.log(
        `  ${cc} inbound voice (${vp.body!.price_unit}/min):  ` +
          vp.body!.inbound_call_prices.map((p) => `${p.number_type}=${p.current_price}`).join(', '),
      );
    } else {
      console.log(`  ${cc} inbound voice: FAILED (HTTP ${vp.status}) ${vp.error}`);
    }
  }

  console.log('\n=== 5. Regulatory bundles required ===\n');

  for (const cc of COUNTRIES) {
    for (const numberType of ['local', 'mobile', 'national', 'toll-free']) {
      const reg = await get<Regulations>(
        `https://numbers.twilio.com/v2/RegulatoryCompliance/Regulations?IsoCountry=${cc}&NumberType=${numberType}&PageSize=20`,
      );
      if (!reg.ok) {
        console.log(`  ${cc} ${numberType.padEnd(10)}: FAILED (HTTP ${reg.status}) ${reg.error}`);
        continue;
      }
      const results = reg.body!.results ?? [];
      if (results.length === 0) {
        console.log(`  ${cc} ${numberType.padEnd(10)}: no regulation on file (no bundle required)`);
        continue;
      }
      for (const r of results) {
        console.log(
          `  ${cc} ${numberType.padEnd(10)}: BUNDLE REQUIRED — ${r.friendly_name} ` +
            `[end user: ${r.end_user_type}]`,
        );
      }
    }
  }

  // --- summary table --------------------------------------------------------

  console.log('\n=== SUMMARY ===\n');
  console.log(
    '  country  type       available  address_req   monthly     inbound/min',
  );
  console.log('  ' + '-'.repeat(72));

  for (const cc of COUNTRIES) {
    for (const type of TYPES) {
      const inv = inventory.get(`${cc}:${type}`);
      if (!inv) continue;
      const key = type === 'TollFree' ? 'toll free' : type.toLowerCase();
      const monthly = numberPrices.get(cc)?.get(key) ?? '—';
      const inbound = inboundPrices.get(cc)?.get(key) ?? '—';
      const unit = currency.get(cc) ?? '';

      rows.push({
        country: cc,
        type,
        available: inv.voice ? 'yes' : 'no',
        addressRequirements: inv.addressReq,
        monthly: monthly === '—' ? '—' : `${monthly} ${unit}`,
        inbound: inbound === '—' ? '—' : `${inbound} ${unit}`,
        note: inv.note,
      });

      console.log(
        `  ${cc.padEnd(8)} ${type.padEnd(10)} ${(inv.voice ? 'yes' : 'no').padEnd(10)} ` +
          `${inv.addressReq.padEnd(13)} ${String(rows.at(-1)!.monthly).padEnd(11)} ${rows.at(-1)!.inbound}` +
          (inv.note ? `   (${inv.note})` : ''),
      );
    }
  }

  console.log('\n=== 6. Telnyx ===\n');
  await checkTelnyx();
  console.log();
}

/**
 * Telnyx for comparison. Their v2 API is Bearer-authenticated throughout, so
 * without an account this can only establish whether an anonymous read is
 * possible at all — which is the question that was asked.
 */
async function checkTelnyx(): Promise<void> {
  try {
    const response = await fetch(
      'https://api.telnyx.com/v2/available_phone_numbers?filter[country_code]=MK&filter[features][]=voice',
      { headers: { Accept: 'application/json' } },
    );
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      console.log(
        `  Requires an account. Anonymous request returned HTTP ${response.status}. ` +
          'Skipped, as instructed.',
      );
      return;
    }
    console.log(`  HTTP ${response.status}: ${text.slice(0, 300)}`);
  } catch (error) {
    console.log(`  Request failed: ${error instanceof Error ? error.message : error}`);
  }
}

main().catch((error: unknown) => {
  console.error('check failed:', error);
  process.exit(1);
});
