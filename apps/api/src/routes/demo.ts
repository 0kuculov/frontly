import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  appointments,
  conversations,
  DEMO_IDS,
  seedDemoBusiness,
  type Database,
} from '@frontly/core';
import type { OutgoingHttpHeaders } from 'node:http';
import type { ServerEnv } from '@frontly/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { callEvents } from '../demo/events.js';

/**
 * The stage demo: a live call on a projector, the numbers behind it, and a
 * reset button.
 *
 * Read-mostly and deliberately dumb. Everything here is derived from the
 * conversations and appointments tables or from the in-process event bus, so
 * there is no demo-specific state to get out of sync with a real call.
 */

/**
 * What one call costs us, in USD.
 *
 * A judge will ask, and "I don't know" is a bad answer. Rounded from the
 * measured shape of a booking call: ~5 turns, Telnyx inbound at roughly
 * $0.0035/min, Azure STT ~$0.017/min and TTS per character, and a Sonnet turn
 * with the system prompt cached. Deliberately conservative — better to quote a
 * number we beat than one we miss.
 */
const COST_PER_CALL_USD = 0.09;

interface DemoRouteOptions {
  db: Database;
  env: ServerEnv;
}

/** Just enough of the environment to decide whether a reset may run. */
type ResetEnv = Pick<ServerEnv, 'NODE_ENV' | 'DATABASE_URL'> & {
  DEMO_RESET_TOKEN?: string | undefined;
};

interface ResetRefusal {
  code: number;
  error: string;
  message: string;
}

/**
 * Whether this process is allowed to empty the demo clinic, and why not.
 *
 * Two different accidents, which is why there are two rules rather than one
 * flag:
 *
 * 1. **A dev server pointed at production.** `.env` on the owner's laptop
 *    holds the live Turso URL — it has to, it is how the seeded clinic gets
 *    maintained — so `pnpm dev` plus the reset button on localhost:3000
 *    deletes the real call history and every metric on the stage screen. The
 *    screen gives no hint which database it is talking to. So a process that
 *    is not production may only reset a `file:` database: its own.
 *
 * 2. **An open wipe endpoint on the public internet.** This route shipped
 *    unauthenticated at https://frontly.onrender.com/demo/reset, where anyone
 *    who guessed the path could blank the numbers mid-pitch. Production
 *    demands `DEMO_RESET_TOKEN` — declared in the env schema and in
 *    render.yaml since Phase 7, and until now read by nobody.
 *
 * Pure and exported so the rules are testable without standing up a server
 * against a database nobody wants a test to touch.
 */
export function resetRefusal(env: ResetEnv, presented: string | undefined): ResetRefusal | undefined {
  const isFile = /^file:/i.test(env.DATABASE_URL);

  if (env.NODE_ENV !== 'production') {
    if (isFile) return undefined;
    return {
      code: 403,
      error: 'reset_refused',
      message:
        `Refusing to reset: this is a ${env.NODE_ENV} server pointed at ${redactDbUrl(env.DATABASE_URL)}, ` +
        'which is the production database. Point DATABASE_URL at file:./frontly.db to reset locally, ' +
        'or run the reset against the deployed API with DEMO_RESET_TOKEN.',
    };
  }

  if (!env.DEMO_RESET_TOKEN) {
    return {
      code: 503,
      error: 'reset_unavailable',
      message:
        'Refusing to reset: DEMO_RESET_TOKEN is not set on this deploy, so the endpoint cannot ' +
        'tell the owner from a stranger. Render generates the value; check the service env.',
    };
  }

  if (!presented || !constantTimeEquals(presented, env.DEMO_RESET_TOKEN)) {
    return {
      code: 401,
      error: 'unauthorized',
      message: 'Reset needs the demo reset token: Authorization: Bearer <DEMO_RESET_TOKEN>.',
    };
  }

  return undefined;
}

/** Never put the auth token in an error a browser will show on a projector. */
function redactDbUrl(url: string): string {
  const scheme = url.split('://')[0] ?? url;
  const host = url.split('://')[1]?.split(/[/?]/)[0] ?? '';
  return `${scheme}://${host}`;
}

/**
 * Compares without leaking the answer in how long it took.
 *
 * `timingSafeEqual` throws outright on a length mismatch, so the lengths are
 * compared first — and a mismatch still does one comparison of equal width, so
 * a wrong-length token is not measurably faster to reject than a wrong byte.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still do the work, so a wrong length is not faster than a wrong byte.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * The CORS headers @fastify/cors put on the Fastify reply, carried across to
 * the raw socket by hand.
 *
 * The plugin stages them in an `onRequest` hook via `reply.header()`, and they
 * only reach the wire when `reply.send()` serialises them. The SSE handler
 * never calls send — it writes to the raw socket, because the response never
 * ends — so they were silently dropped. The effect was invisible locally and
 * fatal on stage: /demo/metrics answered with CORS headers and populated the
 * numbers, while EventSource on any other origin (the Vercel screen, or
 * localhost pointed at Render) was blocked by the browser and the transcript
 * stayed blank forever.
 *
 * Copied by name rather than spread wholesale: Fastify types `getHeaders()`
 * as the union of every known header, request ones included, and shovelling
 * that onto a response is both a type error and a way to leak something we
 * never meant to send.
 */
