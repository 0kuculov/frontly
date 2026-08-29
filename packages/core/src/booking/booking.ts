import { and, desc, eq, gte } from 'drizzle-orm';
import { BLOCKING_STATUSES, toMinutes, type BookingSource, type WorkingHours } from '@frontly/shared';
import type { Database } from '../db/client.js';
import {
  appointments,
  services,
  staff as staffTable,
  type Appointment,
  type Business,
  type Service,
  type StaffMember,
} from '../db/schema.js';
import { dayKeyForLocalDate, toLocalDateString, toZonedParts } from '../time/zone.js';
import { BookingError, isUniqueSlotViolation } from './errors.js';
import { staffForService } from './availability.js';

/**
 * Writes against the appointment book.
 *
 * The race that matters: two callers are offered 10:30 with Dr Ana at the same
 * moment and both say yes. Checking "is it free?" and then inserting cannot fix
 * that — however small, there is a window between the two statements. So the
 * authority is the partial unique index on (staff_id, starts_at), and this
 * module's job is to turn its rejection into something the agent can say.
 *
 * The transaction is what makes the validating reads and the insert a single
 * unit; the index is what makes concurrency safe.
 */

export interface BookInput {
  business: Business;
  serviceId: string;
  staffId: string;
  startsAt: Date;
  customerName: string;
  customerPhone: string;
  channel: BookingSource;
  notes?: string | undefined;
  now?: Date;
  minimumNoticeMinutes?: number;
}

const DEFAULT_MINIMUM_NOTICE_MINUTES = 60;

export async function bookAppointment(db: Database, input: BookInput): Promise<Appointment> {
  const {
    business,
    serviceId,
    staffId,
    startsAt,
    customerName,
    customerPhone,
    channel,
    now = new Date(),
    minimumNoticeMinutes = DEFAULT_MINIMUM_NOTICE_MINUTES,
  } = input;

  if (!customerName.trim()) {
    throw new BookingError('invalid_input', 'A booking needs the customer name');
  }
  if (!customerPhone.trim()) {
    throw new BookingError('invalid_input', 'A booking needs a contact number');
  }
  if (Number.isNaN(startsAt.getTime())) {
    throw new BookingError('invalid_input', `Unparseable start time`);
  }
  if (startsAt.getTime() < now.getTime() + minimumNoticeMinutes * 60_000) {
    throw new BookingError('in_the_past', 'That time has already passed or is too soon');
  }

  try {
    return await db.transaction(async (tx) => {
      const [service] = await tx
        .select()
        .from(services)
        .where(and(eq(services.id, serviceId), eq(services.businessId, business.id)));
      if (!service || !service.active) {
        throw new BookingError('not_found', `No such service: ${serviceId}`);
      }

      const [member] = await tx
        .select()
        .from(staffTable)
        .where(and(eq(staffTable.id, staffId), eq(staffTable.businessId, business.id)));
      if (!member || !member.active) {
        throw new BookingError('not_found', `No such staff member: ${staffId}`);
      }
      if (staffForService([member], serviceId).length === 0) {
        throw new BookingError(
          'staff_cannot_perform_service',
          `${member.name} does not perform this service`,
        );
      }

      assertWithinWorkingHours(startsAt, service, member, business);

      const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);

      const [created] = await tx
        .insert(appointments)
        .values({
          businessId: business.id,
          serviceId: service.id,
          staffId: member.id,
          customerName: customerName.trim(),
          customerPhone: customerPhone.trim(),
          startsAt,
          endsAt,
          status: 'booked',
          channel,
          notes: input.notes ?? null,
        })
        .returning();

      if (!created) throw new BookingError('invalid_input', 'The booking was not written');
      return created;
    });
  } catch (error) {
    // The index fired: someone else won the slot in between.
    if (isUniqueSlotViolation(error)) {
      throw new BookingError('slot_taken', 'That time was just taken by someone else', {
        staffId,
        startsAt: startsAt.toISOString(),
      });
    }
    throw error;
  }
}

