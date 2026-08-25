import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_IDS, createTestDb, type TestDatabase } from '@frontly/core';
import { serverEnvSchema } from '@frontly/shared';
import { buildApp } from '../app.js';
import { decodeClientState, TelnyxProvider } from '../voice/telnyx.js';
import type { ISpeechProvider, ISpeechToText, ITextToSpeech } from '../voice/types.js';

/**
 * The webhook route over real HTTP.
 *
 * The unit tests verify the adapter in isolation; this one exists for the seam
 * between Fastify and the adapter, where the failure is invisible: Fastify
 * parses JSON by default, and a signature checked against a re-serialized body
 * fails on nothing more than key order. That bug would only appear against a
 * genuinely-signed request, which is what this file sends.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyB64 = publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(-32)
  .toString('base64');

let app: FastifyInstance;
let testDb: TestDatabase;
let commands: { url: string; body: Record<string, unknown> }[] = [];
/** Lets one test make the carrier reject the first answer attempt. */
let failNextAnswer: (() => boolean) | undefined;

/** Speech is irrelevant here; the socket is never opened. */
const inertSpeech: ISpeechProvider = {
  createSynthesizer: (): ITextToSpeech => ({
    synthesize: async () => Buffer.alloc(160, 0xff),
    close: () => {},
  }),
  createRecognizer: (): ISpeechToText => ({
    ready: Promise.resolve(),
    write: () => {},
    stop: async () => {},
  }),
};

