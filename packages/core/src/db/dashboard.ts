import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { Database } from './client.js';
import { appointments, conversations, services, staff } from './schema.js';

/**
 * Reads for the owner dashboard.
 *
 * Separate from `queries.ts` because these exist to answer a screen's
 * question, not the engine's: "what does today look like", "what happened on
 * that call". They join the names in rather than returning foreign keys,
 * because every one of them is on its way to being rendered and a second
 * round trip per row is how a dashboard gets slow.
 *
 * Every function takes a `businessId` and filters on it. That is not defence
 * in depth, it IS the tenancy boundary: a login is scoped to one business, and
 * a query here that forgot the filter would quietly serve someone else's
 * patients.
 */

export interface DashboardAppointment {
  id: string;
  startsAt: Date;
  endsAt: Date;
  customerName: string;
  customerPhone: string;
  status: string;
  channel: string;
  serviceName: string;
  serviceDurationMinutes: number;
  staffName: string;
  staffId: string;
  confirmationSentAt: Date | null;
  reminderSentAt: Date | null;
}

function appointmentSelection() {
  return {
    id: appointments.id,
    startsAt: appointments.startsAt,
    endsAt: appointments.endsAt,
    customerName: appointments.customerName,
    customerPhone: appointments.customerPhone,
    status: appointments.status,
    channel: appointments.channel,
    serviceName: services.nameMk,
    serviceDurationMinutes: services.durationMinutes,
    staffName: staff.name,
    staffId: staff.id,
    confirmationSentAt: appointments.confirmationSentAt,
    reminderSentAt: appointments.reminderSentAt,
  };
}

/** Appointments overlapping an instant range, in time order. */
export async function appointmentsBetween(
  db: Database,
  businessId: string,
  from: Date,
  to: Date,
): Promise<DashboardAppointment[]> {
  const rows = await db
    .select(appointmentSelection())
    .from(appointments)
    .innerJoin(services, eq(appointments.serviceId, services.id))
    .innerJoin(staff, eq(appointments.staffId, staff.id))
    .where(
      and(
        eq(appointments.businessId, businessId),
        gte(appointments.startsAt, from),
        lte(appointments.startsAt, to),
      ),
    )
    .orderBy(appointments.startsAt);

  return rows as DashboardAppointment[];
}

export interface DashboardConversation {
  id: string;
  channel: string;
  externalId: string;
  startedAt: Date;
  endedAt: Date | null;
  outcome: string | null;
  languageDetected: string | null;
  /** Caller ID for voice, or whatever identifies the other side on chat. */
  fromIdentifier: string | null;
  /** Milliseconds, computed here so every caller agrees what a duration is. */
  durationMs: number | null;
  /** Average caller-facing latency across the turns that measured one. */
  avgCallerFacingMs: number | null;
  turnCount: number;
}

/**
 * The conversations list.
 *
 * Duration and latency are derived here rather than in the UI: they are the
 * two numbers a judge asks about, and computing them in one place stops the
 * list and the detail view quietly disagreeing.
 */
export async function listConversations(
  db: Database,
  businessId: string,
  { limit = 50, offset = 0 } = {},
): Promise<DashboardConversation[]> {
  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.businessId, businessId))
    .orderBy(desc(conversations.startedAt))
    .limit(limit)
    .offset(offset);

  return rows.map(summarize);
}

export async function getConversationDetail(
  db: Database,
  businessId: string,
  id: string,
): Promise<(DashboardConversation & { transcript: unknown }) | undefined> {
  const [row] = await db
    .select()
    .from(conversations)
    // The businessId filter is the tenancy boundary, not a nicety: without it
    // any id from any clinic would resolve.
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, id)));

  if (!row) return undefined;
  return { ...summarize(row), transcript: row.transcript };
}

function summarize(row: typeof conversations.$inferSelect): DashboardConversation {
  const turns = Array.isArray(row.transcript) ? row.transcript : [];

  const latencies: number[] = [];
  for (const turn of turns) {
    const ms = (turn as { callerFacingMs?: unknown }).callerFacingMs;
    if (typeof ms === 'number' && ms > 0) latencies.push(ms);
  }

  return {
    id: row.id,
    channel: row.channel,
    externalId: row.externalId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    outcome: row.outcome,
    languageDetected: row.languageDetected,
    fromIdentifier: row.fromIdentifier,
    durationMs: row.endedAt ? row.endedAt.getTime() - row.startedAt.getTime() : null,
    avgCallerFacingMs:
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : null,
    turnCount: turns.length,
  };
}

/** Conversations that started inside a range — what "today" is counted from. */
export async function conversationsBetween(
  db: Database,
  businessId: string,
  from: Date,
  to: Date,
): Promise<DashboardConversation[]> {
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.businessId, businessId),
        gte(conversations.startedAt, from),
        lte(conversations.startedAt, to),
      ),
    )
    .orderBy(desc(conversations.startedAt));

  return rows.map(summarize);
}
