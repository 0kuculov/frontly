import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appointments,
  conversations,
  createTestDb,
  DEMO_IDS,
  getBusinessContext,
  ScriptedLanguageModel,
  scriptedText,
  scriptedToolUse,
  type BusinessContext,
  type Conversation,
  type Database,
  type TestDatabase,
} from '@frontly/core';
import type { Language } from '@frontly/shared';
import { PlaybackQueue, toFrames } from './audio.js';
import { CallSession, type CallSessionOptions } from './session.js';
import { buildStreamTwiml, isValidTwilioRequest, parseTwilioMessage } from './twilio.js';
import type {
  ISpeechProvider,
  ISpeechToText,
  ITextToSpeech,
  SpeechToTextHandlers,
  SpeechToTextOptions,
  SynthesisRequest,
} from './types.js';

/**
 * The call pipeline, driven end to end with fake speech.
 *
 * Nothing here touches Azure or Twilio: the point is the state machine —
 * greeting, barge-in, silence, low confidence, hang-up — which is where
 * call-handling bugs live. Azure itself is verified against the real service
 * by scripts/verify-azure.ts.
 */

let testDb: TestDatabase;
let db: Database;
let context: BusinessContext;

beforeAll(async () => {
  testDb = await createTestDb();
  db = testDb.db;
  context = (await getBusinessContext(db, DEMO_IDS.business))!;
});

afterAll(() => testDb?.cleanup());

beforeEach(async () => {
  await db.delete(appointments);
  await db.delete(conversations);
});

// --- fakes -------------------------------------------------------------------

class FakeTts implements ITextToSpeech {
  public readonly spoken: SynthesisRequest[] = [];
  public failNext = false;
  /** Frames per utterance. One drains instantly; more simulates real speech. */
  public frames = 1;

  async synthesize(request: SynthesisRequest): Promise<Buffer> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('synthesis exploded');
    }
    this.spoken.push(request);
    return Buffer.alloc(160 * this.frames, 0xff);
  }
  close(): void {}
}

class FakeStt implements ISpeechToText {
  public readonly ready = Promise.resolve();
  public readonly handlers: SpeechToTextHandlers;
  public readonly written: Buffer[] = [];
  public stopped = false;

  constructor(options: SpeechToTextOptions) {
    this.handlers = options.handlers;
  }
  write(mulaw: Buffer): void {
    this.written.push(mulaw);
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }

  say(text: string, confidence = 0.9, detectedLanguage?: Language): void {
    this.handlers.onSpeechStarted?.();
    this.handlers.onFinal({ text, confidence, ...(detectedLanguage ? { detectedLanguage } : {}) });
  }
}

