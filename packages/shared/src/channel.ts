import { z } from 'zod';

/**
 * Every conversation — phone or web — lands in the same `conversations` table
 * and is told apart by this field. Adding Viber/WhatsApp later means adding a
 * value here and writing one adapter, never a new table or a new engine path.
 */
export const CHANNELS = ['voice', 'chat'] as const;
export const channelSchema = z.enum(CHANNELS);
export type Channel = z.infer<typeof channelSchema>;

/**
 * How an appointment came into existence. Superset of Channel: the owner can
 * also create one by hand in the dashboard calendar (Phase 4).
 */
export const BOOKING_SOURCES = ['voice', 'chat', 'manual'] as const;
export const bookingSourceSchema = z.enum(BOOKING_SOURCES);
export type BookingSource = z.infer<typeof bookingSourceSchema>;
