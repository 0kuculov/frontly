import { z } from 'zod';

/** Lifecycle of a booking. `cancelled` rows are kept for the owner's history. */
export const APPOINTMENT_STATUSES = ['booked', 'cancelled', 'completed', 'no_show'] as const;
export const appointmentStatusSchema = z.enum(APPOINTMENT_STATUSES);
export type AppointmentStatus = z.infer<typeof appointmentStatusSchema>;

/** Statuses that occupy a slot. Anything else frees the staff member up again. */
export const BLOCKING_STATUSES: readonly AppointmentStatus[] = ['booked', 'completed'];

/**
 * How a conversation ended. This is the number the owner actually cares about
 * on the metrics page: what fraction resolved without them.
 */
export const CONVERSATION_OUTCOMES = [
  'booked',
  'rescheduled',
  'cancelled',
  'info',
  'transferred',
  'abandoned',
] as const;
export const conversationOutcomeSchema = z.enum(CONVERSATION_OUTCOMES);
export type ConversationOutcome = z.infer<typeof conversationOutcomeSchema>;

/** Outcomes the agent handled end-to-end, with no human involved. */
export const SELF_RESOLVED_OUTCOMES: readonly ConversationOutcome[] = [
  'booked',
  'rescheduled',
  'cancelled',
  'info',
];

/**
 * One line of a transcript. Stored as a JSON array on `conversations` — the
 * same shape for a phone call and a chat session, so the dashboard renders
 * both with one component.
 *
 * `toolCalls` is what makes the stage demo work: the live view (Phase 7)
 * replays the agent's reasoning, not just its words.
 */
export const transcriptTurnSchema = z.object({
  role: z.enum(['agent', 'customer', 'system']),
  text: z.string(),
  /** ms since the conversation started, so playback is channel-independent. */
  atMs: z.number().int().nonnegative(),
  /** STT confidence 0..1, voice only. Absent for chat. */
  confidence: z.number().min(0).max(1).optional(),
  toolCalls: z
    .array(
      z.object({
        name: z.string(),
        input: z.unknown(),
        output: z.unknown().optional(),
        durationMs: z.number().int().nonnegative().optional(),
        error: z.string().optional(),
      }),
    )
    .optional(),
});

export type TranscriptTurn = z.infer<typeof transcriptTurnSchema>;
export const transcriptSchema = z.array(transcriptTurnSchema);
export type Transcript = z.infer<typeof transcriptSchema>;

/** A bookable opening returned by check_availability. Instants, always UTC. */
export const slotSchema = z.object({
  staffId: z.string(),
  startsAt: z.date(),
  endsAt: z.date(),
});
export type Slot = z.infer<typeof slotSchema>;

/** Loose E.164-ish check. Balkan mobiles arrive as +389…, +355…, +383…. */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9\s().-]{6,20}$/, 'Expected a phone number');

/** Hex colour for the widget + dashboard theming. */
export const brandColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex colour like "#0F766E"');

/** IANA timezone. Business hours are meaningless without one. */
export const timezoneSchema = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Expected a valid IANA timezone, e.g. "Europe/Skopje"');