class FakeProvider implements ISpeechProvider {
  public readonly tts = new FakeTts();
  public stt: FakeStt | undefined;
  createSynthesizer(): ITextToSpeech {
    return this.tts;
  }
  createRecognizer(options: SpeechToTextOptions): ISpeechToText {
    this.stt = new FakeStt(options);
    return this.stt;
  }
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

interface Harness {
  session: CallSession;
  provider: FakeProvider;
  callSid: string;
  frames: string[];
  clears: number;
  hangUps: number;
}

function makeSession(
  model: ScriptedLanguageModel,
  overrides: Partial<CallSessionOptions> = {},
): Harness {
  const provider = new FakeProvider();
  const callSid = `CA_test_${Math.random().toString(36).slice(2)}`;
  const harness: Harness = {
    provider,
    callSid,
    frames: [],
    clears: 0,
    hangUps: 0,
    session: undefined as unknown as CallSession,
  };

  harness.session = new CallSession({
    db,
    business: context.business,
    services: context.services,
    staff: context.staff,
    provider,
    model,
    callSid,
    from: '+38970111222',
    logger: silentLogger,
    onHangUp: () => {
      harness.hangUps++;
    },
    sink: {
      sendFrame: (b64) => harness.frames.push(b64),
      clear: () => {
        harness.clears++;
      },
    },
    frameIntervalMs: 1,
    silenceMs: 40,
    ...overrides,
  });

  return harness;
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function findConversation(callSid: string): Promise<Conversation | undefined> {
  const [row] = await db.select().from(conversations).where(eq(conversations.externalId, callSid));
  return row;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// --- audio framing -----------------------------------------------------------

describe('mulaw framing', () => {
  it('cuts audio into the 160-byte frames Twilio expects', () => {
    expect(toFrames(Buffer.alloc(480)).map((f) => f.length)).toEqual([160, 160, 160]);
  });

  it('pads a short tail with mulaw silence, not zeroes', () => {
    // 0x00 is full amplitude in mu-law; padding with it clicks audibly.
    const frames = toFrames(Buffer.alloc(200, 0x10));
    expect(frames).toHaveLength(2);
    expect(frames[1]!.length).toBe(160);
    expect(frames[1]![159]).toBe(0xff);
  });

  it('drops queued audio and flushes Twilio on interrupt', async () => {
    let cleared = 0;
    const sent: string[] = [];
    const queue = new PlaybackQueue({ sendFrame: (b) => sent.push(b), clear: () => cleared++ }, 1);

    queue.enqueue(Buffer.alloc(160 * 50, 0xff));
    expect(queue.isPlaying).toBe(true);

    queue.interrupt();
    expect(cleared).toBe(1);
    expect(queue.isPlaying).toBe(false);

    const atInterrupt = sent.length;
    await settle();
    expect(sent.length).toBe(atInterrupt); // nothing escapes afterwards
  });
});

// --- the call ----------------------------------------------------------------

describe('a call', () => {
  it('greets the caller in the clinic own words, with the configured pause', async () => {
    const h = makeSession(new ScriptedLanguageModel([]));
    await h.session.start();

    expect(h.provider.tts.spoken).toHaveLength(1);
    expect(h.provider.tts.spoken[0]!.text).toContain('Дентал Охрид');
    // The 300 ms gap between greeting and question is per-business config.
    expect(h.provider.tts.spoken[0]!.breakAfterFirstSentence).toBe(true);
    expect(h.provider.tts.spoken[0]!.profile.voiceName).toBe('mk-MK-AleksandarNeural');
    expect(h.frames.length).toBeGreaterThan(0);

    await h.session.stop('test');
  });

  it('runs a turn and writes the conversation row with transcript and tools', async () => {
    const tomorrow = new Date(Date.now() + 26 * 60 * 60 * 1000);
    const model = new ScriptedLanguageModel([
      scriptedToolUse([
        {
          name: 'check_availability',
          input: {
            service_id: DEMO_IDS.services.checkup,
            date_from: isoDate(tomorrow),
            date_to: isoDate(tomorrow),
            staff_id: null,
          },
        },
      ]),
      scriptedText('Имаме слободно утре наутро. Да го закажам?'),
    ]);

    const h = makeSession(model);
    await h.session.start();
    h.provider.stt!.say('Сакам термин утре наутро.', 0.92, 'mk');
    await settle(120);
    await h.session.stop('test');

    const conversation = await findConversation(h.callSid);
    expect(conversation).toBeDefined();
    expect(conversation!.channel).toBe('voice');
    expect(conversation!.languageDetected).toBe('mk');
    expect(conversation!.endedAt).not.toBeNull();
    expect(conversation!.fromIdentifier).toBe('+38970111222');

    const roles = conversation!.transcript.map((t) => t.role);
    expect(roles).toContain('customer');
    expect(roles).toContain('agent');

    // The agent turn records what it did, not only what it said — this is
    // what the Phase 7 live view replays.
    const agentTurn = conversation!.transcript.find((t) => t.role === 'agent');
    expect(agentTurn!.toolCalls?.map((c) => c.name)).toContain('check_availability');
  });

  it('locks onto the language the caller actually spoke', async () => {
    const h = makeSession(new ScriptedLanguageModel([scriptedText('Of course, one moment.')]));
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    h.provider.stt!.say('Do you speak English?', 0.9, 'en');
    await settle(120);

    // Every subsequent synthesis uses the English voice, not Macedonian.
    expect(h.provider.tts.spoken.length).toBeGreaterThan(0);
    for (const said of h.provider.tts.spoken) expect(said.language).toBe('en');

    await h.session.stop('test');
    expect((await findConversation(h.callSid))!.languageDetected).toBe('en');
  });

  it('stops talking the moment the caller starts', async () => {
    const h = makeSession(new ScriptedLanguageModel([]));
    // A realistic greeting: ~400 frames, so it is still playing when the
    // caller cuts in. With a one-frame greeting there is nothing to interrupt.
    h.provider.tts.frames = 400;

    // Deliberately not awaited — barge-in happens mid-playback, which is the
    // whole point.
    const started = h.session.start();
    await settle(10);
    expect(h.frames.length).toBeGreaterThan(0); // audio is flowing

    h.provider.stt!.handlers.onSpeechStarted?.();
    const framesAtBargeIn = h.frames.length;

    // clear() is the Twilio barge-in primitive. Without it the caller keeps
    // hearing buffered audio while they are speaking.
    expect(h.clears).toBe(1);

    await settle(30);
    // And nothing further goes out: the agent actually stopped.
    expect(h.frames.length).toBe(framesAtBargeIn);

    await started;
    await h.session.stop('test');
  });

  it('admits it did not catch a low-confidence utterance', async () => {
    const h = makeSession(new ScriptedLanguageModel([]));
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    h.provider.stt!.say('...шшш...', 0.15, 'mk');
    await settle();

    expect(h.provider.tts.spoken[0]!.text).toContain('не ве слушнав');
    // It never reached the model, so nothing was booked off a mumble.
    expect(await db.select().from(appointments)).toHaveLength(0);
    await h.session.stop('test');
  });

  it('reprompts on silence, then offers a callback and hangs up', async () => {
    const h = makeSession(new ScriptedLanguageModel([]));
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    await settle(70);
    expect(h.provider.tts.spoken.map((s) => s.text)).toContain('Сè уште сте тука?');

    await settle(90);
    const said = h.provider.tts.spoken.map((s) => s.text).join(' ');
    expect(said).toContain('колега да ви се јави');
    expect(h.hangUps).toBe(1);
  });

  it('speaks and offers a human when recognition fails', async () => {
    const h = makeSession(new ScriptedLanguageModel([]));
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    h.provider.stt!.handlers.onError(new Error('azure exploded'));
    await settle();

    // Never silence, never garbage audio.
    expect(h.provider.tts.spoken[0]!.text).toContain('не ве слушнав');
    await h.session.stop('test');

    expect((await findConversation(h.callSid))!.outcome).toBe('transferred');
  });

  it('survives a synthesis failure without dropping the call', async () => {
    const h = makeSession(new ScriptedLanguageModel([]));
    h.provider.tts.failNext = true;

    await expect(h.session.start()).resolves.toBeUndefined();
    await h.session.stop('test');
  });

  it('reuses one conversation row when Twilio retries the same call', async () => {
    const first = makeSession(new ScriptedLanguageModel([]));
    await first.session.start();
    await first.session.stop('test');

    const retry = makeSession(new ScriptedLanguageModel([]), { callSid: first.callSid });
    await retry.session.start();
    await retry.session.stop('test');

    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, first.callSid));
    expect(rows).toHaveLength(1);
  });
});

// --- twilio plumbing ---------------------------------------------------------

describe('twilio plumbing', () => {
  it('builds bidirectional TwiML carrying the business id', () => {
    const twiml = buildStreamTwiml({
      streamUrl: 'wss://frontly.onrender.com/voice/stream',
      businessId: DEMO_IDS.business,
      from: '+38970111222',
    });
    // Connect, not Start: bidirectional, and terminal so hang-up works.
    expect(twiml).toContain('<Connect>');
    expect(twiml).toContain('wss://frontly.onrender.com/voice/stream');
    expect(twiml).toContain(DEMO_IDS.business);
  });

  it('parses the media stream envelope and ignores junk', () => {
    const parsed = parseTwilioMessage(
      JSON.stringify({
        event: 'media',
        streamSid: 'MZ1',
        media: { track: 'inbound', payload: 'AAA=' },
      }),
    );
    expect(parsed?.event).toBe('media');
    expect(parseTwilioMessage('not json')).toBeUndefined();
  });

  it('rejects an unsigned request once an auth token exists', () => {
    expect(
      isValidTwilioRequest({
        authToken: 'secret',
        signature: undefined,
        url: 'https://x/y',
        params: {},
      }),
    ).toBe(false);
    // Unconfigured (local dev) stays open, or nothing could be tested at all.
    expect(
      isValidTwilioRequest({
        authToken: undefined,
        signature: undefined,
        url: 'https://x/y',
        params: {},
      }),
    ).toBe(true);
  });
});
