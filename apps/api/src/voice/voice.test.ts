import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appointments,
  conversations,
  createTestDb,
  DEMO_IDS,
  getBusinessContext,
  fromZonedWallClock,
  recognitionPhrases,
  renderGreeting,
  ScriptedLanguageModel,
  scriptedText,
  scriptedToolUse,
  type ILanguageModel,
  type ModelRequest,
  type BusinessContext,
  type Conversation,
  type Database,
  type TestDatabase,
} from '@frontly/core';
import {
  DEFAULT_RECOGNITION_CONFIG,
  DEFAULT_VOICE_CONFIG,
  recognitionFor,
  type Language,
  type RecognitionConfig,
} from '@frontly/shared';
import { PlaybackQueue, toFrames } from './audio.js';
import { CallSession, type CallSessionOptions } from './session.js';
import {
  CANNOT_HEAR,
  DID_NOT_CATCH,
  FAREWELL,
  FILLERS,
  REPROMPTS,
  isClosingCue,
} from './phrases.js';
import { phraseRequest, SpeechCache } from './speech-cache.js';
import { decodeClientState, encodeClientState, TelnyxProvider, telnyxMediaProtocol } from './telnyx.js';
import { warmBusiness, warmRequests } from './warm.js';
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
 * Nothing here touches Azure or a carrier: the point is the state machine —
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
  /** Azure takes a few hundred ms per sentence; instant synthesis hides bugs. */
  public delayMs = 0;

  async synthesize(request: SynthesisRequest): Promise<Buffer> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
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

  /** An unstable hypothesis: never a turn, but proof the caller is talking. */
  partial(text: string): void {
    this.handlers.onPartial?.(text);
  }
}

class FakeProvider implements ISpeechProvider {
  public readonly tts = new FakeTts();
  public stt: FakeStt | undefined;
  /** What the session asked the recognizer for — tuning must reach Azure. */
  public recognizerOptions: SpeechToTextOptions | undefined;
  createSynthesizer(): ITextToSpeech {
    return this.tts;
  }
  createRecognizer(options: SpeechToTextOptions): ISpeechToText {
    this.recognizerOptions = options;
    this.stt = new FakeStt(options);
    return this.stt;
  }
}

interface LogEvent {
  level: 'info' | 'warn' | 'error';
  message: string;
  payload: Record<string, unknown>;
}

interface Harness {
  session: CallSession;
  provider: FakeProvider;
  callRef: string;
  frames: string[];
  clears: number;
  hangUps: number;
  logs: LogEvent[];
  /** Filler texts played, in order — see the 'filler played' log line. */
  fillers: string[];
}

function makeSession(
  model: ILanguageModel,
  overrides: Partial<CallSessionOptions> = {},
): Harness {
  const provider = (overrides.provider as FakeProvider | undefined) ?? new FakeProvider();
  const callRef = `v3:test_${Math.random().toString(36).slice(2)}`;
  const logs: LogEvent[] = [];
  const harness: Harness = {
    provider,
    callRef,
    frames: [],
    clears: 0,
    hangUps: 0,
    logs,
    fillers: [],
    session: undefined as unknown as CallSession,
  };

  const record = (level: LogEvent['level']) => (payload: Record<string, unknown>, message: string) => {
    logs.push({ level, message, payload });
    if (message === 'filler played') harness.fillers.push(String(payload.text));
  };

  harness.session = new CallSession({
    db,
    business: context.business,
    services: context.services,
    staff: context.staff,
    provider,
    model,
    callRef,
    from: '+38970111222',
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
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
    /**
     * Pinned, like the two above it.
     *
     * These tests were written against a 800ms filler and several of them are
     * sensitive to whether one fires. Leaving it to the production default
     * means a tuning change — lowering it to 600 for the demo, say — quietly
     * alters the timing of a suite that is already timing-dependent, and the
     * failure surfaces as an unrelated low-confidence test going flaky. A test
     * should fail because behaviour changed, not because a constant moved.
     */
    fillerAfterMs: 800,
    ...overrides,
  });

  return harness;
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a condition instead of guessing how long it takes.
 *
 * `settle(10)` then asserting is a coin toss on Windows, where setTimeout's
 * floor is the ~15ms system timer tick: the greeting's first frame lands
 * after the check about as often as before it, and the test fails on a
 * machine where nothing has raised the timer resolution. Polling asserts the
 * same thing without pinning it to a clock this suite does not control.
 */
async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await settle(5);
  }
}

/** Recognition tuning for a test, over the shared defaults. */
function bargeIn(overrides: Partial<RecognitionConfig>): RecognitionConfig {
  return { ...DEFAULT_RECOGNITION_CONFIG, ...overrides };
}

