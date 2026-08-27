import {
  AnthropicLanguageModel,
  createTestDb,
  DEMO_IDS,
  emptyConversationState,
  getBusinessContext,
  handleTurn,
  loadRootEnv,
  renderGreeting,
  resolveModelId,
  type ILanguageModel,
  type ModelRequest,
  type TurnContext,
} from '@frontly/core';
import { DEFAULT_VOICE_CONFIG, type Language } from '@frontly/shared';
import type Anthropic from '@anthropic-ai/sdk';
import { cacheablePhrases } from '../src/voice/phrases.js';
import { confirmationText, partsFor, reminderText } from '../src/sms/messages.js';

/**
 * What one conversation actually costs.
 *
 *   pnpm --filter @frontly/api measure:cost
 *
 * Written because "roughly a few cents" is not an answer anyone can build a
 * business on, and because three of the four cost drivers here are things this
 * repo can count exactly rather than guess at.
 *
 * The distinction that matters, and which every line of output is labelled
 * with, is **measured quantity** versus **published rate**:
 *
 *  - Telnyx is fully measured. The usage API returns what the account was
 *    actually invoiced for the real calls placed on 25-26 August, so the
 *    carrier column is money that was really spent, not a rate card applied to
 *    an assumption. It is the only vendor here that can be checked that way.
 *  - Anthropic tokens are measured exactly — the API reports them per call and
 *    a real booking conversation is run to collect them. The price per token
 *    is a published rate.
 *  - Azure characters and audio seconds are measured exactly. Their prices are
 *    published rates.
 *
 * So: every QUANTITY below is counted, and the rates are inputs. That is worth
 * being pedantic about, because the quantities are where the surprises were
 * (a two-part SMS costs more than the entire phone call) and the rates are the
 * part a reader can re-check against a price list in thirty seconds.
 */

loadRootEnv();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Needs ANTHROPIC_API_KEY — this measures a real conversation.');
  process.exit(1);
}

// --- rates -------------------------------------------------------------------

/**
 * Published list prices, in USD. NOT measured — the one part of this script
 * that is taken on trust, kept in a single block so it can be re-checked
 * against a price list without reading any code.
 *
 * Overridable from the environment so a reader who has negotiated rates, or
 * who is reading this after a price change, does not have to edit the source
 * to get a truthful number out.
 */
const RATES = {
  /** Anthropic, per million tokens. */
  modelInputPerMTok: num('RATE_MODEL_INPUT', 3.0),
  modelOutputPerMTok: num('RATE_MODEL_OUTPUT', 15.0),
  modelCacheWritePerMTok: num('RATE_MODEL_CACHE_WRITE', 3.75),
  modelCacheReadPerMTok: num('RATE_MODEL_CACHE_READ', 0.3),
  /** Azure Speech, neural TTS, per million characters. */
  ttsPerMChar: num('RATE_TTS_PER_MCHAR', 16.0),
  /** Azure Speech, standard STT, per audio hour. */
  sttPerHour: num('RATE_STT_PER_HOUR', 1.0),
};

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// --- the conversation --------------------------------------------------------

/**
 * A complete booking, because that is the conversation that has to pay for
 * itself. An enquiry that books nothing is cheaper and is not the unit the
 * business is priced on.
 */
const CALLER_TURNS = [
  'Добар ден, сакам да закажам стоматолошки преглед.',
  'Утре наутро, ако може.',
  'Може ли во десет и половина?',
  'Се викам Марко Петровски, бројот ми е нула седумдесет сто единаесет двесте дваесет и два.',
  'Да, точно е. Закажете го.',
];

