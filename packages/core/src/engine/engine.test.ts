import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import {
  appointments,
  businesses,
  services,
  staff,
  type Business,
  type Service,
  type StaffMember,
} from '../db/schema.js';
import { DEMO_IDS } from '../db/seed.js';
import { createTestDb, type TestDatabase } from '../db/testing.js';
import { bookAppointment } from '../booking/booking.js';
import { fromZonedWallClock } from '../time/zone.js';
import { handleTurn } from './handle-turn.js';
import {
  AnthropicLanguageModel,
  DEFAULT_MODEL,
  resolveModelId,
  ScriptedLanguageModel,
  scriptedText,
  scriptedToolUse,
} from './model.js';
import { sanitizeForSpeech, type LatinLeak } from './sanitize.js';
import { buildSystemPrompt } from './prompt.js';
import { emptyConversationState, type ILanguageModel, type TurnContext } from './types.js';

/**
 * The engine with no channel attached.
 *
 * Every conversation here runs against a scripted model, so the tests are
 * deterministic and need no API key. What they prove is the machinery: tools
 * dispatch, results come back shaped for speech, state advances, and the
 * guards fire. Whether the real model obeys the Macedonian prompt is a
 * separate question that only a live key can answer — see engine.live.test.ts.
 */

const SKOPJE = 'Europe/Skopje';
/** Monday 7 September 2026, 08:00 in Ohrid. "Tomorrow" is Tuesday the 8th. */
const NOW = fromZonedWallClock(SKOPJE, 2026, 9, 7, 8, 0);
const TUESDAY_1030 = fromZonedWallClock(SKOPJE, 2026, 9, 8, 10, 30);
const TUESDAY_1400 = fromZonedWallClock(SKOPJE, 2026, 9, 8, 14, 0);

let testDb: TestDatabase;
let db: Database;
let business: Business;
let allServices: Service[];
let allStaff: StaffMember[];

beforeAll(async () => {
  testDb = await createTestDb();
  db = testDb.db;
  business = (await db.select().from(businesses).where(eq(businesses.id, DEMO_IDS.business)))[0]!;
  allServices = await db.select().from(services).where(eq(services.businessId, DEMO_IDS.business));
  allStaff = await db.select().from(staff).where(eq(staff.businessId, DEMO_IDS.business));
});

afterAll(() => testDb?.cleanup());

beforeEach(async () => {
  await db.delete(appointments).where(eq(appointments.businessId, DEMO_IDS.business));
});

function makeCtx(model: ILanguageModel, overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    db,
    model,
    business,
    services: allServices,
    staff: allStaff,
    channel: 'voice',
    language: 'mk',
    customerPhone: '+38970111222',
    state: emptyConversationState('mk'),
    now: NOW,
    ...overrides,
  };
}

const checkTomorrow = {
  service_id: DEMO_IDS.services.checkup,
  date_from: '2026-09-08',
  date_to: '2026-09-08',
  staff_id: null,
};