async function findConversation(callRef: string): Promise<Conversation | undefined> {
  const [row] = await db.select().from(conversations).where(eq(conversations.externalId, callRef));
  return row;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// --- audio framing -----------------------------------------------------------

describe('mulaw framing', () => {
  it('cuts audio into the 160-byte frames the carrier expects', () => {
    expect(toFrames(Buffer.alloc(480)).map((f) => f.length)).toEqual([160, 160, 160]);
  });

  it('pads a short tail with mulaw silence, not zeroes', () => {
    // 0x00 is full amplitude in mu-law; padding with it clicks audibly.
    const frames = toFrames(Buffer.alloc(200, 0x10));
    expect(frames).toHaveLength(2);
    expect(frames[1]!.length).toBe(160);
    expect(frames[1]![159]).toBe(0xff);
  });

  it('drops queued audio and flushes the carrier on interrupt', async () => {
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

    const conversation = await findConversation(h.callRef);
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
    expect((await findConversation(h.callRef))!.languageDetected).toBe('en');
  });

  it('stops talking as soon as the caller is confirmed to be speaking', async () => {
    const h = makeSession(new ScriptedLanguageModel([]));
    // A realistic greeting: ~400 frames, so it is still playing when the
    // caller cuts in. With a one-frame greeting there is nothing to interrupt.
    h.provider.tts.frames = 400;

    // Deliberately not awaited — barge-in happens mid-playback, which is the
    // whole point.
    const started = h.session.start();
    // Audio is flowing. Polled rather than timed: the subject of this test is
    // barge-in, not how quickly the greeting starts.
    await waitFor(() => h.frames.length > 0);

    // Energy alone only arms it: this could still be a cough.
    h.provider.stt!.handlers.onSpeechStarted?.();
    expect(h.clears).toBe(0);

    // Words confirm it.
    h.provider.stt!.handlers.onPartial?.('Извинете');
    const framesAtBargeIn = h.frames.length;

    // clear() is the carrier barge-in primitive. Without it the caller keeps
    // hearing buffered audio while they are speaking.
    expect(h.clears).toBe(1);

    await settle(30);
    // And nothing further goes out: the agent actually stopped.
    expect(h.frames.length).toBe(framesAtBargeIn);

    // Stop BEFORE awaiting the greeting: stop() interrupts playback, so the
    // test no longer sits through 400 frames of it. On Windows setTimeout(fn, 1)
    // actually fires at ~15ms, making that wait ~6s — just past vitest's 5s
    // default, so this passed or failed depending on whether some other app
    // happened to have raised the system timer resolution.
    await h.session.stop('test');
    await started;
  });

  it('keeps talking through a cough that never becomes words', async () => {
    // Azure raises speech-start on energy alone. Treating that as barge-in
    // meant a door, a car horn or a cough killed the agent mid-sentence.
    const h = makeSession(new ScriptedLanguageModel([]), { recognition: bargeIn({ bargeInMs: 500 }) });
    h.provider.tts.frames = 400;
    const started = h.session.start();
    await settle(10);

    h.provider.stt!.handlers.onSpeechStarted?.();
    h.provider.stt!.handlers.onSpeechEnded?.();
    await settle(40);

    expect(h.clears).toBe(0);
    expect(h.logs.some((l) => l.message === 'ignored a noise burst that was not speech')).toBe(true);

    // Stop BEFORE awaiting the greeting: stop() interrupts playback, so the
    // test no longer sits through 400 frames of it. On Windows setTimeout(fn, 1)
    // actually fires at ~15ms, making that wait ~6s — just past vitest's 5s
    // default, so this passed or failed depending on whether some other app
    // happened to have raised the system timer resolution.
    await h.session.stop('test');
    await started;
  });

  it('gives up waiting and interrupts on sustained speech with no transcript yet', async () => {
    // Partials can lag. Someone genuinely talking must not have to wait for
    // Azure to produce words before the agent stops.
    const h = makeSession(new ScriptedLanguageModel([]), { recognition: bargeIn({ bargeInMs: 20 }) });
    h.provider.tts.frames = 400;
    const started = h.session.start();
    await settle(10);

    h.provider.stt!.handlers.onSpeechStarted?.();
    expect(h.clears).toBe(0);
    await settle(60);

    expect(h.clears).toBe(1);
    // Stop BEFORE awaiting the greeting: stop() interrupts playback, so the
    // test no longer sits through 400 frames of it. On Windows setTimeout(fn, 1)
    // actually fires at ~15ms, making that wait ~6s — just past vitest's 5s
    // default, so this passed or failed depending on whether some other app
    // happened to have raised the system timer resolution.
    await h.session.stop('test');
    await started;
  });

  it('ignores a partial too short to be anything but noise', async () => {
    const h = makeSession(new ScriptedLanguageModel([]), {
      recognition: bargeIn({ bargeInMs: 500, bargeInMinChars: 4 }),
    });
    h.provider.tts.frames = 400;
    const started = h.session.start();
    await settle(10);

    h.provider.stt!.handlers.onSpeechStarted?.();
    h.provider.stt!.handlers.onPartial?.('м');
    expect(h.clears).toBe(0);

    h.provider.stt!.handlers.onPartial?.('може');
    expect(h.clears).toBe(1);

    // Stop BEFORE awaiting the greeting: stop() interrupts playback, so the
    // test no longer sits through 400 frames of it. On Windows setTimeout(fn, 1)
    // actually fires at ~15ms, making that wait ~6s — just past vitest's 5s
    // default, so this passed or failed depending on whether some other app
    // happened to have raised the system timer resolution.
    await h.session.stop('test');
    await started;
  });

  it('admits it did not catch a low-confidence utterance', async () => {
    const h = makeSession(new ScriptedLanguageModel([]), {
      // The first one is deliberately met with silence; this is about what the
      // agent says once it is sure the line, not the pause, is the problem.
      recognition: { ...DEFAULT_RECOGNITION_CONFIG, lowConfidenceHoldMs: 20 },
    });
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    for (let i = 0; i < 3; i++) {
      h.provider.stt!.say('...шшш...', 0.15, 'mk');
      await settle();
    }

    expect(h.provider.tts.spoken[0]!.text).toContain('не ве слушнав');
    // It never reached the model, so nothing was booked off a mumble.
    expect(await db.select().from(appointments)).toHaveLength(0);
    await h.session.stop('test');
  });

  it('escalates through the reprompts, then offers a callback and STAYS ON', async () => {
    const h = makeSession(new ScriptedLanguageModel([]), { silenceMs: 60 });
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    await settle(120);
    const first = h.provider.tts.spoken.map((s) => s.text);
    expect(first).toContain(REPROMPTS.mk[0]);

    await settle(140);
    const second = h.provider.tts.spoken.map((s) => s.text);
    // Not the same sentence twice: repeating verbatim is what makes it read
    // as a stuck loop rather than a person checking in.
    expect(second).toContain(REPROMPTS.mk[1]);
    expect(REPROMPTS.mk[0]).not.toBe(REPROMPTS.mk[1]);

    await settle(160);
    const said = h.provider.tts.spoken.map((s) => s.text).join(' ');
    expect(said).toContain('колега да ви се јави');
    // The callback is offered, the line is NOT dropped. Every escape path used
    // to end in a hangup; a caller still on the line must never be one of them.
    expect(h.hangUps).toBe(0);
    expect(
      h.logs.some((l) => l.message === 'declined to hang up — the caller is still there'),
    ).toBe(true);
  });

  it('waits the configured time before checking in, measured from the last audio', async () => {
    const h = makeSession(new ScriptedLanguageModel([]), { silenceMs: 300 });
    h.provider.tts.frames = 40; // a greeting with real length
    await h.session.start();
    h.provider.tts.spoken.length = 0;
    const quietFrom = Date.now();

    // Well before the window: nothing yet.
    await settle(150);
    expect(h.provider.tts.spoken).toHaveLength(0);

    while (h.provider.tts.spoken.length === 0 && Date.now() - quietFrom < 2000) {
      await settle(20);
    }
    const waited = Date.now() - quietFrom;
    expect(h.provider.tts.spoken[0]!.text).toBe(REPROMPTS.mk[0]);
    // Allow a tick of slack either side, but it must not fire early.
    expect(waited).toBeGreaterThanOrEqual(280);
    await h.session.stop('test');
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

    expect((await findConversation(h.callRef))!.outcome).toBe('transferred');
  });

  it('survives a synthesis failure without dropping the call', async () => {
    const h = makeSession(new ScriptedLanguageModel([]));
    h.provider.tts.failNext = true;

    await expect(h.session.start()).resolves.toBeUndefined();
    await h.session.stop('test');
  });

  it('reuses one conversation row when the carrier retries the same call', async () => {
    const first = makeSession(new ScriptedLanguageModel([]));
    await first.session.start();
    await first.session.stop('test');

    const retry = makeSession(new ScriptedLanguageModel([]), { callRef: first.callRef });
    await retry.session.start();
    await retry.session.stop('test');

    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, first.callRef));
    expect(rows).toHaveLength(1);
  });
});


// --- concluding ---------------------------------------------------------------

