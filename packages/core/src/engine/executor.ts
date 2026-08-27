import { z } from 'zod';
import { bookAppointment, cancelAppointment, rescheduleAppointment } from '../booking/booking.js';
import { distinctStartTimes, findFreeSlots, spreadSlots } from '../booking/availability.js';
import { BookingError } from '../booking/errors.js';
import type { Service } from '../db/schema.js';
import { speakDate, speakDateTime, speakDuration, speakTime } from '../time/speech.js';
import { eachLocalDate, toLocalDateString } from '../time/zone.js';
import {
  bookAppointmentInput,
  cancelAppointmentInput,
  checkAvailabilityInput,
  confirmDetailsInput,
  rescheduleAppointmentInput,
  transferToHumanInput,
} from './tools.js';
import type { TurnContext } from './types.js';

/**
 * Tool dispatch.
 *
 * Two jobs beyond calling the booking layer:
 *
 *  1. Validate. A tool input is model-generated text and is treated like any
 *     other untrusted input — zod first, business logic second.
 *
 *  2. Hand back speech, not data. Every result carries a `spoken` field
 *     already phrased in the caller's language, so the model repeats a string
 *     rather than formatting a date itself. That is what keeps ISO timestamps
 *     out of a phone call.
 */

export interface ToolExecutionResult {
  output: unknown;
  isError: boolean;
}

/** Never offer availability further out than this from a single question. */
const MAX_RANGE_DAYS = 21;

/** Upper bound on slots considered per lookup, before the spoken selection. */
const MAX_SLOTS_CONSIDERED = 500;

/** Distinct start times returned when the question is about one day. */
const MAX_TIMES_PER_DAY = 24;

/**
 * Per-context memo of which slots have already been recorded, so repeated
 * check_availability calls in one conversation do not grow offeredSlots
 * without bound.
 */
const offeredKeys = {
  cache: new WeakMap<object, Set<string>>(),
  get(ctx: object): Set<string> {
    let set = this.cache.get(ctx);
    if (!set) {
      set = new Set<string>();
      this.cache.set(ctx, set);
    }
    return set;
  },
};