describe('a full booking conversation in Macedonian', () => {
  it('goes from "I want an appointment" to a row in the database', async () => {
    const model = new ScriptedLanguageModel([
      // 1. Caller opens.
      scriptedText('Се разбира. За кој ден би сакале да закажете преглед?'),
      // 2. Caller says tomorrow morning -> look it up, then offer.
      scriptedToolUse([{ name: 'check_availability', input: checkTomorrow }]),
      scriptedText('Утре имаме слободно во девет часот наутро или во десет и половина наутро.'),
      // 3. Caller picks 10:30 -> read the whole thing back before booking.
      scriptedText(
        'Значи, стоматолошки преглед кај д-р Ана Смилевска, утре, во десет и половина наутро, ' +
          'на име Марко Петровски. Дали е точно?',
      ),
      // 4. Caller confirms -> only now is the tool called.
      scriptedToolUse([
        {
          name: 'book_appointment',
          input: {
            service_id: DEMO_IDS.services.checkup,
            staff_id: DEMO_IDS.staff.ana,
            starts_at: TUESDAY_1030.toISOString(),
            customer_name: 'Марко Петровски',
            customer_contact: '+38970111222',
          },
        },
      ]),
      scriptedText('Закажано. Ве очекуваме утре во десет и половина наутро.'),
    ]);

    const ctx = makeCtx(model);

    const t1 = await handleTurn('conv_1', 'Добар ден, сакам да закажам преглед.', ctx);
    expect(t1.reply).toContain('За кој ден');
    expect(t1.toolCalls).toHaveLength(0);
    ctx.state = t1.state;

    const t2 = await handleTurn('conv_1', 'Утре наутро, ако може.', ctx);
    expect(t2.toolCalls.map((c) => c.name)).toEqual(['check_availability']);
    ctx.state = t2.state;

    // Availability came from the database, not from the model.
    const offered = t2.toolCalls[0]!.output as { slots: { starts_at: string; spoken: string }[] };
    expect(offered.slots.length).toBeGreaterThan(0);
    // Each slot arrives pre-phrased, so the model never formats a date itself.
    expect(offered.slots[0]!.spoken).toMatch(/утре|вторник/);
    // 10:30 is genuinely free, so it is bookable even though the spoken
    // shortlist only names a few times.
    expect(
      ctx.state.offeredSlots.some((s) => s.startsAt === TUESDAY_1030.toISOString()),
    ).toBe(true);

    const t3 = await handleTurn('conv_1', 'Десет и половина ми одговара.', ctx);
    // The confirmation turn must NOT have booked anything yet.
    expect(t3.toolCalls).toHaveLength(0);
    expect(t3.reply).toContain('Дали е точно');
    ctx.state = t3.state;

    const t4 = await handleTurn('conv_1', 'Да, точно.', ctx);
    expect(t4.toolCalls.map((c) => c.name)).toEqual(['book_appointment']);
    ctx.state = t4.state;

    // The actual outcome: a real row.
    const rows = await db.select().from(appointments).where(eq(appointments.businessId, business.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      customerName: 'Марко Петровски',
      staffId: DEMO_IDS.staff.ana,
      status: 'booked',
      channel: 'voice',
    });
    expect(rows[0]!.startsAt.getTime()).toBe(TUESDAY_1030.getTime());

    expect(ctx.state.outcome).toBe('booked');
    expect(ctx.state.appointmentId).toBe(rows[0]!.id);
    expect(ctx.state.turnCount).toBe(4);
  });

  it('shows times from across the day, not just the first few of the morning', async () => {
    // Regression: a chronological cap meant the shortlist was exhausted before
    // 11am, so a caller asking about the afternoon was quoted mornings.
    const model = new ScriptedLanguageModel([
      scriptedToolUse([{ name: 'check_availability', input: checkTomorrow }]),
      scriptedText('Имаме неколку слободни термини утре.'),
    ]);

    const ctx = makeCtx(model);
    const result = await handleTurn('conv_spread', 'Што имате слободно утре?', ctx);

    const shown = (result.toolCalls[0]!.output as { slots: { starts_at: string }[] }).slots;
    const hours = shown.map((s) => Number(s.starts_at.slice(11, 13)) + 2); // UTC -> CEST
    expect(Math.min(...hours)).toBeLessThan(12);
    expect(Math.max(...hours)).toBeGreaterThanOrEqual(15);
  });

  it('never lets the model book a time it was not offered', async () => {
    // The rule "never invent availability" is enforced here, not just asked
    // for in the prompt: 07:00 was never returned by check_availability.
    const model = new ScriptedLanguageModel([
      scriptedToolUse([
        {
          name: 'book_appointment',
          input: {
            service_id: DEMO_IDS.services.checkup,
            staff_id: DEMO_IDS.staff.ana,
            starts_at: fromZonedWallClock(SKOPJE, 2026, 9, 8, 7, 0).toISOString(),
            customer_name: 'Марко',
            customer_contact: '+38970111222',
          },
        },
      ]),
      scriptedText('Извинете, да проверам повторно кога има слободно.'),
    ]);

    const ctx = makeCtx(model);
    const result = await handleTurn('conv_2', 'Закажи ме утре во седум наутро.', ctx);

    expect(result.toolCalls[0]!.error).toMatch(/slot_not_offered/);
    const rows = await db.select().from(appointments);
    expect(rows).toHaveLength(0);
  });
});