describe('concluding the call', () => {
  /**
   * The bug this covers, seen on a real call: at ~45s the agent said goodbye
   * and wished the caller a nice day, the line stayed open, and at ~1min it
   * started the reprompt ladder — "сè уште сте тука?" at someone it had just
   * dismissed. Nothing marked a conversation as OVER, so the silence ladder
   * treated a completed farewell exactly like an abandoned caller.
   *
   * Two habits here are deliberate, and this suite punishes their absence:
   * every test sets `silenceMs` well clear of its own duration (the harness
   * default is 40ms, which reaches the callback-then-hang-up rung on its own
   * and makes `hangUps === 1` pass whether or not the farewell works), and
   * every session is stopped. Timers left running on real clocks leak into
   * the tests that follow.
   */
  const endedByFarewell = (h: Harness) =>
    h.logs.some((l) => l.message === 'hanging up — the conversation concluded');

  const saidGoodbye = () =>
    new ScriptedLanguageModel([
      scriptedToolUse([{ name: 'end_call', input: {} }], 'Пријатен ден и пријатно.'),
    ]);

  it('hangs up after the grace period even though the caller is present', async () => {
    const h = makeSession(saidGoodbye(), {
      silenceMs: 2000,
      recognition: bargeIn({ farewellGraceMs: 20 }),
    });
    await h.session.start();

    h.provider.stt!.say('Одлично, тоа е сè. Благодарам.', 0.94, 'mk');
    await settle(120);

    /**
     * The caller spoke moments ago, so `callerPresent` is true and the
     * presence rule — correctly — would refuse. A concluded conversation is
     * not an abandoned caller, and that is the whole distinction.
     */
    expect(endedByFarewell(h)).toBe(true);
    expect(h.hangUps).toBe(1);
    await h.session.stop('test');
  });

  it('never reprompts after a farewell', async () => {
    // Ladder every 30ms, goodbye grace far longer: if the watch were merely
    // left un-restarted rather than stopped, this window fits several ticks.
    const h = makeSession(saidGoodbye(), {
      silenceMs: 30,
      recognition: bargeIn({ farewellGraceMs: 250 }),
    });
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    h.provider.stt!.say('Тоа е сè, благодарам.', 0.94, 'mk');
    await settle(150);

    const said = h.provider.tts.spoken.map((t) => t.text);
    for (const reprompt of REPROMPTS.mk) expect(said).not.toContain(reprompt);
    expect(h.hangUps).toBe(0); // still inside the grace
    await h.session.stop('test');
  });

  it('keeps the line when the caller speaks during the grace', async () => {
    const h = makeSession(
      new ScriptedLanguageModel([
        scriptedToolUse([{ name: 'end_call', input: {} }], 'Пријатен ден.'),
        scriptedText('Се разбира, слушам.'),
      ]),
      { silenceMs: 2000, recognition: bargeIn({ farewellGraceMs: 150 }) },
    );
    await h.session.start();

    h.provider.stt!.say('Тоа е сè.', 0.94, 'mk');
    await settle(50);
    // "Actually, one more thing" — the goodbye was premature.
    h.provider.stt!.say('Извинете, уште едно прашање.', 0.94, 'mk');
    await settle(200);

    // Hanging up over the top of someone asking another question is the one
    // thing worse than the bug being fixed.
    expect(h.hangUps).toBe(0);
    expect(h.provider.tts.spoken.map((t) => t.text)).toContain('Се разбира, слушам.');
    await h.session.stop('test');
  });

  it('says a cached goodbye when the model concludes without speaking', async () => {
    const h = makeSession(
      new ScriptedLanguageModel([scriptedToolUse([{ name: 'end_call', input: {} }])]),
      { silenceMs: 2000, recognition: bargeIn({ farewellGraceMs: 20 }) },
    );
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    h.provider.stt!.say('Тоа е сè.', 0.94, 'mk');
    await settle(120);

    // Otherwise the line simply goes dead, which the caller cannot tell from
    // a dropped call.
    expect(h.provider.tts.spoken.map((t) => t.text)).toContain(FAREWELL.mk);
    expect(endedByFarewell(h)).toBe(true);
    await h.session.stop('test');
  });

  it('still refuses to hang up on a caller who merely went quiet', async () => {
    // The presence rule must survive this change: only a CONCLUDED
    // conversation may end while the caller is audibly there.
    const h = makeSession(new ScriptedLanguageModel([]), { silenceMs: 30 });
    await h.session.start();
    h.provider.stt!.say('Ало?', 0.94, 'mk');
    await settle(200);

    expect(h.hangUps).toBe(0);
    await h.session.stop('test');
  });
});

// --- transfer ----------------------------------------------------------------

describe('transfer to a human', () => {
  it('waits for the explanation to finish, then hands the call over', async () => {
    const handed: string[] = [];
    /**
     * The route is set here rather than taken from the seed.
     *
     * The seed's ownerMobile is NULL on purpose — a plausible Macedonian
     * number sitting in demo data is one formatting fix away from being
     * dialled on stage — so a test that read it would be asserting against
     * demo data instead of against this behaviour.
     */
    const owner = '+38970260100';
    const h = makeSession(
      new ScriptedLanguageModel([
        scriptedToolUse([{ name: 'transfer_to_human', input: { reason: 'medical question' } }]),
        scriptedText('Ве поврзувам со колега.'),
      ]),
      {
        business: { ...context.business, ownerMobile: owner },
        onTransfer: async (to) => void handed.push(to),
      },
    );

    await h.session.start();
    h.provider.stt!.say('Дали смее да се вади заб во бременост?', 0.93, 'mk');
    await settle(120);

    expect(handed).toEqual([owner]);
    // The carrier owns the call after a transfer; hanging up would drop it.
    expect(h.hangUps).toBe(0);
    expect((await findConversation(h.callRef))!.outcome).toBe('transferred');
  });

  it('admits it cannot transfer rather than pretending, when there is no route', async () => {
    const h = makeSession(
      new ScriptedLanguageModel([
        scriptedToolUse([{ name: 'transfer_to_human', input: { reason: 'medical question' } }]),
        scriptedText('Ве поврзувам со колега.'),
      ]),
      { onTransfer: undefined },
    );

    await h.session.start();
    h.provider.tts.spoken.length = 0;
    h.provider.stt!.say('Дали смее да се вади заб во бременост?', 0.93, 'mk');
    await settle(120);

    // No outbound voice profile is the expected state today, so this path is
    // the one a live demo would actually hit.
    const said = h.provider.tts.spoken.map((s) => s.text).join(' ');
    expect(said).toContain('колега да ви се јави');
    // Promising a callback is not a reason to drop the call.
    expect(h.hangUps).toBe(0);
  });

  it('does not strand the caller when the carrier refuses the transfer', async () => {
    const h = makeSession(
      new ScriptedLanguageModel([
        scriptedToolUse([{ name: 'transfer_to_human', input: { reason: 'medical question' } }]),
        scriptedText('Ве поврзувам со колега.'),
      ]),
      {
        onTransfer: async () => {
          throw new Error('outbound voice profile is not configured');
        },
      },
    );

    await h.session.start();
    h.provider.tts.spoken.length = 0;
    h.provider.stt!.say('Дали смее да се вади заб во бременост?', 0.93, 'mk');
    await settle(120);

    expect(h.provider.tts.spoken.map((s) => s.text).join(' ')).toContain('колега да ви се јави');
    expect(h.hangUps).toBe(0);
  });
});

// --- telnyx adapter ----------------------------------------------------------

/**
 * The carrier-specific half, tested against the shapes in Telnyx's docs rather
 * than against Twilio's by analogy. The cases below are the three places the
 * Twilio assumption was wrong, and each would have failed silently on a live
 * call: the stream id moved, outbound frames lost their identifier, and closing
 * the socket stopped ending the call.
 */