export interface CancelInput {
  business: Business;
  appointmentId?: string | undefined;
  /** Used both to find the appointment and to prove the caller owns it. */
  customerPhone: string;
  now?: Date;
}

export async function cancelAppointment(db: Database, input: CancelInput): Promise<Appointment> {
  const { business, appointmentId, customerPhone, now = new Date() } = input;

  if (!customerPhone.trim()) {
    throw new BookingError('invalid_input', 'A cancellation needs the caller’s number');
  }

  return db.transaction(async (tx) => {
    const target = appointmentId
      ? (
          await tx
            .select()
            .from(appointments)
            .where(
              and(eq(appointments.id, appointmentId), eq(appointments.businessId, business.id)),
            )
        )[0]
      : (
          /**
           * Matching on the stored string would fail the moment a caller ID
           * reads "070 111 222" and the booking was taken as "+389 70 111 222"
           * — the same person, unable to cancel. SQLite cannot normalise in
           * SQL, so the upcoming rows (bounded, and small for a clinic) are
           * narrowed by the index and compared digit-wise here.
           */
          await tx
            .select()
            .from(appointments)
            .where(
              and(
                eq(appointments.businessId, business.id),
                eq(appointments.status, 'booked'),
                gte(appointments.startsAt, now),
              ),
            )
            .orderBy(appointments.startsAt)
        ).find((row) => normalisePhone(row.customerPhone) === normalisePhone(customerPhone));

    if (!target) {
      throw new BookingError('not_found', 'No upcoming appointment found for that number');
    }
    if (target.status === 'cancelled') {
      throw new BookingError('already_cancelled', 'That appointment is already cancelled');
    }
    // An appointment id alone must not be enough to cancel someone else's slot.
    if (normalisePhone(target.customerPhone) !== normalisePhone(customerPhone)) {
      throw new BookingError('contact_mismatch', 'That appointment is under a different number');
    }

    const [updated] = await tx
      .update(appointments)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(appointments.id, target.id))
      .returning();

    if (!updated) throw new BookingError('not_found', 'The appointment vanished mid-cancellation');
    return updated;
  });
}

export interface RescheduleInput {
  business: Business;
  /**
   * Optional, because a phone caller does not know it.
   *
   * This used to be required, which made rescheduling unreachable on a real
   * call: the only way to learn an appointment id is to have booked through
   * an interface that showed you one, and a caller has not. The model was
   * left either refusing or inventing an id for the database to reject.
   * Omit it and the caller's number resolves their next appointment, exactly
   * as `cancelAppointment` has always done.
   */
  appointmentId?: string | undefined;
  newStartsAt: Date;
  /** Ownership check, and the lookup key when there is no id. */
  customerPhone?: string | undefined;
  /** Move to a different staff member as part of the reschedule. */
  newStaffId?: string | undefined;
  now?: Date;
  minimumNoticeMinutes?: number;
}