describe('rescheduling', () => {
  it('moves an existing appointment to a newly offered time', async () => {
    const existing = await bookAppointment(db, {
      business,
      serviceId: DEMO_IDS.services.checkup,
      staffId: DEMO_IDS.staff.ana,
      startsAt: TUESDAY_1030,
      customerName: 'Марко Петровски',
      customerPhone: '+38970111222',
      channel: 'voice',
      now: NOW,
    });

    const model = new ScriptedLanguageModel([
      // Look for another time first — a reschedule obeys the same rule.
      scriptedToolUse([{ name: 'check_availability', input: checkTomorrow }]),
      scriptedText('Имаме слободно утре во два часот попладне. Да го преместам таму?'),
      scriptedToolUse([
        {
          name: 'reschedule_appointment',
          input: { appointment_id: existing.id, new_starts_at: TUESDAY_1400.toISOString() },
        },
      ]),
      scriptedText('Преместено е за утре, во два часот попладне.'),
    ]);

    const ctx = makeCtx(model);

    const t1 = await handleTurn('conv_3', 'Може ли да го поместам терминот попладне?', ctx);
    ctx.state = t1.state;
    const t2 = await handleTurn('conv_3', 'Да, ве молам.', ctx);
    ctx.state = t2.state;

    expect(t2.toolCalls.map((c) => c.name)).toEqual(['reschedule_appointment']);

    const [row] = await db.select().from(appointments).where(eq(appointments.id, existing.id));
    expect(row!.startsAt.getTime()).toBe(TUESDAY_1400.getTime());
    expect(row!.status).toBe('booked');
    expect(ctx.state.outcome).toBe('rescheduled');

    // Still exactly one appointment — a reschedule moves, it does not duplicate.
    const all = await db.select().from(appointments);
    expect(all).toHaveLength(1);
  });
});

describe('questions outside booking', () => {
  it('transfers instead of guessing at a price that is not in the database', async () => {
    const model = new ScriptedLanguageModel([
      scriptedToolUse([
        {
          name: 'transfer_to_human',
          input: { reason: 'Прашање за цена на имплант, услугата не е во системот.' },
        },
      ]),
      scriptedText('Тоа не можам да ви го кажам со сигурност. Ќе ве поврзам со колега.'),
    ]);

    const ctx = makeCtx(model);
    const result = await handleTurn('conv_4', 'Колку чини имплант?', ctx);

    expect(result.toolCalls.map((c) => c.name)).toEqual(['transfer_to_human']);
    expect(result.state.outcome).toBe('transferred');
    expect(result.state.transferReason).toContain('имплант');
    expect(result.reply).toContain('колега');

    // Nothing was booked as a side effect of a question.
    expect(await db.select().from(appointments)).toHaveLength(0);
  });
});

