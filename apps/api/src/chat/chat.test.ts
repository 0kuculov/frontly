import {
  conversations,
  createTestDb,
  DEMO_IDS,
  getBusinessContext,
  scriptedText,
  scriptedToolUse,
  ScriptedLanguageModel,
  type BusinessContext,
  type TestDatabase,
} from '@frontly/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChatSessions } from './session.js';

/**
 * The chat channel.
 *
 * The thing worth proving is not that a browser can post JSON — it is that
 * chat is genuinely the SAME engine over the SAME table, told apart by one
 * column. If that holds, adding Viber or WhatsApp later is another adapter
 * and not another engine. If it does not, the Phase 2 boundary was decorative.
 */

let testDb: TestDatabase;
let context: BusinessContext;

beforeAll(async () => {
  testDb = await createTestDb({ seed: true });
  context = (await getBusinessContext(testDb.db, DEMO_IDS.business))!;
});

afterAll(() => testDb?.cleanup());

beforeEach(async () => {
  await testDb.db.delete(conversations);
});

function sessions(model: ScriptedLanguageModel, overrides = {}) {
  return new ChatSessions({ db: testDb.db, model, context, ...overrides });
}

describe('a chat conversation', () => {
  it('writes to the same conversations table, marked as chat', async () => {
    const store = sessions(new ScriptedLanguageModel([scriptedText('Се разбира. За кој ден?')]));
    const { sessionId } = await store.open('mk');

    const [row] = await testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, sessionId));

    // One table, one shape, one dashboard component. The channel column is the
    // ONLY thing that distinguishes this from a phone call.
    expect(row!.channel).toBe('chat');
    expect(row!.businessId).toBe(DEMO_IDS.business);
    expect(row!.languageDetected).toBe('mk');
  });

  it('runs the same engine and records the exchange', async () => {
    const store = sessions(new ScriptedLanguageModel([scriptedText('Се разбира. За кој ден?')]));
    const { sessionId } = await store.open('mk');

    const result = await store.say(sessionId, 'Добар ден, сакам преглед.');
    expect(result!.reply).toContain('За кој ден');

    const [row] = await testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, sessionId));

    const transcript = row!.transcript as { role: string; text: string }[];
    expect(transcript.map((t) => t.role)).toEqual(['customer', 'agent']);
    expect(transcript[0]!.text).toContain('сакам преглед');
  });

  it('carries the tool calls into the transcript, as voice does', async () => {
    const store = sessions(
      new ScriptedLanguageModel([
        scriptedToolUse([
          {
            name: 'check_availability',
            input: {
              service_id: DEMO_IDS.services.checkup,
              date_from: '2099-01-05',
              date_to: '2099-01-05',
              staff_id: null,
            },
          },
        ]),
        scriptedText('Имаме слободно наутро.'),
      ]),
    );
    const { sessionId } = await store.open('mk');
    const result = await store.say(sessionId, 'Што имате слободно?');

    expect(result!.tools).toContain('check_availability');

    const [row] = await testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, sessionId));
    const transcript = row!.transcript as { role: string; toolCalls?: { name: string }[] }[];
    // The dashboard renders tool calls from the transcript; chat has to supply
    // them or a chat conversation reads as a chatbot next to a phone call.
    expect(transcript[1]!.toolCalls?.[0]?.name).toBe('check_availability');
  });

  it('ends the conversation when the engine concludes it', async () => {
    const store = sessions(
      new ScriptedLanguageModel([
        scriptedToolUse([{ name: 'end_call', input: {} }], 'Пријатен ден.'),
      ]),
    );
    const { sessionId } = await store.open('mk');
    const result = await store.say(sessionId, 'Тоа е сè, благодарам.');

    /**
     * `end_call` is a core concept, not a telephony one: voice hangs up after
     * a grace period, chat simply stops. Same signal, different adapter.
     */
    expect(result!.concluded).toBe(true);

    const [row] = await testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, sessionId));
    expect(row!.endedAt).not.toBeNull();

    // And the session is gone, so a stale tab cannot keep talking into it.
    expect(await store.say(sessionId, 'уште нешто?')).toBeUndefined();
  });

  it('answers an unknown or expired session with undefined, not a crash', async () => {
    const store = sessions(new ScriptedLanguageModel([]));
    expect(await store.say('chat_nope', 'здраво')).toBeUndefined();
  });

  it('forgets a session that has gone idle', async () => {
    let clock = 1_000_000;
    const store = sessions(new ScriptedLanguageModel([]), {
      idleMs: 1000,
      now: () => clock,
    });
    const { sessionId } = await store.open('mk');
    expect(store.size).toBe(1);

    clock += 5000;
    // Swept on the next touch rather than by a timer: a widget nobody is using
    // should not keep a process awake.
    expect(await store.say(sessionId, 'здраво')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('stops answering one visitor forever', async () => {
    const store = sessions(
      new ScriptedLanguageModel([scriptedText('Повелете.'), scriptedText('Повелете.')]),
      { maxMessages: 1 },
    );
    const { sessionId } = await store.open('mk');

    await store.say(sessionId, 'прво');
    // Every message costs tokens, and a public endpoint on somebody else's
    // website is not a place to trust the visitor to stop.
    const second = await store.say(sessionId, 'второ');
    expect(second!.concluded).toBe(true);
    expect(second!.reply).toContain('619');
  });

  it('opens in the language the visitor picked', async () => {
    const store = sessions(new ScriptedLanguageModel([scriptedText('Sigurisht.')]));
    const { sessionId } = await store.open('sq');
    const result = await store.say(sessionId, 'Përshëndetje.');
    expect(result!.reply).toBe('Sigurisht.');

    const [row] = await testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, sessionId));
    expect(row!.languageDetected).toBe('sq');
  });
});