describe('telnyx media protocol', () => {
  const START = JSON.stringify({
    event: 'start',
    sequence_number: '1',
    start: {
      user_id: '3E6F995F-85F7-4705-9741-53B116D28237',
      call_control_id: 'v3:abc',
      call_session_id: 'sess-1',
      from: '+38970111222',
      to: '+16193497599',
      client_state: encodeClientState({ businessId: DEMO_IDS.business }),
      media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 },
    },
    stream_id: '32DE0DEA-53CB-4B21-89A4-9E1819C043BC',
  });

  it('reads stream_id from the top level, not from the start object', () => {
    expect(telnyxMediaProtocol.parse(START)).toMatchObject({
      kind: 'start',
      streamRef: '32DE0DEA-53CB-4B21-89A4-9E1819C043BC',
      callRef: 'v3:abc',
      from: '+38970111222',
      to: '+16193497599',
      format: { encoding: 'PCMU', sampleRate: 8000, channels: 1 },
    });
  });

  it('carries the business id from the answer command across to the socket', () => {
    // The webhook and the media socket are separate connections with no shared
    // memory, and two Render instances would not share a map either.
    expect(telnyxMediaProtocol.parse(START)).toMatchObject({
      clientState: { businessId: DEMO_IDS.business },
    });
    expect(decodeClientState(encodeClientState({ a: 'b' }))).toEqual({ a: 'b' });
    expect(decodeClientState('not base64 json')).toBeUndefined();
    expect(decodeClientState(undefined)).toBeUndefined();
  });

  it('sends outbound frames with no stream identifier', () => {
    // Twilio required streamSid on every frame; Telnyx does not.
    expect(JSON.parse(telnyxMediaProtocol.encodeMedia('AAA=', 'stream-1'))).toEqual({
      event: 'media',
      media: { payload: 'AAA=' },
    });
    expect(JSON.parse(telnyxMediaProtocol.encodeClear('stream-1'))).toEqual({ event: 'clear' });
  });

  it('parses media, dtmf, stop and error, and ignores junk', () => {
    expect(
      telnyxMediaProtocol.parse(
        JSON.stringify({ event: 'media', media: { track: 'inbound', payload: 'AAA=' } }),
      ),
    ).toEqual({ kind: 'audio', track: 'inbound', payload: 'AAA=' });

    expect(
      telnyxMediaProtocol.parse(JSON.stringify({ event: 'dtmf', dtmf: { digit: '1' } })),
    ).toEqual({ kind: 'dtmf', digit: '1' });

    expect(telnyxMediaProtocol.parse(JSON.stringify({ event: 'stop', stream_id: 's1' }))).toEqual({
      kind: 'stop',
      streamRef: 's1',
    });

    expect(
      telnyxMediaProtocol.parse(
        JSON.stringify({ event: 'error', payload: { code: 100004, detail: 'invalid media' } }),
      ),
    ).toEqual({ kind: 'error', code: 100004, detail: 'invalid media' });

    expect(telnyxMediaProtocol.parse('not json')).toBeUndefined();
    expect(telnyxMediaProtocol.parse('{}')).toBeUndefined();
  });
});

describe('telnyx call control', () => {
  interface Captured {
    url: string;
    body: Record<string, unknown>;
  }

  function stubbed(status = 200, text = '{}'): { calls: Captured[]; provider: TelnyxProvider } {
    const calls: Captured[] = [];
    const provider = new TelnyxProvider({
      apiKey: 'KEY_test',
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        return new Response(text, { status });
      }) as unknown as typeof fetch,
    });
    return { calls, provider };
  }

  it('answers and opens the media stream in one command', async () => {
    const { calls, provider } = stubbed();
    await provider.answer({
      callRef: 'v3:abc',
      streamUrl: 'wss://frontly.onrender.com/telnyx/stream',
      clientState: { businessId: DEMO_IDS.business },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.telnyx.com/v2/calls/v3%3Aabc/actions/answer');
    expect(calls[0]!.body).toMatchObject({
      stream_url: 'wss://frontly.onrender.com/telnyx/stream',
      // Our own playback must not be fed back into the recognizer.
      stream_track: 'inbound_track',
      stream_bidirectional_mode: 'rtp',
      // PCMU is mulaw 8 kHz — exactly what Azure emits, so nothing transcodes.
      stream_bidirectional_codec: 'PCMU',
      stream_bidirectional_sampling_rate: 8000,
    });
    expect(decodeClientState(calls[0]!.body.client_state as string)).toEqual({
      businessId: DEMO_IDS.business,
    });
  });

  it('sends a stable command id so a webhook retry cannot answer twice', async () => {
    const a = stubbed();
    const b = stubbed();
    await a.provider.answer({ callRef: 'v3:abc', streamUrl: 'wss://x/y' });
    await b.provider.answer({ callRef: 'v3:abc', streamUrl: 'wss://x/y' });
    expect(a.calls[0]!.body.command_id).toBe(b.calls[0]!.body.command_id);
    expect(a.calls[0]!.body.command_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('treats hanging up an already-dead call as success', async () => {
    // The caller hanging up mid-turn races every command we send.
    const { provider } = stubbed(404, '{"errors":[{"detail":"Call has ended"}]}');
    await expect(provider.hangup('v3:gone')).resolves.toBeUndefined();
  });

  it('explains that a transfer needs an outbound voice profile', async () => {
    const { provider } = stubbed(422, '{"errors":[{"detail":"No outbound profile"}]}');
    await expect(
      provider.transfer({ callRef: 'v3:abc', to: '+38970260100', from: '+16193497599' }),
    ).rejects.toThrow(/outbound voice profile/i);
  });

  it('maps the events it acts on and shrugs at the rest', () => {
    const provider = new TelnyxProvider({ apiKey: 'k' });
    expect(
      provider.parseEvent({
        data: {
          event_type: 'call.initiated',
          payload: {
            call_control_id: 'v3:abc',
            from: '+38970111222',
            to: '+16193497599',
            call_session_id: 'sess-1',
          },
        },
      }),
    ).toEqual({
      type: 'call.initiated',
      callRef: 'v3:abc',
      from: '+38970111222',
      to: '+16193497599',
      sessionId: 'sess-1',
    });

    // Some deliveries arrive without the `data` envelope.
    expect(
      provider.parseEvent({ event_type: 'call.hangup', payload: { call_control_id: 'v3:abc' } }),
    ).toMatchObject({ type: 'call.hangup', callRef: 'v3:abc' });

    expect(provider.parseEvent({ data: { event_type: 'call.machine.detection.ended' } })).toEqual({
      type: 'ignored',
      name: 'call.machine.detection.ended',
    });
    expect(provider.parseEvent('nope')).toBeUndefined();
  });
});

describe('telnyx webhook signatures', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  /** Telnyx publishes the raw 32-byte key; in SPKI that is the last 32 bytes. */
  const publicKeyB64 = publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64');

  const NOW = 1_800_000_000_000;
  const body = Buffer.from(JSON.stringify({ data: { event_type: 'call.initiated' } }));

  function sign(raw: Buffer, timestamp: number): string {
    return nodeSign(null, Buffer.concat([Buffer.from(`${timestamp}|`), raw]), privateKey).toString(
      'base64',
    );
  }

  function provider(): TelnyxProvider {
    return new TelnyxProvider({ apiKey: 'k', publicKey: publicKeyB64, now: () => NOW });
  }

  it('accepts a genuine signature over `timestamp|body`', () => {
    const ts = Math.floor(NOW / 1000);
    expect(
      provider().verifyWebhook({
        raw: body,
        headers: { 'telnyx-signature-ed25519': sign(body, ts), 'telnyx-timestamp': String(ts) },
      }),
    ).toBe(true);
  });

  it('rejects a body that changed after signing', () => {
    const ts = Math.floor(NOW / 1000);
    const signature = sign(body, ts);
    expect(
      provider().verifyWebhook({
        raw: Buffer.from(JSON.stringify({ data: { event_type: 'call.hangup' } })),
        headers: { 'telnyx-signature-ed25519': signature, 'telnyx-timestamp': String(ts) },
      }),
    ).toBe(false);
  });

  it('rejects a replayed request older than the tolerance', () => {
    const stale = Math.floor(NOW / 1000) - 400;
    expect(
      provider().verifyWebhook({
        raw: body,
        headers: {
          'telnyx-signature-ed25519': sign(body, stale),
          'telnyx-timestamp': String(stale),
        },
      }),
    ).toBe(false);
  });

  it('rejects a request carrying no signature at all', () => {
    expect(provider().verifyWebhook({ raw: body, headers: {} })).toBe(false);
  });

  it('stays open when no public key is configured, for local development', () => {
    const open = new TelnyxProvider({ apiKey: 'k' });
    expect(open.verifyWebhook({ raw: body, headers: {} })).toBe(true);
  });
});

// --- pre-synthesized speech --------------------------------------------------

/** A model that takes its time, so the filler timer actually fires. */
class SlowModel implements ILanguageModel {
  constructor(
    private readonly delayMs: number,
    private readonly text: string,
  ) {}

  async complete(request: ModelRequest): Promise<Anthropic.Message> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    request.onTextDelta?.(this.text);
    // Only the fields the engine reads. The SDK's Message grows optional
    // fields between versions and none of them matter here.
    return {
      id: 'msg_slow',
      type: 'message',
      role: 'assistant',
      model: 'test',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 } as Anthropic.Usage,
      content: [{ type: 'text', text: this.text, citations: null } as Anthropic.ContentBlock],
    } as Anthropic.Message;
  }
}