beforeAll(async () => {
  testDb = await createTestDb();

  const telephony = new TelnyxProvider({
    apiKey: 'KEY_test',
    publicKey: publicKeyB64,
    fetchImpl: (async (url: string, init: RequestInit) => {
      commands.push({
        url: String(url),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      if (String(url).includes('/actions/answer') && failNextAnswer?.()) {
        return new Response('{"errors":[{"detail":"upstream exploded"}]}', { status: 500 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
  });

  const env = serverEnvSchema.parse({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: testDb.url,
    PUBLIC_BASE_URL: 'https://frontly.onrender.com',
  });

  ({ app } = await buildApp(env, {
    telephonyProvider: telephony,
    speechProvider: inertSpeech,
    warmSpeechCache: false,
  }));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  testDb?.cleanup();
});

function post(payload: unknown, options: { sign?: boolean; timestamp?: number } = {}) {
  const raw = JSON.stringify(payload);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (options.sign !== false) {
    headers['telnyx-timestamp'] = String(timestamp);
    headers['telnyx-signature-ed25519'] = nodeSign(
      null,
      Buffer.concat([Buffer.from(`${timestamp}|`), Buffer.from(raw)]),
      privateKey,
    ).toString('base64');
  }

  return app.inject({ method: 'POST', url: '/telnyx/voice', headers, payload: raw });
}

let callSeq = 0;

function initiated(to: string, callRef = `v3:live-call-${++callSeq}`) {
  return {
    data: {
      record_type: 'event',
      event_type: 'call.initiated',
      id: 'evt-1',
      occurred_at: new Date().toISOString(),
      payload: {
        call_control_id: callRef,
        call_leg_id: 'leg-1',
        call_session_id: 'sess-1',
        connection_id: '1684641123236054244',
        direction: 'incoming',
        state: 'parked',
        from: '+38970111222',
        to,
      },
    },
  };
}

/** The route answers before it acts, so give the fire-and-forget work a tick. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('POST /telnyx/voice', () => {
  beforeAll(() => {
    commands = [];
  });

  it('answers a signed inbound call and opens the media stream', async () => {
    commands = [];
    const response = await post(initiated('+16193497599'));
    expect(response.statusCode).toBe(200);
    await settle();

    expect(commands).toHaveLength(1);
    const [command] = commands;
    expect(command!.url).toContain('/actions/answer');
    expect(command!.body.stream_url).toBe('wss://frontly.onrender.com/telnyx/stream');
    // The socket has no other way to learn which clinic was dialled.
    expect(decodeClientState(command!.body.client_state as string)).toMatchObject({
      businessId: DEMO_IDS.business,
      from: '+38970111222',
      to: '+16193497599',
    });
  });

  it('rejects an unsigned request without placing any command', async () => {
    commands = [];
    const response = await post(initiated('+16193497599'), { sign: false });
    expect(response.statusCode).toBe(403);
    await settle();
    expect(commands).toHaveLength(0);
  });

  it('rejects a replayed request', async () => {
    commands = [];
    const response = await post(initiated('+16193497599'), {
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(response.statusCode).toBe(403);
    await settle();
    expect(commands).toHaveLength(0);
  });

  it('acknowledges events it does not act on, so they are not retried', async () => {
    commands = [];
    const response = await post({
      data: {
        event_type: 'call.hangup',
        payload: { call_control_id: 'v3:live-call', hangup_cause: 'normal_clearing' },
      },
    });
    expect(response.statusCode).toBe(200);
    await settle();
    expect(commands).toHaveLength(0);
  });

  it('hangs up rather than answering a call it cannot route', async () => {
    // Two businesses means the single-business fallback cannot guess, which is
    // the shape this failure takes once a second clinic exists.
    const { businesses } = await import('@frontly/core');
    await testDb.db.insert(businesses).values({
      id: 'biz_second',
      name: 'Втора ординација',
      slug: 'vtora',
      inboundNumber: '+38921000000',
      workingHours: {
        mon: [{ start: '09:00', end: '17:00' }],
        tue: [],
        wed: [],
        thu: [],
        fri: [],
        sat: [],
        sun: [],
      },
      greetingTemplate: 'Добар ден.',
    });

    commands = [];
    const response = await post(initiated('+15550000000'));
    expect(response.statusCode).toBe(200);
    await settle();

    expect(commands).toHaveLength(1);
    // Answering would put the caller in front of a carrier voice with no
    // Macedonian, which is worse than a clean rejection.
    expect(commands[0]!.url).toContain('/actions/hangup');

    await testDb.db.delete(businesses).where(
      (await import('drizzle-orm')).eq(businesses.id, 'biz_second'),
    );
  });
});

describe('voice channel boot assertion', () => {
  /**
   * A deploy once came up healthy with no voice route at all, and the only way
   * to discover it was to curl the webhook by hand. These are the checks that
   * would have turned that into a failed deploy instead of a silent one.
   */
  async function build(overrides: Record<string, unknown>, options = {}) {
    const scratch = await createTestDb({ seed: false });
    const env = serverEnvSchema.parse({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: scratch.url,
      PUBLIC_BASE_URL: 'https://frontly.onrender.com',
      ...overrides,
    });
    return { scratch, build: () => buildApp(env, { warmSpeechCache: false, ...options }) };
  }

  it('refuses to boot when the carrier is missing and voice is required', async () => {
    const { scratch, build: run } = await build(
      {},
      { requireVoiceChannel: true, speechProvider: inertSpeech },
    );
    await expect(run()).rejects.toThrow(/TELNYX_API_KEY/);
    scratch.cleanup();
  });

  it('refuses to boot when speech is missing and voice is required', async () => {
    const { scratch, build: run } = await build(
      {},
      { requireVoiceChannel: true, telephonyProvider: new TelnyxProvider({ apiKey: 'k' }) },
    );
    await expect(run()).rejects.toThrow(/AZURE_SPEECH_KEY/);
    scratch.cleanup();
  });

  it('still starts without voice outside production, so the dashboard is workable', async () => {
    const { scratch, build: run } = await build({}, { requireVoiceChannel: false });
    const { app: built } = await run();
    await built.ready();
    expect((await built.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await built.inject({ method: 'GET', url: '/health' })).json().checks.voice.status).toBe(
      'disabled',
    );
    await built.close();
    scratch.cleanup();
  });

  it('reports the mounted webhook in /health, so green means the phone works', async () => {
    const { scratch, build: run } = await build(
      {},
      {
        requireVoiceChannel: true,
        speechProvider: inertSpeech,
        telephonyProvider: new TelnyxProvider({ apiKey: 'k' }),
      },
    );
    const { app: built } = await run();
    await built.ready();

    const health = (await built.inject({ method: 'GET', url: '/health' })).json();
    expect(health.checks.voice).toMatchObject({
      status: 'ok',
      carrier: 'telnyx',
      webhook: '/telnyx/voice',
    });
    // And the route genuinely exists, not merely a claim in a JSON body.
    expect(built.hasRoute({ method: 'POST', url: '/telnyx/voice' })).toBe(true);

    await built.close();
    scratch.cleanup();
  });

  it('fails on ready when the routes never reached the served tree', async () => {
    // The failure `register` resolving cannot catch: a plugin that runs but
    // whose routes end up somewhere other than the instance about to serve.
    const silentProvider = new TelnyxProvider({ apiKey: 'k' });
    Object.defineProperty(silentProvider, 'routePrefix', { get: () => '/telnyx' });

    const scratch = await createTestDb({ seed: false });
    const env = serverEnvSchema.parse({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: scratch.url,
      PUBLIC_BASE_URL: 'https://frontly.onrender.com',
    });

    const { app: built } = await buildApp(env, {
      warmSpeechCache: false,
      requireVoiceChannel: true,
      speechProvider: inertSpeech,
      telephonyProvider: silentProvider,
    });

    // Move the goalposts after registration: the assertion asks the live route
    // tree, so a prefix that no longer matches is exactly a missing route.
    Object.defineProperty(silentProvider, 'routePrefix', { get: () => '/moved' });

    await expect(built.ready()).rejects.toThrow(/not in the served route tree/);
    await built.close().catch(() => {});
    scratch.cleanup();
  });
});

describe('webhook retries', () => {
  it('answers once when the same call is delivered twice', async () => {
    // Routine on a cold instance: the first delivery times out while Render is
    // still starting, so Telnyx redelivers. This used to answer and log twice.
    commands = [];
    const event = initiated('+16193497599');
    await Promise.all([post(event), post(event)]);
    await settle();

    const answers = commands.filter((c) => c.url.includes('/actions/answer'));
    expect(answers).toHaveLength(1);
  });

  it('lets a retry through when the first attempt failed outright', async () => {
    // Deduping must not turn a transient failure into a call that is never
    // answered at all.
    commands = [];
    let attempt = 0;
    failNextAnswer = () => {
      attempt++;
      return attempt === 1;
    };

    const event = initiated('+16193497599');
    await post(event);
    await settle();
    await post(event);
    await settle();

    failNextAnswer = undefined;
    expect(commands.filter((c) => c.url.includes('/actions/answer'))).toHaveLength(2);
  });
});
