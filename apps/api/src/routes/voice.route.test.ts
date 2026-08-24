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
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
  });

  const env = serverEnvSchema.parse({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: testDb.url,
    PUBLIC_BASE_URL: 'https://frontly.onrender.com',
  });

  ({ app } = await buildApp(env, { telephonyProvider: telephony, speechProvider: inertSpeech }));
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

function initiated(to: string) {
  return {
    data: {
      record_type: 'event',
      event_type: 'call.initiated',
      id: 'evt-1',
      occurred_at: new Date().toISOString(),
      payload: {
        call_control_id: 'v3:live-call',
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
      workingHours: { mon: [{ start: '09:00', end: '17:00' }] },
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
