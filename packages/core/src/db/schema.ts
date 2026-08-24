import { relations, sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  APPOINTMENT_STATUSES,
  BOOKING_SOURCES,
  CHANNELS,
  CONVERSATION_OUTCOMES,
  DEFAULT_VOICE_CONFIG,
  LANGUAGES,
  type Language,
  type Transcript,
  type VoiceConfig,
  type WorkingHours,
} from '@frontly/shared';
import { newId } from './ids.js';

/**
 * Frontly schema (libSQL / SQLite via Turso).
 *
 * Two decisions worth knowing before you read further:
 *
 *  1. There is ONE `conversations` table for phone and chat, told apart by
 *     `channel`. Every metric, transcript view and dashboard query is written
 *     once. A third channel is a new enum value, not a migration.
 *
 *  2. Instants (`starts_at`, `ends_at`, ...) are stored as UTC epoch millis.
 *     Wall-clock strings ("09:00") appear only inside working-hours JSON,
 *     where they are interpreted against the business's own timezone.
 */

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
};

// --- businesses ------------------------------------------------------------

export const businesses = sqliteTable(
  'businesses',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('business')),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** The clinic's own public number, shown in the dashboard. */
    phoneNumber: text('phone_number'),
    /** The number callers dial, whoever carries it. Inbound calls route by this. */
    inboundNumber: text('inbound_number'),
    timezone: text('timezone').notNull().default('Europe/Skopje'),
    /** Languages this business answers in, most-preferred first. */
    languages: text('languages', { mode: 'json' })
      .$type<Language[]>()
      .notNull()
      .default(['mk']),
    workingHours: text('working_hours', { mode: 'json' }).$type<WorkingHours>().notNull(),
    /** Supports {{business_name}} - rendered per call, per language. */
    greetingTemplate: text('greeting_template').notNull(),
    /** Where transfer_to_human and the 20:00 summary go. */
    ownerMobile: text('owner_mobile'),
    brandColor: text('brand_color').notNull().default('#0F766E'),
    /** Per-language voice + prosody. Editable in Settings, never hardcoded. */
    voiceConfig: text('voice_config', { mode: 'json' })
      .$type<VoiceConfig>()
      .notNull()
      .default(DEFAULT_VOICE_CONFIG),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('businesses_slug_unique').on(t.slug),
    uniqueIndex('businesses_inbound_number_unique').on(t.inboundNumber),
  ],
);

// --- services --------------------------------------------------------------

export const services = sqliteTable(
  'services',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('service')),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    /** Macedonian is required; the others fall back to it when absent. */
    nameMk: text('name_mk').notNull(),
    nameSq: text('name_sq'),
    nameEn: text('name_en'),
    durationMinutes: integer('duration_minutes').notNull(),
    /** Whole denars. MKD has no subunit in practical use. */
    price: integer('price'),
    currency: text('currency').notNull().default('MKD'),
    descriptionMk: text('description_mk'),
    descriptionSq: text('description_sq'),
    descriptionEn: text('description_en'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (t) => [index('services_business_idx').on(t.businessId, t.active)],
);

// --- staff -----------------------------------------------------------------

export const staff = sqliteTable(
  'staff',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('staff')),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Services this person can perform. Empty array = all of them. */
    serviceIds: text('service_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** NULL means "inherits the business's working hours". */
    workingHours: text('working_hours', { mode: 'json' }).$type<WorkingHours>(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (t) => [index('staff_business_idx').on(t.businessId, t.active)],
);

// --- appointments ----------------------------------------------------------

export const appointments = sqliteTable(
  'appointments',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('appointment')),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'restrict' }),
    customerName: text('customer_name').notNull(),
    /** Required: a booking with no way to reach the customer is not a booking. */
    customerPhone: text('customer_phone').notNull(),
    startsAt: integer('starts_at', { mode: 'timestamp_ms' }).notNull(),
    endsAt: integer('ends_at', { mode: 'timestamp_ms' }).notNull(),
    status: text('status', { enum: APPOINTMENT_STATUSES }).notNull().default('booked'),
    /** voice | chat | manual - where this booking came from. */
    channel: text('channel', { enum: BOOKING_SOURCES }).notNull(),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    /**
     * The double-booking guard (Phase 2 relies on it).
     *
     * Partial rather than a plain UNIQUE(staff_id, starts_at): a cancelled
     * appointment must not keep its slot hostage, so only live rows collide.
     * Enforced by SQLite itself, which means two concurrent calls racing for
     * the same 10:30 slot end with one INSERT failing - not two bookings.
     */
    uniqueIndex('appointments_staff_slot_unique')
      .on(t.staffId, t.startsAt)
      .where(sql`${t.status} in ('booked', 'completed')`),
    index('appointments_business_time_idx').on(t.businessId, t.startsAt),
    index('appointments_staff_time_idx').on(t.staffId, t.startsAt),
    index('appointments_customer_phone_idx').on(t.businessId, t.customerPhone),
  ],
);

// --- conversations ---------------------------------------------------------

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('conversation')),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    /** voice | chat. The ONLY thing that distinguishes the two channels here. */
    channel: text('channel', { enum: CHANNELS }).notNull(),
    /** The carrier's call reference for voice, widget session id for chat. */
    externalId: text('external_id').notNull(),
    /** Caller's number, or an anonymous visitor id for chat. */
    fromIdentifier: text('from_identifier'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
    languageDetected: text('language_detected', { enum: LANGUAGES }),
    outcome: text('outcome', { enum: CONVERSATION_OUTCOMES }),
    transcript: text('transcript', { mode: 'json' }).$type<Transcript>().notNull().default([]),
    appointmentId: text('appointment_id').references(() => appointments.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    /** One conversation row per call/session, so retries stay idempotent. */
    uniqueIndex('conversations_channel_external_unique').on(t.channel, t.externalId),
    index('conversations_business_started_idx').on(t.businessId, t.startedAt),
    index('conversations_outcome_idx').on(t.businessId, t.outcome),
  ],
);

// --- relations -------------------------------------------------------------

export const businessesRelations = relations(businesses, ({ many }) => ({
  services: many(services),
  staff: many(staff),
  appointments: many(appointments),
  conversations: many(conversations),
}));

export const servicesRelations = relations(services, ({ one, many }) => ({
  business: one(businesses, { fields: [services.businessId], references: [businesses.id] }),
  appointments: many(appointments),
}));

export const staffRelations = relations(staff, ({ one, many }) => ({
  business: one(businesses, { fields: [staff.businessId], references: [businesses.id] }),
  appointments: many(appointments),
}));

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  business: one(businesses, { fields: [appointments.businessId], references: [businesses.id] }),
  service: one(services, { fields: [appointments.serviceId], references: [services.id] }),
  staffMember: one(staff, { fields: [appointments.staffId], references: [staff.id] }),
}));

export const conversationsRelations = relations(conversations, ({ one }) => ({
  business: one(businesses, { fields: [conversations.businessId], references: [businesses.id] }),
  appointment: one(appointments, {
    fields: [conversations.appointmentId],
    references: [appointments.id],
  }),
}));

// --- inferred row types ----------------------------------------------------

export type Business = typeof businesses.$inferSelect;
export type NewBusiness = typeof businesses.$inferInsert;
export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;
export type StaffMember = typeof staff.$inferSelect;
export type NewStaffMember = typeof staff.$inferInsert;
export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