describe('speech cache', () => {
  const profile = DEFAULT_VOICE_CONFIG.mk;

  it('keys on the voice profile, not just the text', async () => {
    const provider = new FakeProvider();
    const cache = new SpeechCache(provider);

    await cache.warm(phraseRequest('Здраво.', 'mk', profile));

    expect(cache.get(phraseRequest('Здраво.', 'mk', profile))).toBeDefined();
    // Re-voicing a clinic from the dashboard must not serve the old voice.
    expect(
      cache.get(phraseRequest('Здраво.', 'mk', { ...profile, voiceName: 'mk-MK-MarijaNeural' })),
    ).toBeUndefined();
    expect(cache.get(phraseRequest('Здраво.', 'mk', { ...profile, rate: '+10%' }))).toBeUndefined();
  });

  it('synthesizes once when the same phrase is warmed concurrently', async () => {
    const provider = new FakeProvider();
    const cache = new SpeechCache(provider);
    const request = phraseRequest('Само момент.', 'mk', profile);

    await Promise.all([cache.warm(request), cache.warm(request), cache.warm(request)]);

    expect(provider.tts.spoken).toHaveLength(1);
  });

  it('warms every fixed phrase a business can say', async () => {
    const provider = new FakeProvider();
    const cache = new SpeechCache(provider);

    const result = await warmBusiness(cache, context.business);

    expect(result.failed).toBe(0);
    expect(result.warmed).toBe(warmRequests(context.business).length);
    // The greeting must be warmed with the same pause flag the session asks
    // for, or the key differs and the cache silently never hits.
    expect(
      cache.get(
        phraseRequest(renderGreeting(context.business), 'mk', profile, {
          breakAfterFirstSentence: true,
        }),
      ),
    ).toBeDefined();
    expect(cache.get(phraseRequest(FILLERS.mk[0]!, 'mk', profile))).toBeDefined();
  });
});

describe('greeting latency', () => {
  it('greets from cache without synthesizing or waiting for the recognizer', async () => {
    const provider = new FakeProvider();
    const cache = new SpeechCache(provider);
    await warmBusiness(cache, context.business);
    provider.tts.spoken.length = 0;

    const h = makeSession(new ScriptedLanguageModel([]), { cache, provider });
    await h.session.start();

    // Nothing reached Azure: the caller heard bytes that already existed.
    expect(provider.tts.spoken).toHaveLength(0);
    expect(h.frames.length).toBeGreaterThan(0);
    await h.session.stop('test');
  });

  it('still greets correctly when the cache is cold', async () => {
    const h = makeSession(new ScriptedLanguageModel([]));
    await h.session.start();

    expect(h.provider.tts.spoken[0]!.text).toContain(context.business.name);
    // The pause between greeting and question is not lost on the slow path.
    expect(h.provider.tts.spoken[0]!.breakAfterFirstSentence).toBe(true);
    await h.session.stop('test');
  });

  it('serves the fixed apologies from cache too', async () => {
    const provider = new FakeProvider();
    const cache = new SpeechCache(provider);
    await warmBusiness(cache, context.business);

    const h = makeSession(new ScriptedLanguageModel([]), { cache, provider });
    await h.session.start();
    provider.tts.spoken.length = 0;

    h.provider.stt!.handlers.onError(new Error('azure exploded'));
    await settle();

    // The recovery path is what a struggling call depends on; it must not be
    // the slowest thing the agent does.
    expect(provider.tts.spoken).toHaveLength(0);
    expect(h.frames.length).toBeGreaterThan(0);
    await h.session.stop('test');
  });
});

describe('filler audio', () => {
  it('covers a slow turn and rotates so it never repeats back to back', async () => {
    const provider = new FakeProvider();
    const cache = new SpeechCache(provider);
    await warmBusiness(cache, context.business);

    const h = makeSession(new SlowModel(150, 'Готово.'), {
      cache,
      provider,
      fillerAfterMs: 20,
      // The harness reprompts after 40 ms by default, which would end the call
      // between the two turns this test needs.
      silenceMs: 5000,
    });
    await h.session.start();

    h.provider.stt!.say('Сакам термин.', 0.95, 'mk');
    await settle(400);
    h.provider.stt!.say('Сакам термин.', 0.95, 'mk');
    await settle(400);

    expect(h.fillers.length).toBeGreaterThanOrEqual(2);
    expect(h.fillers[0]).not.toBe(h.fillers[1]);
    for (const filler of h.fillers) {
      expect(FILLERS.mk as readonly string[]).toContain(filler);
    }
    await h.session.stop('test');
  });

  it('stays quiet when the turn is fast enough not to need one', async () => {
    const provider = new FakeProvider();
    const cache = new SpeechCache(provider);
    await warmBusiness(cache, context.business);

    const h = makeSession(new ScriptedLanguageModel([scriptedText('Готово.')]), {
      cache,
      provider,
      fillerAfterMs: 500,
      silenceMs: 5000,
    });
    await h.session.start();
    h.fillers.length = 0;

    h.provider.stt!.say('Сакам термин.', 0.95, 'mk');
    await settle(200);

    expect(h.fillers).toHaveLength(0);
    await h.session.stop('test');
  });

  it('says nothing extra when the cache is cold', async () => {
    // A filler that has to be synthesized first is not a filler.
    const h = makeSession(new SlowModel(150, 'Готово.'), {
      fillerAfterMs: 20,
      silenceMs: 5000,
    });
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    h.provider.stt!.say('Сакам термин.', 0.95, 'mk');
    await settle(400);

    expect(h.fillers).toHaveLength(0);
    const said = h.provider.tts.spoken.map((s) => s.text);
    expect(said.some((t) => (FILLERS.mk as readonly string[]).includes(t))).toBe(false);
    await h.session.stop('test');
  });
});

describe('silence clock', () => {
  it('does not reprompt over the agent while it is still speaking', async () => {
    // The clock used to start when the model finished, not when the audio
    // finished. A reply longer than the silence window then reprompted over
    // its own sentence, and the second reprompt hung up on the caller.
    const h = makeSession(new ScriptedLanguageModel([scriptedText('Готово.')]), {
      silenceMs: 30,
      frameIntervalMs: 5,
    });
    h.provider.tts.frames = 40; // ~200 ms of audio at 5 ms/frame
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    h.provider.stt!.say('Сакам термин.', 0.95, 'mk');
    await settle(120);

    // Mid-reply: the caller is listening, not silent.
    expect(h.provider.tts.spoken.map((s) => s.text)).not.toContain('Сè уште сте тука?');
    expect(h.hangUps).toBe(0);
    await h.session.stop('test');
  });

  it('still reprompts once the line is genuinely quiet', async () => {
    const h = makeSession(new ScriptedLanguageModel([]), { silenceMs: 30, frameIntervalMs: 1 });
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    await settle(120);
    expect(h.provider.tts.spoken.map((s) => s.text)).toContain('Сè уште сте тука?');
    await h.session.stop('test');
  });
});

