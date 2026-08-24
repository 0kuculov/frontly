import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
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
import { decodeClientState, encodeClientState, TelnyxProvider, telnyxMediaProtocol } from './telnyx.js';
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
  callRef: string;
  frames: string[];
  clears: number;
  hangUps: number;
}

function makeSession(
  model: ScriptedLanguageModel,
  overrides: Partial<CallSessionOptions> = {},
): Harness {
  const provider = new FakeProvider();
  const callRef = `v3:test_${Math.random().toString(36).slice(2)}`;
  const harness: Harness = {
    provider,
    callRef,
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
    callRef,
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

    // clear() is the carrier barge-in primitive. Without it the caller keeps
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


// --- transfer ----------------------------------------------------------------

describe('transfer to a human', () => {
  it('waits for the explanation to finish, then hands the call over', async () => {
    const handed: string[] = [];
    const h = makeSession(
      new ScriptedLanguageModel([
        scriptedToolUse([{ name: 'transfer_to_human', input: { reason: 'medical question' } }]),
        scriptedText('Ве поврзувам со колега.'),
      ]),
      { onTransfer: async (to) => void handed.push(to) },
    );

    await h.session.start();
    h.provider.stt!.say('Дали смее да се вади заб во бременост?', 0.93, 'mk');
    await settle(120);

    expect(handed).toEqual([context.business.ownerMobile]);
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
    expect(h.hangUps).toBe(1);
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
    expect(h.hangUps).toBe(1);
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