describe('two callers racing for the same slot', () => {
  it('recovers when the slot is taken between the offer and the confirmation', async () => {
    const model = new ScriptedLanguageModel([
      // 1. Offer 10:30.
      scriptedToolUse([{ name: 'check_availability', input: checkTomorrow }]),
      scriptedText('Слободно е утре во десет и половина наутро. Да го закажам?'),
      // 2. Caller says yes — but by now someone else has taken it. The booking
      //    is rejected, so the model looks again and offers a different time.
      scriptedToolUse([
        {
          name: 'book_appointment',
          input: {
            service_id: DEMO_IDS.services.checkup,
            staff_id: DEMO_IDS.staff.ana,
            starts_at: TUESDAY_1030.toISOString(),
            customer_name: 'Марко Петровски',
            customer_contact: '+38970111222',
          },
        },
      ]),
      scriptedToolUse([{ name: 'check_availability', input: checkTomorrow }]),
      scriptedText('Извинете, тој термин штотуку се зафати. Може ли утре во единаесет часот наутро?'),
    ]);

    const ctx = makeCtx(model);

    const t1 = await handleTurn('conv_5', 'Утре наутро, ако може.', ctx);
    ctx.state = t1.state;
    expect((t1.toolCalls[0]!.output as { slots: unknown[] }).slots.length).toBeGreaterThan(0);

    // The other caller wins the slot in between.
    await bookAppointment(db, {
      business,
      serviceId: DEMO_IDS.services.checkup,
      staffId: DEMO_IDS.staff.ana,
      startsAt: TUESDAY_1030,
      customerName: 'Друг Пациент',
      customerPhone: '+38971999888',
      channel: 'chat',
      now: NOW,
    });

    const t2 = await handleTurn('conv_5', 'Да, закажете ме.', ctx);

    // The booking attempt failed with slot_taken, and the agent went back for
    // more availability rather than telling the caller it was done.
    expect(t2.toolCalls.map((c) => c.name)).toEqual(['book_appointment', 'check_availability']);
    expect(t2.toolCalls[0]!.error).toMatch(/slot_taken/);
    expect(t2.reply).toContain('Извинете');

    // Exactly one appointment at 10:30 — the other caller's.
    const rows = await db.select().from(appointments);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.customerName).toBe('Друг Пациент');
  });
});

describe('failure handling', () => {
  it('says something sensible when the model is unreachable', async () => {
    // A phone line cannot carry a stack trace.
    const broken: ILanguageModel = {
      async complete() {
        throw new Error('529 overloaded_error');
      },
    };

    const ctx = makeCtx(broken);
    const result = await handleTurn('conv_6', 'Добар ден.', ctx);

    expect(result.reply).toBe('Извинете, имам мал технички проблем. Ќе ве поврзам со колега.');
    expect(result.state.outcome).toBe('transferred');
    expect(result.toolCalls[0]!.error).toContain('529');
  });

  it('hands over rather than looping forever on tool calls', async () => {
    const model = new ScriptedLanguageModel(
      Array.from({ length: 6 }, () =>
        scriptedToolUse([{ name: 'check_availability', input: checkTomorrow }]),
      ),
    );

    const ctx = makeCtx(model, { maxToolIterations: 3 });
    const result = await handleTurn('conv_7', 'Кога сте слободни?', ctx);

    expect(result.state.outcome).toBe('transferred');
    expect(result.reply).toContain('колега');
    expect(model.callCount).toBe(3);
  });
});

describe('the system prompt', () => {
  it('renders the clinic’s own services, staff and hours', () => {
    const prompt = buildSystemPrompt({
      business,
      services: allServices,
      staff: allStaff,
      language: 'mk',
      now: NOW,
      customerPhone: '+38970111222',
    });

    expect(prompt).toContain('Дентал Охрид');
    expect(prompt).toContain(DEMO_IDS.services.checkup);
    expect(prompt).toContain('д-р Ана Смилевска');
    expect(prompt).toContain('сабота: 09:00–13:00');
    expect(prompt).toContain('недела: затворено');
    // Today's date, so "tomorrow" resolves correctly.
    expect(prompt).toContain('2026-09-07');
    expect(prompt).toContain('+38970111222');
  });

  it('switches only the reply language, keeping one set of rules', () => {
    const base = { business, services: allServices, staff: allStaff, now: NOW };
    expect(buildSystemPrompt({ ...base, language: 'sq' })).toContain('албански');
    expect(buildSystemPrompt({ ...base, language: 'en' })).toContain('Reply ONLY in English');
    // The rules themselves stay Macedonian in every language.
    expect(buildSystemPrompt({ ...base, language: 'en' })).toContain('НИКОГАШ НЕ ИЗМИСЛУВАЈ ТЕРМИНИ');
  });
});