describe('playback queue', () => {
  it('wakes every waiter, not just the last one to ask', async () => {
    // A single callback slot dropped all but the newest waiter, leaving the
    // others on a promise that never settled.
    const queue = new PlaybackQueue({ sendFrame: () => {}, clear: () => {} }, 1);
    queue.enqueue(Buffer.alloc(160 * 5, 0xff));

    const waiters = [queue.whenDrained(), queue.whenDrained(), queue.whenDrained()];
    await expect(Promise.all(waiters)).resolves.toHaveLength(3);
  });
});

describe('speech tuning', () => {
  it('hands the business own segmentation settings to the recognizer', async () => {
    // Tuned by ear on a real line and stored per business, so a change is a
    // database write the next call picks up — not a redeploy.
    const tuned = {
      ...context.business,
      voiceConfig: {
        ...DEFAULT_VOICE_CONFIG,
        recognition: { ...DEFAULT_RECOGNITION_CONFIG, segmentationSilenceMs: 1400 },
      },
    };

    const h = makeSession(new ScriptedLanguageModel([]), { business: tuned });
    await h.session.start();

    expect(h.provider.recognizerOptions?.recognition).toMatchObject({
      segmentationSilenceMs: 1400,
      segmentationStrategy: 'Time',
    });
    await h.session.stop('test');
  });

  it('falls back to the shared defaults for a business configured before this existed', () => {
    // Rows seeded with only {mk, sq, en} must still parse.
    expect(recognitionFor({ ...DEFAULT_VOICE_CONFIG })).toEqual(DEFAULT_RECOGNITION_CONFIG);
    expect(recognitionFor(null)).toEqual(DEFAULT_RECOGNITION_CONFIG);
    // Azure's own default is 500ms, which is what caused the interruptions.
    expect(DEFAULT_RECOGNITION_CONFIG.segmentationSilenceMs).toBeGreaterThan(500);
  });

  it('logs the silence that ended each utterance, next to the text', async () => {
    const h = makeSession(new ScriptedLanguageModel([scriptedText('Готово.')]), {
      silenceMs: 5000,
    });
    await h.session.start();

    h.provider.stt!.handlers.onFinal({
      text: 'Утре наутро',
      confidence: 0.94,
      endSilenceMs: 905,
      utteranceMs: 1600,
    });
    await settle(60);

    const said = h.logs.find((l) => l.message === 'caller said');
    expect(said?.payload).toMatchObject({
      text: 'Утре наутро',
      endSilenceMs: 905,
      configuredSilenceMs: 900,
    });
    await h.session.stop('test');
  });
});

// --- reprompt timing ---------------------------------------------------------

/** Streams several sentences with a gap, the way a real model does. */
class StreamingModel implements ILanguageModel {
  constructor(
    private readonly sentences: string[],
    private readonly gapMs: number,
  ) {}

  async complete(request: ModelRequest): Promise<Anthropic.Message> {
    for (const [index, sentence] of this.sentences.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, this.gapMs));
      request.onTextDelta?.(`${sentence} `);
    }
    const text = this.sentences.join(' ');
    return {
      id: 'msg_stream',
      type: 'message',
      role: 'assistant',
      model: 'test',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 } as Anthropic.Usage,
      content: [{ type: 'text', text, citations: null } as Anthropic.ContentBlock],
    } as Anthropic.Message;
  }
}

describe('reprompt timing', () => {
  it('does not start the clock in the gap between streamed sentences', async () => {
    /**
     * The playback queue empties between sentences while the next one is still
     * being synthesized, so `isPlaying` goes false mid-reply. Arming the clock
     * there starts counting the caller's "silence" while the agent is still
     * talking, and the reprompt lands moments after it stops — which is what
     * makes it feel like it is talking over you rather than waiting.
     */
    /**
     * The turn finishes while later sentences are still being synthesized.
     *
     * That is the real shape of it: `handleTurn` returns once the model has
     * finished generating, but each sentence still needs an Azure round trip
     * before it can be queued. The playback queue is empty in those gaps, so
     * anything that equates "nothing playing" with "the caller has gone quiet"
     * starts the clock while the agent is mid-reply — and the reprompt lands
     * on top of its own next sentence.
     */
    const h = makeSession(new StreamingModel(['Прво.', 'Второ.', 'Трето.'], 400), {
      silenceMs: 100,
      frameIntervalMs: 1,
    });
    h.provider.tts.frames = 5;
    h.provider.tts.delayMs = 300;
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    h.provider.stt!.say('Сакам термин.', 0.95, 'mk');
    // Past the last sentence being emitted, and into the window where its
    // synthesis is still in flight with the playback queue already empty.
    await settle(1100);

    /**
     * Assert on the decision, not on the audio. The reprompt's own synthesis
     * takes long enough that checking `tts.spoken` passes even when the agent
     * has already decided to talk over itself twice.
     */
    const reprompts = h.logs.filter((l) => l.message === 'reprompting after silence');
    expect(reprompts).toHaveLength(0);
    await h.session.stop('test');
  });
});

// --- recognition quality -----------------------------------------------------

describe('recognition vocabulary', () => {
  it('biases the recognizer towards this clinic own words', async () => {
    // A receptionist for one dental clinic hears a tiny vocabulary. Telling
    // Azure which few hundred words actually occur is the biggest accuracy
    // lever available over an 8 kHz line without changing provider.
    const h = makeSession(new ScriptedLanguageModel([]));
    await h.session.start();

    const phrases = h.provider.recognizerOptions?.phrases ?? [];
    expect(phrases).toContain('Дентал Охрид');
    expect(phrases).toContain('Стоматолошки преглед');
    expect(phrases.some((p) => p.includes('Смилевска'))).toBe(true);
    expect(phrases).toContain('вторник');
    expect(phrases).toContain('сакам да закажам');
    // Azure documents 500 as the ceiling; past that Custom Speech is the tool.
    expect(phrases.length).toBeLessThanOrEqual(500);

    await h.session.stop('test');
  });

  it('splits names so a caller who says only the surname is still heard', () => {
    const phrases = recognitionPhrases({ ...context, language: 'mk' as Language });
    expect(phrases).toContain('Ана');
    expect(phrases).toContain('Смилевска');
    // The honorific on its own is noise, not vocabulary.
    expect(phrases).not.toContain('д-р');
  });
});