function corsHeaders(staged: Record<string, unknown>): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(staged)) {
    if (value === undefined) continue;
    if (!name.startsWith('access-control-') && name !== 'vary') continue;
    if (typeof value === 'string' || typeof value === 'number' || Array.isArray(value)) {
      out[name] = value as string | number | string[];
    }
  }
  return out;
}

/** `Authorization: Bearer <token>`, or the header the widget finds easier. */
function presentedToken(headers: Record<string, unknown>): string | undefined {
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^bearer /i.test(auth)) return auth.slice(7).trim();
  const direct = headers['x-demo-reset-token'];
  return typeof direct === 'string' ? direct : undefined;
}

export async function registerDemoRoutes(
  app: FastifyInstance,
  options: DemoRouteOptions,
): Promise<void> {
  const { db, env } = options;

  /**
   * Live call events, as Server-Sent Events.
   *
   * SSE rather than a WebSocket on purpose: EventSource reconnects on its own,
   * with backoff and Last-Event-ID, so surviving a venue network is the
   * browser's job rather than reconnect logic of ours to get wrong. A dropped
   * projector comes back and replays what it missed.
   */
  app.get('/demo/stream', (request, reply) => {
    reply.raw.writeHead(200, {
      ...corsHeaders(reply.getHeaders()),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Render sits behind a proxy that will happily buffer an event stream
      // into uselessness otherwise.
      'X-Accel-Buffering': 'no',
    });

    const write = (id: number, data: unknown): void => {
      reply.raw.write(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Replay whatever this screen missed, so a reconnect is invisible.
    const lastSeen = Number(request.headers['last-event-id'] ?? 0);
    for (const row of callEvents.since(Number.isFinite(lastSeen) ? lastSeen : 0)) {
      write(row.id, row.event);
    }

    let id = callEvents.lastId;
    const unsubscribe = callEvents.subscribe((event) => write(++id, event));

    /**
     * A comment line every 15s.
     *
     * Proxies and phone hotspots drop a connection that has said nothing for a
     * while, and the demo can sit idle between calls for far longer than that.
     */
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  /**
   * The numbers, straight from the tables.
   *
   * Recomputed per request rather than cached: the demo resets mid-session and
   * a cached zero on a projector is worse than a slightly slower query.
   */
  app.get('/demo/metrics', async () => {
    const [calls, booked] = await Promise.all([
      db.select().from(conversations).where(eq(conversations.businessId, DEMO_IDS.business)),
      db
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.businessId, DEMO_IDS.business),
            eq(appointments.status, 'booked'),
          ),
        ),
    ]);

    const voice = calls.filter((c) => c.channel === 'voice');
    const finished = voice.filter((c) => c.endedAt !== null);
    /**
     * "Resolved without the owner" means the agent finished the job: it booked,
     * answered, or the caller left satisfied — anything that did NOT need a
     * human. A transfer is the explicit failure of that, so it is the only
     * outcome excluded.
     */
    const resolved = finished.filter((c) => c.outcome !== null && c.outcome !== 'transferred');

    return {
      callsHandled: voice.length,
      appointmentsBooked: booked.length,
      resolvedWithoutOwnerPct:
        finished.length === 0 ? null : Math.round((resolved.length / finished.length) * 100),
      /**
       * Null, never a made-up number, when nothing has been measured yet. A
       * zero here would read as "instant" on a screen behind a pitch.
       */
      avgCallerFacingMs: averageCallerFacingMs(voice),
      estimatedCostPerCallUsd: COST_PER_CALL_USD,
      estimatedCostTotalUsd: Number((voice.length * COST_PER_CALL_USD).toFixed(2)),
    };
  });

  /**
   * Put the clinic back to clean, between runs.
   *
   * Scoped hard to the seeded demo business: it deletes that business's
   * appointments and conversations and nothing else, so it can never be the
   * command that empties a real customer's calendar.
   */
  app.post('/demo/reset', async (request, reply) => {
    const refusal = resetRefusal(env, presentedToken(request.headers));
    if (refusal) {
      // Logged at warn: on stage this is the difference between "the button is
      // broken" and "the button just saved you", and the log says which.
      app.log.warn({ code: refusal.code, error: refusal.error }, 'demo reset refused');
      return reply.code(refusal.code).send({ error: refusal.error, message: refusal.message });
    }

    await db.delete(appointments).where(eq(appointments.businessId, DEMO_IDS.business));
    await db.delete(conversations).where(eq(conversations.businessId, DEMO_IDS.business));
    await seedDemoBusiness(db);

    app.log.info({ business: DEMO_IDS.business }, 'demo reset');
    return { ok: true, resetAt: Date.now(), token: randomUUID() };
  });
}

/**
 * Average of the honest latency: caller stops talking -> first audio.
 *
 * NOT the per-turn `toFirstAudioMs`, which starts counting after Azure has
 * already finalized and in practice just reports the 800ms filler firing on
 * schedule. Quoting that as the caller's experience would be flattering and
 * wrong by roughly half.
 */
function averageCallerFacingMs(rows: { transcript: unknown }[]): number | null {
  const samples: number[] = [];
  for (const row of rows) {
    if (!Array.isArray(row.transcript)) continue;
    for (const turn of row.transcript) {
      const ms = (turn as { callerFacingMs?: unknown }).callerFacingMs;
      if (typeof ms === 'number' && ms > 0) samples.push(ms);
    }
  }
  if (samples.length === 0) return null;
  return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
}
