import { eq } from 'drizzle-orm';
import type {
  Channel,
  ConversationOutcome,
  Language,
  Transcript,
  VoiceConfig,
} from '@frontly/shared';
import type { Database } from './client.js';
import {
  businesses,
  conversations,
  services,
  staff,
  type Business,
  type Conversation,
  type Service,
  type StaffMember,
} from './schema.js';

/**
 * Reads and writes the adapters need.
 *
 * They exist so that `apps/api` never imports drizzle. The rule is not
 * cosmetic: the moment an adapter can write SQL, booking logic starts leaking
 * into the channel that happened to need it first, and the engine stops being
 * channel-agnostic. Same reasoning as `runMigrations` in Phase 1.
 */

/** Everything a conversation needs about a business, in one round trip. */
export interface BusinessContext {
  business: Business;
  services: Service[];
  staff: StaffMember[];
}

/**
 * Every business this deployment serves.
 *
 * Used at boot to pre-synthesize each one's fixed phrases. Deliberately not
 * paginated: a deployment with enough clinics for that to matter has bigger
 * changes to make than this query.
 */
export async function listBusinesses(db: Database): Promise<Business[]> {
  return db.select().from(businesses);
}

export async function getBusinessById(
  db: Database,
  businessId: string,
): Promise<Business | undefined> {
  const [row] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  return row;
}

/**
 * Route an inbound call by the number that was dialled, so one deployment can
 * serve several clinics.
 *
 * Falls back to the only business when exactly one exists — that is what makes
 * the pipeline testable before a real number has been bought, and it cannot
 * misroute, because with two businesses it returns nothing instead of guessing.
 */
export async function getBusinessForDialledNumber(
  db: Database,
  dialled: string | undefined,
): Promise<Business | undefined> {
  if (dialled) {
    const [match] = await db.select().from(businesses).where(eq(businesses.inboundNumber, dialled));
    if (match) return match;
  }
  const all = await db.select().from(businesses);
  return all.length === 1 ? all[0] : undefined;
}

/**
 * Replace a business's voice configuration.
 *
 * Exists so the speech-tuning script can change segmentation and barge-in
 * thresholds without a deploy: the next call reads the new values. Voice
 * settings were always per-business config rather than constants precisely so
 * they could be tuned by ear on a real line.
 */
export async function updateVoiceConfig(
  db: Database,
  businessId: string,
  voiceConfig: VoiceConfig,
): Promise<void> {
  await db
    .update(businesses)
    .set({ voiceConfig, updatedAt: new Date() })
    .where(eq(businesses.id, businessId));
}

export async function getBusinessContext(
  db: Database,
  businessId: string,
): Promise<BusinessContext | undefined> {
  const business = await getBusinessById(db, businessId);
  if (!business) return undefined;

  const [businessServices, businessStaff] = await Promise.all([
    db.select().from(services).where(eq(services.businessId, businessId)),
    db.select().from(staff).where(eq(staff.businessId, businessId)),
  ]);

  return { business, services: businessServices, staff: businessStaff };
}

export interface StartConversationInput {
  businessId: string;
  channel: Channel;
  /** The carrier's call reference, or the widget session id. */
  externalId: string;
  fromIdentifier?: string | undefined;
  language?: Language | undefined;
  startedAt?: Date;
}

/**
 * Idempotent by (channel, external_id): a carrier webhook retry reuses the row
 * rather than opening a second conversation for one call.
 */
export async function startConversation(
  db: Database,
  input: StartConversationInput,
): Promise<Conversation> {
  const [created] = await db
    .insert(conversations)
    .values({
      businessId: input.businessId,
      channel: input.channel,
      externalId: input.externalId,
      fromIdentifier: input.fromIdentifier ?? null,
      startedAt: input.startedAt ?? new Date(),
      languageDetected: input.language ?? null,
      transcript: [],
    })
    .onConflictDoNothing()
    .returning();

  if (created) return created;

  const [existing] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.externalId, input.externalId));

  if (!existing) throw new Error(`Could not start or find conversation ${input.externalId}`);
  return existing;
}

export interface UpdateConversationInput {
  transcript?: Transcript;
  language?: Language | undefined;
  outcome?: ConversationOutcome | undefined;
  appointmentId?: string | undefined;
  ended?: boolean;
}

export async function updateConversation(
  db: Database,
  conversationId: string,
  input: UpdateConversationInput,
): Promise<void> {
  await db
    .update(conversations)
    .set({
      ...(input.transcript ? { transcript: input.transcript } : {}),
      ...(input.language ? { languageDetected: input.language } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.appointmentId ? { appointmentId: input.appointmentId } : {}),
      ...(input.ended ? { endedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));
}

/** Read a conversation back — used by the dashboard and the Phase 7 live view. */
export async function getConversation(
  db: Database,
  conversationId: string,
): Promise<Conversation | undefined> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  return row;
}
