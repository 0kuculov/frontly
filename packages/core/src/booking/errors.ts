/**
 * Booking failures the agent has to talk its way out of.
 *
 * Each one is a distinct thing to say to a caller, which is why they are codes
 * rather than free-text messages: the tool result carries the code, and the
 * system prompt tells the model how to handle each. A thrown stack trace would
 * become either silence or improvisation on a live phone call.
 */
export type BookingErrorCode =
  /** Someone else took the slot between the offer and the confirmation. */
  | 'slot_taken'
  /** The requested time is outside the clinic's or the staff member's hours. */
  | 'outside_working_hours'
  /** The time has already passed, or is inside the minimum-notice window. */
  | 'in_the_past'
  /** No such service / staff member / appointment for this business. */
  | 'not_found'
  /** This staff member does not perform this service. */
  | 'staff_cannot_perform_service'
  /** The caller's phone number does not match the appointment on file. */
  | 'contact_mismatch'
  /** The appointment is already cancelled. */
  | 'already_cancelled'
  /** Input the model produced that we refuse to act on. */
  | 'invalid_input';

export class BookingError extends Error {
  constructor(
    public readonly code: BookingErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BookingError';
  }
}

/**
 * Drizzle wraps driver errors in a DrizzleQueryError whose message is the SQL,
 * not the reason — the SQLite text lives on `cause`. Walking the chain is the
 * difference between detecting a double-booking and reporting a generic
 * failure to the caller.
 */
export function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(' | ');
}

/** True when SQLite refused the write because the slot was already live. */
export function isUniqueSlotViolation(error: unknown): boolean {
  const text = errorChainText(error);
  return (
    /UNIQUE constraint failed/i.test(text) &&
    /appointments\.staff_id|appointments_staff_slot_unique/i.test(text)
  );
}