describe('speech safety', () => {
  it('strips the markdown a model reaches for when listing options', () => {
    // Observed on a real call: bullets and bold in a spoken reply. Azure would
    // read the asterisks aloud.
    const raw = 'Значи закажувам:\n- **Стоматолошки преглед**\n- *Утре во десет*\n\nДали потврдувате?';
    expect(sanitizeForSpeech(raw)).toBe(
      'Значи закажувам: Стоматолошки преглед Утре во десет Дали потврдувате?',
    );
  });

  it('leaves ordinary Macedonian untouched', () => {
    const plain = 'Слободно е утре во десет и половина наутро. Да го закажам?';
    expect(sanitizeForSpeech(plain)).toBe(plain);
  });

  it('converts a Latin leak and reports it, without touching proper nouns', async () => {
    // End to end: the clinic's own names come from the DB via handleTurn, so a
    // Latin-branded service name must survive while "ime" is rewritten.
    const leaks: LatinLeak[] = [];
    const model = new ScriptedLanguageModel([
      scriptedText('Закажано на ime Марко, услуга Dental check-up.'),
    ]);

    const result = await handleTurn(
      'conv_latin',
      'Потврди.',
      makeCtx(model, { onLatinLeak: (leak) => leaks.push(leak) }),
    );

    expect(result.reply).toContain('на име Марко');
    expect(result.reply).toContain('Dental check-up');
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.converted).toEqual(['ime']);
  });

  it('runs on every reply the engine returns', async () => {
    const model = new ScriptedLanguageModel([scriptedText('- **Готово**\n- Утре во десет')]);
    const result = await handleTurn('conv_md', 'Добро.', makeCtx(model));
    expect(result.reply).not.toMatch(/[*_`\n]/);
    expect(result.reply).toBe('Готово Утре во десет');
  });
});

describe('model selection', () => {
  const original = process.env.ANTHROPIC_MODEL;
  afterAll(() => {
    if (original === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = original;
  });

  it('reads ANTHROPIC_MODEL from the environment', () => {
    // Regression: this variable was declared in the env schema and read by
    // nobody, so every call silently used the hardcoded constant instead.
    process.env.ANTHROPIC_MODEL = 'claude-opus-5';
    expect(resolveModelId()).toBe('claude-opus-5');
    expect(new AnthropicLanguageModel({ apiKey: 'sk-test' }).model).toBe('claude-opus-5');
  });

  it('lets an explicit argument win over the environment', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-5';
    expect(resolveModelId('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('falls back to Sonnet 5 when nothing is set', () => {
    delete process.env.ANTHROPIC_MODEL;
    expect(resolveModelId()).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5');
  });

  it('ignores a blank environment value', () => {
    process.env.ANTHROPIC_MODEL = '   ';
    expect(resolveModelId()).toBe(DEFAULT_MODEL);
  });
});

describe('streaming for time-to-first-audio', () => {
  it('emits each sentence as it completes, before the turn finishes', async () => {
    const model = new ScriptedLanguageModel([
      scriptedText('Слободно е утре во десет и половина наутро. Да го закажам?'),
    ]);

    const sentences: string[] = [];
    const result = await handleTurn(
      'conv_stream',
      'Што имате утре?',
      makeCtx(model, { onSentence: (s) => sentences.push(s) }),
    );

    expect(sentences).toEqual([
      'Слободно е утре во десет и половина наутро.',
      'Да го закажам?',
    ]);
    expect(result.reply).toContain('Слободно е утре');
  });

  it('sanitises each sentence on the way out, not just the final reply', async () => {
    const model = new ScriptedLanguageModel([scriptedText('- **Готово.** Закажано на ime Марко.')]);
    const sentences: string[] = [];
    await handleTurn('conv_stream2', 'Ок.', makeCtx(model, { onSentence: (s) => sentences.push(s) }));

    expect(sentences.join(' ')).not.toMatch(/[*_]/);
    expect(sentences.join(' ')).toContain('на име Марко');
  });

  it('reports time-to-first-sentence separately from total turn time', async () => {
    const model = new ScriptedLanguageModel([
      scriptedToolUse([{ name: 'check_availability', input: checkTomorrow }]),
      scriptedText('Имаме слободно утре наутро. Кое време ви одговара?'),
    ]);

    const result = await handleTurn(
      'conv_timing',
      'Што имате утре?',
      makeCtx(model, { onSentence: () => {} }),
    );

    // What the caller perceives vs what a benchmark measures.
    expect(result.timings.toFirstSentenceMs).toBeDefined();
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(result.timings.toFirstSentenceMs!);
    expect(result.timings.modelCalls).toBe(2);
    expect(result.timings.toolMs).toBeGreaterThanOrEqual(0);
  });

  it('costs nothing when the adapter does not ask for sentences', async () => {
    const model = new ScriptedLanguageModel([scriptedText('Добро.')]);
    const result = await handleTurn('conv_nostream', 'Ок.', makeCtx(model));
    expect(result.timings.toFirstSentenceMs).toBeUndefined();
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
  });
});

describe('ending the conversation', () => {
  /**
   * Nothing used to tell an adapter a conversation was OVER. The agent said
   * its goodbye as ordinary text, the voice session had no idea, and the
   * silence ladder reprompted a caller who had already been dismissed —
   * farewell, dead air, "сè уште сте тука?". Heard on a real call.
   */
  it('marks the state concluded and asks the model nothing further', async () => {
    const model = new ScriptedLanguageModel([
      scriptedToolUse([{ name: 'end_call', input: {} }], 'Пријатен ден.'),
    ]);
    const ctx = makeCtx(model);

    const turn = await handleTurn('conv_end', 'Тоа е сè, благодарам.', ctx);

    expect(turn.state.concluded).toBe(true);
    expect(turn.toolCalls.map((c) => c.name)).toEqual(['end_call']);
    /**
     * Exactly one model call. end_call returns nothing to talk about — the
     * goodbye was already spoken in the same message — so going round again
     * would spend a whole extra generation producing a second farewell on top
     * of the first.
     */
    expect(model.received).toHaveLength(1);
    expect(turn.reply).toContain('Пријатен ден');
  });

  it('concludes even when the goodbye was left unsaid', async () => {
    const model = new ScriptedLanguageModel([
      scriptedToolUse([{ name: 'end_call', input: {} }]),
    ]);
    const ctx = makeCtx(model);

    const turn = await handleTurn('conv_end_silent', 'Тоа е сè.', ctx);

    // The adapter speaks its own cached farewell in this case; what matters
    // here is that the engine does not go back to the model for one.
    expect(turn.state.concluded).toBe(true);
    expect(model.received).toHaveLength(1);
    // NOT the "model said nothing" apology, which used to fire here and put a
    // transfer apology in the caller's ear at the moment of hanging up.
    expect(turn.reply).toBe('');
    /**
     * And NOT recorded as a transfer. `transferred` is the single outcome the
     * stage metric counts as needing the owner, so mislabelling a clean
     * goodbye would quietly deflate the headline number.
     */
    expect(turn.state.outcome).toBe('info');
  });

  it('leaves an ordinary turn unconcluded', async () => {
    const model = new ScriptedLanguageModel([scriptedText('За кој ден ви одговара?')]);
    const ctx = makeCtx(model);

    const turn = await handleTurn('conv_open', 'Сакам термин.', ctx);
    expect(turn.state.concluded).toBeUndefined();
  });
});