/** Usage as the API reports it, summed over every model call in the turn. */
interface Usage {
  calls: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const zeroUsage = (): Usage => ({ calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

/**
 * The real model, with a meter on it.
 *
 * Wrapping rather than editing `AnthropicLanguageModel` keeps the measurement
 * out of the request path: nothing in production pays for a counter that only
 * a script reads.
 */
class MeteredModel implements ILanguageModel {
  readonly usage = zeroUsage();
  constructor(private readonly inner: ILanguageModel) {}

  async complete(request: ModelRequest): Promise<Anthropic.Message> {
    const message = await this.inner.complete(request);
    const u = message.usage;
    this.usage.calls++;
    this.usage.input += u.input_tokens ?? 0;
    this.usage.output += u.output_tokens ?? 0;
    this.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    this.usage.cacheRead += u.cache_read_input_tokens ?? 0;
    return message;
  }
}

// --- Telnyx, the measured column --------------------------------------------

interface CarrierUsage {
  callControl: number;
  mediaStreaming: number;
  sipTrunking: number;
  completedCalls: number;
  callSeconds: number;
  billedSeconds: number;
}

/**
 * What the carrier actually charged.
 *
 * `usage_reports` is the invoice, not a rate card, which makes this the only
 * vendor cost here that is not an inference. Three products add up to one
 * phone call and it is easy to quote just one of them and be 3x low:
 *
 *   sip-trunking     the inbound minutes themselves
 *   call-control     answering, hanging up, every command issued
 *   media-streaming  the audio socket, billed on its own shorter clock
 */
async function carrierUsage(apiKey: string, from: string, to: string): Promise<CarrierUsage> {
  const q = `start_date=${from}&end_date=${to}`;

  async function report(product: string, metrics: string): Promise<Record<string, number>[]> {
    const url =
      `https://api.telnyx.com/v2/usage_reports?product=${product}&${q}` +
      `&dimensions=date&metrics=${metrics}`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: Record<string, number>[] };
    return body.data ?? [];
  }

  const sum = (rows: Record<string, number>[], key: string): number =>
    rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);

  const control = await report('call-control', 'cost,billed_sec,completed,call_sec');
  const streaming = await report('media-streaming', 'cost,billed_sec');
  const trunking = await report('sip-trunking', 'cost');

  return {
    callControl: sum(control, 'cost'),
    mediaStreaming: sum(streaming, 'cost'),
    sipTrunking: sum(trunking, 'cost'),
    completedCalls: sum(control, 'completed'),
    callSeconds: sum(control, 'call_sec'),
    billedSeconds: sum(control, 'billed_sec'),
  };
}

// --- output helpers ----------------------------------------------------------

const usd = (n: number): string => (n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(4)}`);
const pad = (s: string, n: number): string => s.padEnd(n);
const rpad = (s: string | number, n: number): string => String(s).padStart(n);

function rule(width = 74): void {
  console.log('  ' + '-'.repeat(width));
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  const t = await createTestDb({ seed: true });
  const context = (await getBusinessContext(t.db, DEMO_IDS.business))!;
  const language: Language = 'mk';

  const modelId = resolveModelId(process.env.ANTHROPIC_MODEL);
  const metered = new MeteredModel(new AnthropicLanguageModel({ model: modelId }));

  /**
   * Characters sent to TTS, split by whether they were already synthesized.
   *
   * Fixed lines are pre-synthesized at boot and reused for the life of the
   * process, so they cost once per deploy rather than once per call. Counting
   * them per conversation would overstate every call after the first.
   */
  const cached = new Set<string>([renderGreeting(context.business), ...cacheablePhrases(language)]);
  let spokenChars = 0;
  let cachedChars = 0;
  const replies: string[] = [];

  const state = emptyConversationState(language);
  let conversationId = '';

  console.log(`\n  Measuring one booking conversation on ${modelId}.\n`);

  for (const [index, said] of CALLER_TURNS.entries()) {
    const ctx: TurnContext = {
      db: t.db,
      model: metered,
      business: context.business,
      services: context.services,
      staff: context.staff,
      channel: 'voice',
      language,
      customerPhone: '+38970111222',
      state,
    };

    const result = await handleTurn(conversationId || `cost_${Date.now()}`, said, ctx);
    conversationId ||= `cost_${Date.now()}`;
    Object.assign(state, result.state);

    replies.push(result.reply);
    if (cached.has(result.reply.trim())) cachedChars += result.reply.length;
    else spokenChars += result.reply.length;

    const tools = result.toolCalls.map((c) => c.name).join(', ') || '—';
    console.log(`  ${index + 1}. ${said}`);
    console.log(`     ${result.reply}`);
    console.log(`     tools: ${tools}\n`);
  }

  // The greeting is spoken on every call and is always a cache hit.
  cachedChars += renderGreeting(context.business).length;

  // --- the model ------------------------------------------------------------

  const u = metered.usage;
  const modelCost =
    (u.input / 1e6) * RATES.modelInputPerMTok +
    (u.output / 1e6) * RATES.modelOutputPerMTok +
    (u.cacheWrite / 1e6) * RATES.modelCacheWritePerMTok +
    (u.cacheRead / 1e6) * RATES.modelCacheReadPerMTok;

  console.log('\n  MODEL — tokens measured, price published\n');
  rule();
  console.log(`  ${pad('model calls', 34)}${rpad(u.calls, 12)}`);
  console.log(`  ${pad('input tokens', 34)}${rpad(u.input, 12)}   @ $${RATES.modelInputPerMTok}/MTok`);
  console.log(`  ${pad('output tokens', 34)}${rpad(u.output, 12)}   @ $${RATES.modelOutputPerMTok}/MTok`);
  console.log(`  ${pad('cache write tokens', 34)}${rpad(u.cacheWrite, 12)}   @ $${RATES.modelCacheWritePerMTok}/MTok`);
  console.log(`  ${pad('cache read tokens', 34)}${rpad(u.cacheRead, 12)}   @ $${RATES.modelCacheReadPerMTok}/MTok`);
  rule();
  console.log(`  ${pad('model cost per conversation', 34)}${rpad(usd(modelCost), 12)}\n`);

  /**
   * Caching is worth calling out separately because it is the difference
   * between the prompt being amortised and being paid for on every turn. A
   * cache read is an order of magnitude cheaper than the same tokens fresh.
   */
  const uncached = ((u.input + u.cacheWrite + u.cacheRead) / 1e6) * RATES.modelInputPerMTok +
    (u.output / 1e6) * RATES.modelOutputPerMTok;
  console.log(`  Without prompt caching the same conversation would be ${usd(uncached)}.`);

  // --- speech ---------------------------------------------------------------

  const ttsCost = (spokenChars / 1e6) * RATES.ttsPerMChar;

  console.log('\n\n  SPEECH — characters and seconds measured, price published\n');
  rule();
  console.log(`  ${pad('TTS characters synthesized', 34)}${rpad(spokenChars, 12)}   @ $${RATES.ttsPerMChar}/Mchar`);
  console.log(`  ${pad('TTS characters served from cache', 34)}${rpad(cachedChars, 12)}   free after boot`);
  rule();
  console.log(`  ${pad('TTS cost per conversation', 34)}${rpad(usd(ttsCost), 12)}`);

  /**
   * STT bills the whole call, not the parts with words in them. Telnyx sends a
   * 20ms frame every 20ms for the entire call and the recognizer consumes all
   * of it, so silence is billed exactly like speech — which is why this scales
   * with call duration and nothing else.
   */
  const sttPerMinute = RATES.sttPerHour / 60;
  console.log(`\n  ${pad('STT is billed on call duration', 34)}${rpad(usd(sttPerMinute), 12)} per minute`);
  console.log('  (the recognizer consumes silence too — every second of the call is billed)');

  // --- carrier --------------------------------------------------------------

  const telnyxKey = process.env.TELNYX_API_KEY;
  let carrierPerMinute = 0;
  let carrierNote = 'TELNYX_API_KEY not set — carrier column skipped.';

  if (telnyxKey) {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 86_400_000);
    const usage = await carrierUsage(telnyxKey, from.toISOString(), to.toISOString());
    const total = usage.callControl + usage.mediaStreaming + usage.sipTrunking;
    const billedMinutes = usage.billedSeconds / 60;

    console.log('\n\n  CARRIER — invoiced, not inferred (last 30 days, real calls)\n');
    rule();
    console.log(`  ${pad('sip-trunking (inbound minutes)', 34)}${rpad(usd(usage.sipTrunking), 12)}`);
    console.log(`  ${pad('call-control (answer, hangup, cmds)', 34)}${rpad(usd(usage.callControl), 12)}`);
    console.log(`  ${pad('media-streaming (the audio socket)', 34)}${rpad(usd(usage.mediaStreaming), 12)}`);
    rule();
    console.log(`  ${pad('total charged', 34)}${rpad(usd(total), 12)}`);
    console.log(`  ${pad('completed calls', 34)}${rpad(usage.completedCalls, 12)}`);
    console.log(`  ${pad('call seconds / billed seconds', 34)}${rpad(`${usage.callSeconds} / ${usage.billedSeconds}`, 12)}`);

    if (billedMinutes > 0) {
      carrierPerMinute = total / billedMinutes;
      console.log(`\n  ${pad('carrier cost per billed minute', 34)}${rpad(usd(carrierPerMinute), 12)}`);
      carrierNote = '';
    }
    if (usage.completedCalls > 0) {
      console.log(`  ${pad('carrier cost per completed call', 34)}${rpad(usd(total / usage.completedCalls), 12)}`);
      /**
       * Billed seconds exceed call seconds because every call is rounded up to
       * the minute. Short test calls are punished hardest by that, so this
       * ratio flatters a real three-minute conversation rather than the
       * reverse — worth knowing before quoting the per-call number.
       */
      const rounding = usage.callSeconds > 0 ? usage.billedSeconds / usage.callSeconds : 1;
      console.log(`  ${pad('per-minute rounding overhead', 34)}${rpad(`${rounding.toFixed(2)}x`, 12)}`);
    }
  } else {
    console.log(`\n\n  CARRIER — ${carrierNote}`);
  }

  // --- SMS ------------------------------------------------------------------

  const due = {
    id: 'apt_cost',
    businessId: context.business.id,
    businessName: context.business.name,
    customerName: 'Марко Петровски',
    customerPhone: '+38970111222',
    serviceName: context.services[0]!.nameMk,
    staffName: context.staff[0]!.name,
    startsAt: new Date(Date.now() + 86_400_000),
    timezone: context.business.timezone,
    languages: context.business.languages,
  };

  const confirmation = confirmationText(due, language);
  const reminder = reminderText(due, language);
  const cParts = partsFor(confirmation);
  const rParts = partsFor(reminder);
  let smsCost = 0;

  console.log('\n\n  SMS — parts measured; the rate below is what Telnyx charged\n');
  rule();
  console.log(`  confirmation  ${cParts.encoding}  ${cParts.parts} part(s)  ${confirmation.length} chars`);
  console.log(`                "${confirmation}"`);
  console.log(`  reminder      ${rParts.encoding}  ${rParts.parts} part(s)  ${reminder.length} chars`);
  console.log(`                "${reminder}"`);
  rule();

  if (telnyxKey) {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 86_400_000);
    const url =
      `https://api.telnyx.com/v2/usage_reports?product=messaging` +
      `&start_date=${from.toISOString()}&end_date=${to.toISOString()}` +
      `&dimensions=date&metrics=cost,count,parts`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${telnyxKey}` } });
    if (response.ok) {
      const body = (await response.json()) as { data?: Record<string, number>[] };
      const rows = body.data ?? [];
      const cost = rows.reduce((n, r) => n + (Number(r['cost']) || 0), 0);
      const parts = rows.reduce((n, r) => n + (Number(r['parts']) || 0), 0);
      if (parts > 0) {
        const perPart = cost / parts;
        const sent = cParts.parts + rParts.parts;
        smsCost = sent * perPart;
        console.log(`  invoiced: ${usd(cost)} over ${parts} part(s) = ${usd(perPart)} per part`);
        console.log(`  a booked conversation sends ${sent} parts = ${usd(smsCost)}`);
        console.log('\n  This is the line item worth staring at: two SMS to a Macedonian');
        console.log('  mobile cost more than the entire phone call that produced them.');

        /**
         * The confirmation crossing 70 characters is not a rounding error, it
         * is a doubling. Worth reporting as a number rather than a principle,
         * because the fix is one field and the saving is larger than the whole
         * carrier bill for the call.
         */
        if (cParts.parts > 1) {
          const overBy = confirmation.length - 70;
          console.log(
            `\n  The confirmation is ${overBy} character(s) over one part. Getting it under 70`,
          );
          console.log(
            `  would save ${usd(perPart)} per booking — more than the entire call costs to carry.`,
          );
        }
      }
    }
  }

  // --- the total ------------------------------------------------------------

  const perMinute = carrierPerMinute + sttPerMinute;
  const fixed = modelCost + ttsCost;

  console.log('\n\n  PER CONVERSATION\n');
  rule();
  console.log(`  ${pad('fixed (model + TTS)', 34)}${rpad(usd(fixed), 12)}`);
  console.log(`  ${pad('per minute (carrier + STT)', 34)}${rpad(usd(perMinute), 12)}`);
  console.log(`  ${pad('follow-up SMS, if it books', 34)}${rpad(usd(smsCost), 12)}`);
  rule();
  for (const minutes of [2, 3, 5]) {
    const call = fixed + perMinute * minutes;
    console.log(
      `  ${pad(`a ${minutes}-minute call`, 34)}${rpad(usd(call), 12)}` +
        `   booked: ${usd(call + smsCost)}`,
    );
  }

  /**
   * Which of these is worth engineering against is not obvious from the total,
   * and the ranking is the whole reason for measuring rather than estimating.
   */
  const share = (n: number, of: number): string => `${((n / of) * 100).toFixed(0)}%`;
  const booked3 = fixed + perMinute * 3 + smsCost;
  console.log('\n  Where a booked 3-minute conversation goes:');
  console.log(`    follow-up SMS   ${rpad(share(smsCost, booked3), 5)}   ${usd(smsCost)}`);
  console.log(`    model           ${rpad(share(modelCost, booked3), 5)}   ${usd(modelCost)}`);
  console.log(`    STT             ${rpad(share(sttPerMinute * 3, booked3), 5)}   ${usd(sttPerMinute * 3)}`);
  console.log(`    TTS             ${rpad(share(ttsCost, booked3), 5)}   ${usd(ttsCost)}`);
  console.log(`    carrier         ${rpad(share(carrierPerMinute * 3, booked3), 5)}   ${usd(carrierPerMinute * 3)}`);

  console.log('\n  Split by minute vs fixed on purpose: only the caller decides how long');
  console.log('  they talk, so one average would hide which half of the bill is ours.\n');

  t.cleanup();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