describe('a line we cannot hear', () => {
  const deaf = {
    ...DEFAULT_RECOGNITION_CONFIG,
    maxLowConfidenceTurns: 2,
    lowConfidenceHoldMs: 20,
  };

  it('stops retrying the same question and offers a way out', async () => {
    /**
     * This is what produced the repeats. Every low-confidence result spoke the
     * same apology, forever — the streak counter set an outcome field and
     * changed no behaviour. It is not the reprompt timer, which is why tuning
     * the reprompt delay had no effect on it.
     */
    const handed: string[] = [];
    const h = makeSession(new ScriptedLanguageModel([]), {
      recognition: deaf,
      silenceMs: 5000,
      onTransfer: async (to) => void handed.push(to),
    });
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    // Five low-confidence results: the first two are met with silence, the next
    // two apologise, the fifth offers a way out. Silent holds spend no chance.
    for (const c of [0.2, 0.15, 0.18, 0.12, 0.14]) {
      h.provider.stt!.say('шшш', c, 'mk');
      await settle(80);
    }
    await settle(120);

    const said = h.provider.tts.spoken.map((s) => s.text);
    // Nothing at all was spoken for the first one.
    expect(
      h.logs.filter((l) => l.message === 'apologising for a low-confidence turn'),
    ).toHaveLength(2);
    // The apology escalates rather than repeating verbatim.
    expect(said[0]).toBe(DID_NOT_CATCH.mk[0]);
    expect(said).toContain(CANNOT_HEAR.mk);
    // A line we cannot transcribe is still a caller: offer the way out, keep
    // the call. This path used to reach handOver() and hang up at ~10s.
    expect(h.hangUps).toBe(0);
    expect(handed).toEqual([]);
    expect(
      h.logs.some(
        (l) => l.message === 'cannot hear this line — offering a way out, but staying on the call',
      ),
    ).toBe(true);
  });

  it('recovers silently when the caller comes back clearly', async () => {
    const h = makeSession(new ScriptedLanguageModel([scriptedText('Секако.')]), {
      recognition: deaf,
      silenceMs: 5000,
    });
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    h.provider.stt!.say('шшш', 0.2, 'mk');
    await settle(60);
    h.provider.stt!.say('Сакам термин утре.', 0.95, 'mk');
    await settle(120);

    // Held in silence, then a normal turn — nothing was spoken at the caller.
    expect(h.provider.tts.spoken.map((s) => s.text)).not.toContain(CANNOT_HEAR.mk);
    expect(h.provider.tts.spoken.map((s) => s.text)).not.toContain(DID_NOT_CATCH.mk[0]);
    expect(h.logs.filter((l) => l.message === 'turn started')).toHaveLength(1);
    await h.session.stop('test');
  });

  it('never hangs up on a caller who is audibly present', async () => {
    /**
     * The stage blocker. Every escape path used to end in onHangUp(), so four
     * low-confidence results in a row dropped the caller at around ten seconds
     * while they were still talking. A caller we cannot transcribe is still a
     * caller, and someone dropped mid-call has no idea what happened.
     */
    const handed: string[] = [];
    const h = makeSession(new ScriptedLanguageModel([]), {
      recognition: deaf,
      silenceMs: 60,
      onTransfer: async (to) => void handed.push(to),
    });
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    // Ten unintelligible utterances — far past every cap there is — but the
    // caller is audibly there the whole time.
    for (let i = 0; i < 10; i++) {
      h.provider.stt!.say('шшш', 0.12, 'mk');
      await settle(70);
    }

    expect(h.hangUps).toBe(0);
    expect(handed).toEqual([]);
    await h.session.stop('test');
  });

  it('hangs up only once the line has gone genuinely silent', async () => {
    // The one remaining agent-initiated hangup: no caller sound at all. Without
    // it an abandoned call stays open and billable forever.
    const h = makeSession(new ScriptedLanguageModel([]), {
      recognition: { ...deaf, presenceWindowMs: 1000, abandonAfterMs: 15_000 },
      silenceMs: 60,
    });
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    await settle(400);
    expect(h.hangUps).toBe(0); // reprompted, but the window has not passed

    // Nothing from the caller for longer than abandonAfterMs.
    h.session['lastCallerSoundAt'] = Date.now() - 20_000;
    await settle(400);

    expect(h.hangUps).toBe(1);
    const ended = h.logs.find((l) => l.message === 'call ended');
    expect(ended?.payload).toMatchObject({ endedBy: 'agent' });
    expect(
      h.logs.some((l) => l.message === 'hanging up — our decision, the line has been silent'),
    ).toBe(true);
  });

  it('says nothing at all on the first low-confidence result', async () => {
    /**
     * The race this exists to break. The apology is a cached phrase, so it
     * plays ~35 ms after the result — while a caller who merely paused
     * mid-thought is still talking. Being talked over derails them into a
     * disfluent restart, which finalizes as another bad fragment, which
     * apologises again. Timing-driven, so no delay tuning ever touched it.
     */
    const h = makeSession(new ScriptedLanguageModel([]), {
      recognition: deaf,
      silenceMs: 5000,
    });
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    h.provider.stt!.say('сакам да закажам за', 0.2, 'mk');
    await settle(120);

    expect(h.provider.tts.spoken).toHaveLength(0);
    expect(
      h.logs.some(
        (l) =>
          l.message ===
          'low confidence held in silence — may be a fragment of a sentence still being spoken',
      ),
    ).toBe(true);
    await h.session.stop('test');
  });

  it('abandons the apology when the caller resumes during the hold', async () => {
    // The delay only helps because it is a window to be interrupted in. A
    // delay that still speaks afterwards would just move the collision later.
    const h = makeSession(new ScriptedLanguageModel([]), {
      recognition: {
        ...DEFAULT_RECOGNITION_CONFIG,
        silentLowConfidenceTurns: 0,
        lowConfidenceHoldMs: 300,
      },
      silenceMs: 5000,
    });
    await h.session.start();
    h.provider.tts.spoken.length = 0;

    h.provider.stt!.say('сакам да закажам за', 0.2, 'mk');
    await settle(60);
    // Still mid-sentence: the fragment was never the whole thought.
    h.provider.stt!.partial('вторник наутро');
    await settle(400);

    expect(h.provider.tts.spoken).toHaveLength(0);
    expect(
      h.logs.some((l) => l.message === 'caller resumed during the hold — not apologising over them'),
    ).toBe(true);
    await h.session.stop('test');
  });

  it('logs the confidence on every recognition, accepted or not', async () => {
    const h = makeSession(new ScriptedLanguageModel([scriptedText('Добро.')]), {
      recognition: deaf,
      silenceMs: 5000,
    });
    await h.session.start();

    h.provider.stt!.say('нејасно', 0.25, 'mk');
    await settle(60);
    h.provider.stt!.say('Сакам термин.', 0.91, 'mk');
    await settle(120);

    const low = h.logs.find((l) => l.message === 'low confidence transcription');
    const good = h.logs.find((l) => l.message === 'caller said');
    // Low-confidence-but-right and confidently-wrong are different problems,
    // and only the score tells them apart.
    expect(low?.payload).toMatchObject({ confidence: 0.25, minConfidence: 0.4 });
    expect(good?.payload).toMatchObject({ confidence: 0.91 });
    await h.session.stop('test');
  });
});

describe('a line locked to one language', () => {
  it('hands the recognizer exactly one language, so detection is skipped', async () => {
    /**
     * Handed one language, Azure is built without an auto-detect config. That
     * removes the detection it otherwise runs on the opening audio — and with
     * it the failure measured on 26 August, where a caller who switched
     * language mid-call became untranscribable for the rest of the connection.
     *
     * The clinic still advertises three languages; this is only about what the
     * phone line is willing to hear.
     */
    const locked = {
      ...context.business,
      languages: ['mk', 'sq', 'en'] as ('mk' | 'sq' | 'en')[],
      voiceConfig: {
        ...DEFAULT_VOICE_CONFIG,
        recognition: { ...DEFAULT_RECOGNITION_CONFIG, lockLanguage: 'mk' as const },
      },
    };

    const h = makeSession(new ScriptedLanguageModel([]), { business: locked });
    await h.session.start();

    expect(h.provider.recognizerOptions?.languages).toEqual(['mk']);
    await h.session.stop('test');
  });

  it('still offers every configured language when nothing is locked', async () => {
    const h = makeSession(new ScriptedLanguageModel([]), {
      business: {
        ...context.business,
        languages: ['mk', 'sq', 'en'] as ('mk' | 'sq' | 'en')[],
      },
    });
    await h.session.start();

    expect(h.provider.recognizerOptions?.languages).toEqual(['mk', 'sq', 'en']);
    await h.session.stop('test');
  });
});