export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: TurnContext,
): Promise<ToolExecutionResult> {
  try {
    switch (name) {
      case 'check_availability':
        return await runCheckAvailability(rawInput, ctx);
      case 'book_appointment':
        return await runBookAppointment(rawInput, ctx);
      case 'cancel_appointment':
        return await runCancelAppointment(rawInput, ctx);
      case 'reschedule_appointment':
        return await runRescheduleAppointment(rawInput, ctx);
      case 'transfer_to_human':
        return runTransferToHuman(rawInput, ctx);
      case 'confirm_details':
        return runConfirmDetails(rawInput, ctx);
      case 'end_call':
        return runEndCall(ctx);
      default:
        return fail('unknown_tool', `No such tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof BookingError) {
      return fail(error.code, error.message, error.details);
    }
    if (error instanceof z.ZodError) {
      return fail('invalid_input', error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    // Anything unexpected: the agent must be able to say something, never crash
    // a live call. The message is logged by handleTurn via the ToolCallRecord.
    return fail('internal_error', error instanceof Error ? error.message : String(error));
  }
}

// --- check_availability ------------------------------------------------------

async function runCheckAvailability(
  rawInput: unknown,
  ctx: TurnContext,
): Promise<ToolExecutionResult> {
  const input = checkAvailabilityInput.parse(rawInput);
  const now = ctx.now ?? new Date();
  const service = requireService(ctx, input.service_id);

  const from = clampToToday(input.date_from, ctx, now);
  const to = clampRange(from, input.date_to);

  const tz = ctx.business.timezone;

  // Find everything genuinely free, then say only a handful of it.
  const slots = await findFreeSlots(ctx.db, {
    business: ctx.business,
    service,
    staff: ctx.staff,
    from,
    to,
    staffId: input.staff_id ?? undefined,
    now,
    limit: MAX_SLOTS_CONSIDERED,
  });

  /**
   * Every slot found is recorded, not just the ones read out. All of them came
   * from the database, so booking one is never an invention — and it means a
   * caller who asks for a specific time ("има ли во единаесет и четвврт?") can
   * be booked without a second lookup. What the guard still refuses is a time
   * that was never free.
   */
  for (const slot of slots) {
    const key = `${service.id}|${slot.staffId}|${slot.startsAt.toISOString()}`;
    if (offeredKeys.get(ctx).has(key)) continue;
    offeredKeys.get(ctx).add(key);
    ctx.state.offeredSlots.push({
      serviceId: service.id,
      staffId: slot.staffId,
      startsAt: slot.startsAt.toISOString(),
    });
  }

  /**
   * A single day comes back COMPLETE; only a multi-day range is sampled.
   *
   * This matters more than it looks. Handed a sample, the model treats it as
   * exhaustive and tells callers that an unlisted time is unavailable — which
   * is a confident lie about a slot that is actually free. At half-hour
   * granularity one day fits comfortably, so for the common question ("what
   * about tomorrow?") there is nothing to infer from.
   */
  const dayCount = eachLocalDate(from, to).length;
  const shown =
    dayCount === 1
      ? distinctStartTimes(slots, MAX_TIMES_PER_DAY)
      : spreadSlots(slots, { timeZone: tz, perDay: 3, total: 12 });
  const complete = dayCount === 1 && shown.length === distinctStartTimes(slots, Number.MAX_SAFE_INTEGER).length;
  const lang = ctx.state.language;

  if (slots.length === 0) {
    return {
      isError: false,
      output: {
        service: serviceName(service, lang),
        slots: [],
        note: 'Нема слободни термини во бараниот период. Понуди друг период или префрли на човек.',
      },
    };
  }

  return {
    isError: false,
    output: {
      service: serviceName(service, lang),
      duration: speakDuration(service.durationMinutes, lang),
      total_free: slots.length,
      is_complete: complete,
      note: complete
        ? 'Ова се СИТЕ слободни термини за тој ден. Ако време не е тука, навистина е зафатено. ' +
          'Понуди најмногу два.'
        : 'Ова е ИЗБОР, не целосен список. Ако пациентот прашува за конкретно време, повикај ја ' +
          'check_availability повторно само за тој ден пред да кажеш дека е зафатено. Понуди најмногу два.',
      slots: shown.map((slot) => ({
        starts_at: slot.startsAt.toISOString(),
        staff_id: slot.staffId,
        staff_name: slot.staffName,
        // Ready to say out loud — do not reformat this.
        spoken: speakDateTime(slot.startsAt, tz, lang, { now }),
      })),
    },
  };
}

// --- book_appointment --------------------------------------------------------

async function runBookAppointment(
  rawInput: unknown,
  ctx: TurnContext,
): Promise<ToolExecutionResult> {
  const input = bookAppointmentInput.parse(rawInput);
  const now = ctx.now ?? new Date();
  const service = requireService(ctx, input.service_id);

  const startsAt = parseInstant(input.starts_at);

  /**
   * The hard stop on invented availability. The model may only book a slot
   * that check_availability actually returned in this conversation — matched
   * on the instant, not the string, so trailing-millisecond differences do not
   * cause a false rejection.
   */
  const wasOffered = ctx.state.offeredSlots.some(
    (slot) =>
      slot.serviceId === service.id &&
      slot.staffId === input.staff_id &&
      Date.parse(slot.startsAt) === startsAt.getTime(),
  );

  if (!wasOffered) {
    return fail(
      'slot_not_offered',
      'Тој термин не е меѓу слободните термини што ги врати check_availability. ' +
        'Повикај ја check_availability и понуди само термин од резултатот.',
    );
  }

  /**
   * The hard stop on a misheard name or number.
   *
   * Deliberately not left to the prompt. Recognition confidence cannot
   * separate a correct booking from a confidently wrong one — a butchered
   * Macedonian sentence scored 0.87 against a correct 0.88, and Albanian
   * returns a constant 0.79 whatever is said — so the caller hearing their own
   * details read back is the only check that actually works. Applied in every
   * language, because the failure ("Petrovski" heard as "Petrovci") is fluent,
   * high-confidence and language-independent.
   */
  const notConfirmed = detailsNotConfirmed(ctx, input.customer_name, input.customer_contact);
  if (notConfirmed) return notConfirmed;

  const appointment = await bookAppointment(ctx.db, {
    business: ctx.business,
    serviceId: service.id,
    staffId: input.staff_id,
    startsAt,
    customerName: input.customer_name,
    customerPhone: input.customer_contact,
    channel: ctx.channel,
    now,
  });

  ctx.state.appointmentId = appointment.id;
  ctx.state.customerName = appointment.customerName;
  ctx.state.customerPhone = appointment.customerPhone;
  ctx.state.outcome = 'booked';

  const tz = ctx.business.timezone;
  const lang = ctx.state.language;

  return {
    isError: false,
    output: {
      booked: true,
      appointment_id: appointment.id,
      service: serviceName(service, lang),
      spoken: speakDateTime(appointment.startsAt, tz, lang, { now }),
      customer_name: appointment.customerName,
    },
  };
}

// --- cancel_appointment ------------------------------------------------------

async function runCancelAppointment(
  rawInput: unknown,
  ctx: TurnContext,
): Promise<ToolExecutionResult> {
  const input = cancelAppointmentInput.parse(rawInput);
  const now = ctx.now ?? new Date();

  const cancelled = await cancelAppointment(ctx.db, {
    business: ctx.business,
    appointmentId: input.appointment_id ?? undefined,
    customerPhone: input.customer_contact,
    now,
  });

  ctx.state.outcome = 'cancelled';

  return {
    isError: false,
    output: {
      cancelled: true,
      appointment_id: cancelled.id,
      spoken: speakDateTime(cancelled.startsAt, ctx.business.timezone, ctx.state.language, { now }),
    },
  };
}

// --- reschedule_appointment --------------------------------------------------

async function runRescheduleAppointment(
  rawInput: unknown,
  ctx: TurnContext,
): Promise<ToolExecutionResult> {
  const input = rescheduleAppointmentInput.parse(rawInput);
  const now = ctx.now ?? new Date();
  const newStartsAt = parseInstant(input.new_starts_at);

  // Same rule as booking: a new time must have been offered.
  const wasOffered = ctx.state.offeredSlots.some(
    (slot) => Date.parse(slot.startsAt) === newStartsAt.getTime(),
  );
  if (!wasOffered) {
    return fail(
      'slot_not_offered',
      'Тоа време не е меѓу слободните термини. Повикај ја check_availability прво.',
    );
  }

  const updated = await rescheduleAppointment(ctx.db, {
    business: ctx.business,
    appointmentId: input.appointment_id,
    newStartsAt,
    now,
  });

  ctx.state.appointmentId = updated.id;
  ctx.state.outcome = 'rescheduled';

  return {
    isError: false,
    output: {
      rescheduled: true,
      appointment_id: updated.id,
      spoken: speakDateTime(updated.startsAt, ctx.business.timezone, ctx.state.language, { now }),
    },
  };
}

// --- confirm_details ---------------------------------------------------------

/**
 * Normalised so a confirmation survives ordinary reformatting.
 *
 * The model may read a number back as "070 123 456" and then pass
 * "+38970123456" to the booking. That is the same number and must not count as
 * unconfirmed — separators and case carry no identity, the digits and letters
 * do.
 */
function normaliseDetail(value: string): string {
  return value.toLowerCase().replace(/[\s\-().+]/g, '').trim();
}

/**
 * Is this the same phone number the caller heard read back?
 *
 * Compared on the last eight digits rather than the whole string, because
 * "070 111 222" and "+389 70 111 222" are the same Macedonian mobile written
 * two ways, and the model routinely reads one form aloud and passes the other
 * to the booking. A gate that rejected that would fire on CORRECT bookings —
 * and a safety check that cries wolf is a safety check somebody switches off.
 *
 * Eight digits is the significant part of a Macedonian mobile after the
 * national or country prefix. Anything shorter is compared whole.
 */
function sameContact(a: string, b: string): boolean {
  const digitsOf = (value: string) => value.replace(/\D/g, '');
  const left = digitsOf(a);
  const right = digitsOf(b);

  if (left.length < 8 || right.length < 8) return normaliseDetail(a) === normaliseDetail(b);
  return left.slice(-8) === right.slice(-8);
}

function runConfirmDetails(rawInput: unknown, ctx: TurnContext): ToolExecutionResult {
  const input = confirmDetailsInput.parse(rawInput);

  ctx.state.detailsConfirmation = {
    name: normaliseDetail(input.customer_name),
    phone: normaliseDetail(input.customer_contact),
    /**
     * The turn this happened on. `book_appointment` requires a LATER one,
     * which is the whole mechanism: it forces the caller to have been given a
     * chance to answer, rather than the model confirming and booking in one
     * breath.
     */
    turn: ctx.state.turnCount,
  };

  return {
    isError: false,
    output: {
      awaiting_confirmation: true,
      customer_name: input.customer_name,
      customer_contact: input.customer_contact,
      note:
        'Изговори му ги името и бројот на пациентот и почекај да потврди. ' +
        'Не закажувај во оваа реплика.',
    },
  };
}

/**
 * Why this booking may not proceed, or undefined if it may.
 *
 * Three refusals rather than one, because the model has to know which mistake
 * it made: never confirmed, confirmed something else, or confirmed and booked
 * in the same breath. A single generic error would have it retry the same way.
 */
function detailsNotConfirmed(
  ctx: TurnContext,
  name: string,
  contact: string,
): ToolExecutionResult | undefined {
  const confirmation = ctx.state.detailsConfirmation;

  if (!confirmation) {
    return fail(
      'details_not_confirmed',
      'Пред да закажеш мораш да ги потврдиш податоците. Повикај ја confirm_details со името ' +
        'и бројот, изговори му ги на пациентот, и закажи дури откако ќе потврди.',
    );
  }

  if (confirmation.name !== normaliseDetail(name) || !sameContact(confirmation.phone, contact)) {
    return fail(
      'details_changed_since_confirmation',
      'Името или бројот се различни од тие што ги потврди пациентот. Повикај ја повторно ' +
        'confirm_details со точните податоци и почекај нова потврда.',
    );
  }

  if (ctx.state.turnCount <= confirmation.turn) {
    return fail(
      'confirmation_too_soon',
      'Ги потврди податоците во истата реплика. Почекај пациентот да одговори дека се точни, ' +
        'па закажи во следната реплика.',
    );
  }

  return undefined;
}

// --- transfer_to_human -------------------------------------------------------

function runTransferToHuman(rawInput: unknown, ctx: TurnContext): ToolExecutionResult {
  const input = transferToHumanInput.parse(rawInput);
  ctx.state.outcome = 'transferred';
  ctx.state.transferReason = input.reason;

  return {
    isError: false,
    output: {
      transferred: true,
      owner_will_be_notified: true,
      note: 'Кажи му на пациентот дека ќе го поврзеш со човек или дека ќе му се јават наскоро.',
    },
  };
}

// --- helpers -----------------------------------------------------------------

// --- end_call ----------------------------------------------------------------

/**
 * The caller's business is finished and the goodbyes have been said.
 *
 * This exists because nothing else could tell the adapter a conversation was
 * OVER. The agent would say "пријатен ден" as ordinary text, the session had
 * no idea anything had concluded, and the silence ladder then reprompted a
 * caller who had already been shown the door — farewell, dead air, then
 * "сè уште сте тука?". Heard on a real call.
 *
 * Note it does NOT hang up here: `packages/core` knows nothing about phones.
 * It records that the conversation reached its end, and the channel adapter
 * decides what that means — a voice call hangs up after a grace period, chat
 * simply stops.
 */
function runEndCall(ctx: TurnContext): ToolExecutionResult {
  ctx.state.concluded = true;
  /**
   * Only when nothing more specific happened.
   *
   * A booking, a cancellation or a reschedule has already set its own outcome
   * and that is the interesting one; `info` is what is left when the agent
   * simply answered a question — which is still resolved without the owner.
   */
  ctx.state.outcome ??= 'info';

  return {
    isError: false,
    output: { ended: true },
  };
}

function fail(code: string, message: string, details?: Record<string, unknown>): ToolExecutionResult {
  return { isError: true, output: { error: code, message, ...(details ? { details } : {}) } };
}

function requireService(ctx: TurnContext, serviceId: string): Service {
  const service = ctx.services.find((s) => s.id === serviceId && s.active);
  if (!service) {
    throw new BookingError('not_found', `Нема таква услуга: ${serviceId}`);
  }
  return service;
}

/** Exported so the recognition vocabulary uses the same names the agent says. */
export function serviceName(service: Service, language: string): string {
  if (language === 'sq') return service.nameSq ?? service.nameMk;
  if (language === 'en') return service.nameEn ?? service.nameMk;
  return service.nameMk;
}

function parseInstant(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BookingError('invalid_input', `Невалидно време: ${value}`);
  }
  return parsed;
}

/** A caller asking about "tomorrow" must never be shown yesterday. */
function clampToToday(requested: string, ctx: TurnContext, now: Date): string {
  const today = toLocalDateString(now, ctx.business.timezone);
  return requested < today ? today : requested;
}

function clampRange(from: string, to: string): string {
  if (to < from) return from;
  const [y, m, d] = from.split('-').map(Number) as [number, number, number];
  const max = new Date(Date.UTC(y, m - 1, d + MAX_RANGE_DAYS));
  const maxString = `${max.getUTCFullYear()}-${String(max.getUTCMonth() + 1).padStart(2, '0')}-${String(
    max.getUTCDate(),
  ).padStart(2, '0')}`;
  return to > maxString ? maxString : to;
}

/** Exported for the prompt's "speak naturally" rule to be testable in isolation. */
export const speechHelpers = { speakDate, speakTime, speakDateTime };
