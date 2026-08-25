import { randomUUID } from 'node:crypto';
import {
  appointments,
  conversations,
  DEMO_IDS,
  seedDemoBusiness,
  type Database,
} from '@frontly/core';
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
}

export async function registerDemoRoutes(
  app: FastifyInstance,
  options: DemoRouteOptions,
): Promise<void> {
  const { db } = options;

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
  app.post('/demo/reset', async () => {
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