describe('when the confirmation text goes out', () => {
  /** The next Tuesday, so the clinic is definitely open and Ana is working. */
  function nextTuesday(): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + ((9 - d.getUTCDay()) % 7 || 7));
    return d;
  }

  it('texts after the call ends, not while the agent is still speaking', async () => {
    /**
     * Booking and confirming are separate events on purpose. Sending at
     * `book_appointment` buzzes the phone while the agent is mid-sentence —
     * the caller looks down during the part of the call you want watched.
     *
     * What this pins is the ORDER: nothing is sent during the turn, and the
     * ids survive to be flushed once the call is over.
     */
    const day = nextTuesday();
    const startsAt = fromZonedWallClock(
      context.business.timezone,
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      9,
      0,
    );

    const model = new ScriptedLanguageModel([
      scriptedToolUse([
        {
          name: 'check_availability',
          input: {
            service_id: DEMO_IDS.services.checkup,
            date_from: isoDate(startsAt),
            date_to: isoDate(startsAt),
            staff_id: null,
          },
        },
      ]),
      scriptedText('Слободно е во девет. Како се викате?'),
      scriptedToolUse([
        {
          name: 'confirm_details',
          input: { customer_name: 'Марко Петровски', customer_contact: '+38970111222' },
        },
      ]),
      scriptedText('Ве запишав како Марко Петровски. Точно?'),
      scriptedToolUse([
        {
          name: 'book_appointment',
          input: {
            service_id: DEMO_IDS.services.checkup,
            staff_id: DEMO_IDS.staff.ana,
            starts_at: startsAt.toISOString(),
            customer_name: 'Марко Петровски',
            customer_contact: '+38970111222',
          },
        },
      ]),
      scriptedText('Готово, закажано е.'),
    ]);

    const booked: string[] = [];
    const h = makeSession(model, {
      onBooked: (id) => booked.push(id),
      confirmationDelayMs: 30,
    });

    await h.session.start();
    h.provider.stt!.say('Сакам термин во вторник наутро.', 0.92, 'mk');
    await settle(150);
    h.provider.stt!.say('Марко Петровски, нула седумдесет сто единаесет двесте дваесет и два.', 0.92);
    await settle(150);
    h.provider.stt!.say('Да, точно е.', 0.92);
    await settle(200);

    const rows = await db.select().from(appointments);
    expect(rows).toHaveLength(1);
    // The booking happened, and the phone has NOT buzzed yet.
    expect(booked).toEqual([]);

    await h.session.stop('test');
    await settle(120);

    expect(booked).toEqual([rows[0]!.id]);
  });
});

describe('closing cues', () => {
  /**
   * The allowlist is the safety property, so the negative cases are the ones
   * worth writing down: a sentence that merely CONTAINS "не" is a request,
   * not a goodbye, and treating it as one would cut a caller off mid-booking.
   */
  it('recognises a goodbye and nothing else', () => {
    for (const said of [
      'Не, благодарам.',
      'Не ти благодарам',
      'Не, тоа е сè.',
      'Тоа е сè, благодарам.',
      'Благодарам, пријатно!',
      'Ништо повеќе, фала.',
      'Довидување.',
    ]) {
      expect(isClosingCue(said, 'mk'), said).toBe(true);
    }

    for (const said of [
      'Не, сакам друго време.',
      'Не е тоа, во единаесет сакав.',
      'Да.',
      'Добро.',
      'Може ли и во сабота, благодарам?',
      '',
    ]) {
      expect(isClosingCue(said, 'mk'), said).toBe(false);
    }

    expect(isClosingCue('No, thanks.', 'en')).toBe(true);
    expect(isClosingCue("No, that's all, thank you", 'en')).toBe(true);
    expect(isClosingCue('No, book it for Friday', 'en')).toBe(false);
    expect(isClosingCue('Jo, faleminderit.', 'sq')).toBe(true);
    expect(isClosingCue('Jo, dua një orë tjetër', 'sq')).toBe(false);
  });
});

describe('closing a booked call', () => {
  /** The next Tuesday, so the clinic is definitely open and Ana is working. */
  function nextTuesday(): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + ((9 - d.getUTCDay()) % 7 || 7));
    return d;
  }

  /** Availability, confirmation, booking — the three turns a booking needs. */
  function bookingScript(startsAt: Date, ...tail: Anthropic.Message[]): ScriptedLanguageModel {
    return new ScriptedLanguageModel([
      scriptedToolUse([
        {
          name: 'check_availability',
          input: {
            service_id: DEMO_IDS.services.checkup,
            date_from: isoDate(startsAt),
            date_to: isoDate(startsAt),
            staff_id: null,
          },
        },
      ]),
      scriptedText('Слободно е во девет. Како се викате?'),
      scriptedToolUse([
        {
          name: 'confirm_details',
          input: { customer_name: 'Марко Петровски', customer_contact: '+38970111222' },
        },
      ]),
      scriptedText('Ве запишав како Марко Петровски. Точно?'),
      scriptedToolUse([
        {
          name: 'book_appointment',
          input: {
            service_id: DEMO_IDS.services.checkup,
            staff_id: DEMO_IDS.staff.ana,
            starts_at: startsAt.toISOString(),
            customer_name: 'Марко Петровски',
            customer_contact: '+38970111222',
          },
        },
      ]),
      scriptedText('Готово, закажано е. Има ли нешто друго?'),
      ...tail,
    ]);
  }

  async function bookThrough(h: Harness): Promise<void> {
    await h.session.start();
    h.provider.stt!.say('Сакам термин во вторник наутро.', 0.92, 'mk');
    await settle(150);
    h.provider.stt!.say('Марко Петровски, нула седум нула, еден еден еден.', 0.92);
    await settle(150);
    h.provider.stt!.say('Да, точно е.', 0.92);
    await settle(200);
  }

  it('says goodbye immediately instead of asking the model again', async () => {
    const startsAt = tuesdayAtNine(nextTuesday());
    /**
     * A reply the model would give if it were asked. It must never be heard:
     * the whole point is that a booked caller saying "не, благодарам" costs a
     * cached phrase rather than a round trip to a model with nothing to do.
     */
    const model = bookingScript(startsAt, scriptedText('Ова не смее да се чуе.'));

    const h = makeSession(model, {
      silenceMs: 2000,
      recognition: bargeIn({ farewellGraceMs: 20 }),
    });
    await bookThrough(h);
    expect(await db.select().from(appointments)).toHaveLength(1);

    h.provider.tts.spoken.length = 0;
    h.provider.stt!.say('Не, благодарам.', 0.94, 'mk');
    await waitFor(() => h.hangUps === 1);

    const said = h.provider.tts.spoken.map((t) => t.text);
    expect(said).toContain(FAREWELL.mk);
    expect(said).not.toContain('Ова не смее да се чуе.');
    // "Само момент." in front of a goodbye is the line this exists to kill.
    expect(h.fillers).toHaveLength(0);
    await h.session.stop('test');
  });

  it('still asks the model when the caller has more to say', async () => {
    const startsAt = tuesdayAtNine(nextTuesday());
    const model = bookingScript(startsAt, scriptedText('Секако, слушам.'));

    const h = makeSession(model, { silenceMs: 2000 });
    await bookThrough(h);

    h.provider.tts.spoken.length = 0;
    // Contains "не" and is still a request. The shortcut must not take it.
    h.provider.stt!.say('Не, сакам и чистење на забен камен.', 0.94, 'mk');
    await waitFor(() => h.provider.tts.spoken.some((t) => t.text === 'Секако, слушам.'));

    expect(h.hangUps).toBe(0);
    await h.session.stop('test');
  });
});

function tuesdayAtNine(day: Date): Date {
  return fromZonedWallClock(
    context.business.timezone,
    day.getUTCFullYear(),
    day.getUTCMonth() + 1,
    day.getUTCDate(),
    9,
    0,
  );
}