export async function rescheduleAppointment(
  db: Database,
  input: RescheduleInput,
): Promise<Appointment> {
  const {
    business,
    newStartsAt,
    now = new Date(),
    minimumNoticeMinutes = DEFAULT_MINIMUM_NOTICE_MINUTES,
  } = input;

  if (Number.isNaN(newStartsAt.getTime())) {
    throw new BookingError('invalid_input', 'Unparseable new start time');
  }
  if (newStartsAt.getTime() < now.getTime() + minimumNoticeMinutes * 60_000) {
    throw new BookingError('in_the_past', 'That time has already passed or is too soon');
  }

  /**
   * Resolve "my appointment" from the caller's number when no id was given.
   *
   * Done before the transaction rather than inside it: the update below
   * re-checks status and ownership anyway, so a row that changes in between
   * is caught there rather than silently rescheduled.
   */
  let appointmentId = input.appointmentId;
  if (!appointmentId) {
    if (!input.customerPhone?.trim()) {
      throw new BookingError('invalid_input', 'A reschedule needs an id or the caller’s number');
    }
    const upcoming = await findUpcomingByPhone(db, business.id, input.customerPhone, now);
    const next = upcoming[0];
    if (!next) {
      throw new BookingError('not_found', 'No upcoming appointment found for that number');
    }
    appointmentId = next.id;
  }

  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(appointments)
        .where(and(eq(appointments.id, appointmentId), eq(appointments.businessId, business.id)));

      if (!existing) throw new BookingError('not_found', 'No such appointment');
      if (existing.status === 'cancelled') {
        throw new BookingError('already_cancelled', 'That appointment is cancelled');
      }
      if (
        input.customerPhone &&
        normalisePhone(existing.customerPhone) !== normalisePhone(input.customerPhone)
      ) {
        throw new BookingError('contact_mismatch', 'That appointment is under a different number');
      }

      const [service] = await tx
        .select()
        .from(services)
        .where(eq(services.id, existing.serviceId));
      if (!service) throw new BookingError('not_found', 'The service no longer exists');

      const staffId = input.newStaffId ?? existing.staffId;
      const [member] = await tx
        .select()
        .from(staffTable)
        .where(and(eq(staffTable.id, staffId), eq(staffTable.businessId, business.id)));
      if (!member || !member.active) throw new BookingError('not_found', 'No such staff member');
      if (staffForService([member], service.id).length === 0) {
        throw new BookingError(
          'staff_cannot_perform_service',
          `${member.name} does not perform this service`,
        );
      }

      assertWithinWorkingHours(newStartsAt, service, member, business);

      const [updated] = await tx
        .update(appointments)
        .set({
          staffId,
          startsAt: newStartsAt,
          endsAt: new Date(newStartsAt.getTime() + service.durationMinutes * 60_000),
          updatedAt: new Date(),
        })
        .where(eq(appointments.id, appointmentId))
        .returning();

      if (!updated) throw new BookingError('not_found', 'The appointment vanished mid-reschedule');
      return updated;
    });
  } catch (error) {
    if (isUniqueSlotViolation(error)) {
      throw new BookingError('slot_taken', 'That time was just taken by someone else', {
        startsAt: newStartsAt.toISOString(),
      });
    }
    throw error;
  }
}

/** Upcoming, still-live appointments for a caller — used to find "my booking". */
export async function findUpcomingByPhone(
  db: Database,
  businessId: string,
  customerPhone: string,
  now = new Date(),
): Promise<Appointment[]> {
  const rows = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.businessId, businessId), gte(appointments.startsAt, now)))
    .orderBy(desc(appointments.startsAt));

  // Digit-wise comparison, same reasoning as cancelAppointment.
  const wanted = normalisePhone(customerPhone);
  return rows
    .filter((r) => BLOCKING_STATUSES.includes(r.status) && normalisePhone(r.customerPhone) === wanted)
    .reverse();
}

/**
 * Defence in depth. The agent can only offer slots that came from
 * findFreeSlots, which already respects working hours — but a tool input is
 * model-generated text, and "book me at 3am" must fail loudly rather than
 * quietly create an appointment nobody will keep.
 */
function assertWithinWorkingHours(
  startsAt: Date,
  service: Service,
  member: StaffMember,
  business: Business,
): void {
  const timeZone = business.timezone;
  const hours: WorkingHours = member.workingHours ?? business.workingHours;
  const dayKey = dayKeyForLocalDate(toLocalDateString(startsAt, timeZone));
  const parts = toZonedParts(startsAt, timeZone);

  const startMinutes = parts.hour * 60 + parts.minute;
  const endMinutes = startMinutes + service.durationMinutes;

  const fits = hours[dayKey].some(
    (interval) => startMinutes >= toMinutes(interval.start) && endMinutes <= toMinutes(interval.end),
  );

  if (!fits) {
    throw new BookingError(
      'outside_working_hours',
      `${member.name} is not available then`,
      { dayKey, startMinutes, endMinutes },
    );
  }
}

/** Balkan numbers arrive as +389 70 …, 070 …, 0038970…. Compare digits only. */
function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.replace(/^(00389|389|0)/, '');
}
