import {
  appointmentsBetween,
  authenticate,
  bookAppointment,
  BookingError,
  cancelAppointment,
  conversationsBetween,
  findFreeSlots,
  getAppointmentById,
  getBusinessContext,
  getConversationDetail,
  listConversations,
  recordLogin,
  staffForService,
  startOfZonedDay,
  toZonedParts,
  type Database,
} from '@frontly/core';
import { workingHoursSchema, type ServerEnv } from '@frontly/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { bearerToken, issueSession, readSession, type SessionClaims } from '../auth/session.js';

/**
 * What the owner dashboard reads and writes.
 *
 * The dashboard is a CLIENT of this API, not a second copy of it — every read
 * goes over HTTP so the Vercel deployment and this one can never disagree
 * about the data, and the database credentials stay on one machine. That
 * decision predates this file (see apps/web/next.config.ts) and is the reason
 * these routes exist at all rather than Next querying Turso directly.
 *
 * Auth is a bearer token, not a cookie: the two live on different origins, and
 * a cross-site cookie needs `SameSite=None; Secure` plus credentialed CORS on
 * every request. The dashboard's own server holds this token and sends it in a
 * header, so the browser never sees it.
 */

export interface DashboardRouteOptions {
  db: Database;
  env: ServerEnv;
}

/** Everything a screen needs about who is asking. */
interface Session extends SessionClaims {}

export async function registerDashboardRoutes(
  app: FastifyInstance,
  options: DashboardRouteOptions,
): Promise<void> {
  const { db, env } = options;

  /**
   * Without a secret there is nothing to sign with, and an unsigned session is
   * worse than none. The dashboard simply does not mount rather than serving
   * a login that cannot be trusted.
   */
  const secret = env.AUTH_SECRET;
  if (!secret) {
    app.log.warn(
      'AUTH_SECRET is not set — the dashboard API is disabled. Generate one: node -e "console.log(crypto.randomBytes(32).toString(\'hex\'))"',
    );
    return;
  }

  /** Resolve the caller, or answer 401 and stop the handler. */
  async function requireSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Session | undefined> {
    const claims = readSession(
      bearerToken(request.headers as Record<string, unknown>),
      secret!,
    );
    if (!claims) {
      await reply.code(401).send({ error: 'unauthorized' });
      return undefined;
    }
    return claims;
  }

  app.post('/dashboard/login', async (request, reply) => {
    const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      return reply.code(400).send({ error: 'email_and_password_required' });
    }

    const user = await authenticate(db, email, password);
    if (!user) {
      /**
       * One message for "no such account" and for "wrong password", and
       * `authenticate` burns the same scrypt work either way. Distinguishing
       * them would turn this form into a way to find out who has an account.
       */
      app.log.warn({ email }, 'dashboard login rejected');
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    await recordLogin(db, user.id, new Date());
    const token = issueSession({ userId: user.id, businessId: user.businessId }, secret!);
    const context = await getBusinessContext(db, user.businessId);

    app.log.info({ userId: user.id, businessId: user.businessId }, 'dashboard login');
    return {
      token,
      user: { id: user.id, email: user.email, name: user.name },
      business: context
        ? {
            id: context.business.id,
            name: context.business.name,
            timezone: context.business.timezone,
            languages: context.business.languages,
          }
        : undefined,
    };
  });

  /**
   * Today, in the clinic's own timezone.
   *
   * The day boundary is computed against `business.timezone`, never the
   * server's — Render runs in UTC and Skopje is an hour or two ahead, so a
   * server-local "today" would roll over while the clinic is still working.
   */
  app.get('/dashboard/today', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const context = await getBusinessContext(db, session.businessId);
    if (!context) return reply.code(404).send({ error: 'business_not_found' });

    const tz = context.business.timezone;
    const now = new Date();
    const parts = toZonedParts(now, tz);
    const dayStart = startOfZonedDay(tz, parts.year, parts.month, parts.day);
    // 26 hours forward then back to midnight: adding 86,400,000ms lands an
    // hour out on the two days a year the offset changes.
    const t = toZonedParts(new Date(dayStart.getTime() + 26 * 3_600_000), tz);
    const dayEnd = new Date(startOfZonedDay(tz, t.year, t.month, t.day).getTime() - 1);

    const [appointments, conversations] = await Promise.all([
      appointmentsBetween(db, session.businessId, dayStart, dayEnd),
      conversationsBetween(db, session.businessId, dayStart, dayEnd),
    ]);

    /**
     * What today's calls actually booked, even when it was not for today.
     *
     * The day rail draws appointments STARTING today, so a caller who books
     * next Tuesday moves a counter and nothing else — on stage, the judge
     * books a slot and the screen appears not to react. These are the
     * appointments today's conversations created, looked up by the id the
     * conversation already carries, so the call row can say when.
     *
     * One query per booked call. A clinic has a handful of those a day; a
     * join here would be cheaper and much harder to read.
     */
    const booked = await Promise.all(
      conversations
        .map((c) => c.appointmentId)
        .filter((id): id is string => Boolean(id))
        .map((id) => getAppointmentById(db, session.businessId, id)),
    );

    return {
      business: { name: context.business.name, timezone: tz },
      day: { startsAt: dayStart.toISOString(), endsAt: dayEnd.toISOString() },
      appointments,
      conversations,
      bookedByCalls: booked
        .filter((a) => a !== undefined)
        .map((a) => ({ id: a.id, startsAt: a.startsAt.toISOString(), status: a.status })),
      counts: {
        appointments: appointments.filter((a) => a.status === 'booked').length,
        conversations: conversations.length,
        booked: conversations.filter((c) => c.outcome === 'booked').length,
        transferred: conversations.filter((c) => c.outcome === 'transferred').length,
      },
    };
  });

  app.get('/dashboard/conversations', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Math.max(Number(query.offset) || 0, 0);

    return { conversations: await listConversations(db, session.businessId, { limit, offset }) };
  });

  app.get('/dashboard/conversations/:id', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const { id } = request.params as { id: string };
    const detail = await getConversationDetail(db, session.businessId, id);
    if (!detail) return reply.code(404).send({ error: 'not_found' });
    return detail;
  });

  /** A date range, for the week view. Writes live in the two routes below. */
  app.get('/dashboard/calendar', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const context = await getBusinessContext(db, session.businessId);
    if (!context) return reply.code(404).send({ error: 'business_not_found' });

    const query = request.query as { from?: string; to?: string };
    const from = query.from ? new Date(query.from) : new Date();
    const to = query.to ? new Date(query.to) : new Date(from.getTime() + 7 * 86_400_000);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return reply.code(400).send({ error: 'bad_range' });
    }

    return {
      business: { timezone: context.business.timezone, workingHours: context.business.workingHours },
      appointments: await appointmentsBetween(db, session.businessId, from, to),
      /**
       * The booking form's vocabulary, returned with the week rather than
       * fetched separately: a form that needs two round trips before it can
       * render its first dropdown is a form that flashes empty.
       */
      services: context.services
        .filter((s) => s.active)
        .map((s) => ({ id: s.id, name: s.nameMk, durationMinutes: s.durationMinutes })),
      staff: context.staff
        .filter((m) => m.active)
        .map((m) => ({ id: m.id, name: m.name, serviceIds: m.serviceIds })),
    };
  });

  /**
   * The times the owner may actually offer, from the same function the phone
   * agent uses.
   *
   * The booking form does not let anyone type a time. It offers what
   * `findFreeSlots` returns and nothing else - the identical rule the engine
   * lives under ("the engine may only offer times check_availability
   * returned"), for the identical reason: working hours, staff competence and
   * existing appointments are three separate constraints, and a form that
   * guesses gets one of them wrong and books over a patient.
   */
  app.get('/dashboard/availability', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const context = await getBusinessContext(db, session.businessId);
    if (!context) return reply.code(404).send({ error: 'business_not_found' });

    const query = request.query as { serviceId?: string; staffId?: string; date?: string };
    const service = context.services.find((s) => s.id === query.serviceId && s.active);
    if (!service) return reply.code(400).send({ error: 'unknown_service' });

    const date = query.date ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply.code(400).send({ error: 'bad_date' });
    }

    const slots = await findFreeSlots(db, {
      business: context.business,
      service,
      staff: staffForService(context.staff, service.id),
      from: date,
      to: date,
      ...(query.staffId ? { staffId: query.staffId } : {}),
      /**
       * A single day returns EVERY free time, so the whole day is on screen.
       * The cap exists for the phone, where a caller can only hold a few in
       * their head; a person reading a list has no such limit.
       */
      limit: 200,
    });

    return {
      date,
      slots: slots.map((slot) => ({
        staffId: slot.staffId,
        staffName: slot.staffName,
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
      })),
    };
  });

  /**
   * Book somebody in by hand.
   *
   * Goes through `bookAppointment`, the same function the phone and the chat
   * widget call, so a walk-in gets the double-booking guard, the working-hours
   * check and the staff-competence check without a second implementation of
   * any of them. `channel: 'manual'` is what tells the history apart later -
   * it has been a valid booking source since Phase 1 and was waiting for this.
   */
  app.post('/dashboard/appointments', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const context = await getBusinessContext(db, session.businessId);
    if (!context) return reply.code(404).send({ error: 'business_not_found' });

    const body = (request.body ?? {}) as Record<string, unknown>;
    const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string).trim() : '');

    const serviceId = str('serviceId');
    const staffId = str('staffId');
    const startsAt = new Date(str('startsAt'));
    const customerName = str('customerName');
    const customerPhone = str('customerPhone');
    const notes = str('notes');

    if (!serviceId || !staffId || !customerName || !customerPhone) {
      return reply.code(400).send({ error: 'missing_fields' });
    }
    if (Number.isNaN(startsAt.getTime())) {
      return reply.code(400).send({ error: 'bad_start_time' });
    }

    try {
      const appointment = await bookAppointment(db, {
        business: context.business,
        serviceId,
        staffId,
        startsAt,
        customerName,
        customerPhone,
        channel: 'manual',
        ...(notes ? { notes } : {}),
        /**
         * No minimum notice from the dashboard. The hour of notice exists so a
         * caller cannot book a slot the clinic has no time to prepare for; the
         * owner standing at the desk with the patient in front of them is the
         * person that rule was protecting, and they can see the clock.
         */
        minimumNoticeMinutes: 0,
      });

      app.log.info(
        { businessId: session.businessId, appointmentId: appointment.id },
        'appointment booked from the dashboard',
      );
      return reply.code(201).send({ appointment });
    } catch (error) {
      return bookingFailure(reply, error);
    }
  });

  /**
   * Take somebody off the calendar.
   *
   * Cancels rather than deletes: the partial unique index that prevents
   * double-booking is scoped to `status in ('booked','completed')`, so a
   * cancellation frees the slot while the record of it survives. A DELETE
   * would lose the fact that a patient was ever booked, which is the one
   * thing an owner asks about afterwards.
   */
  app.post('/dashboard/appointments/:id/cancel', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const context = await getBusinessContext(db, session.businessId);
    if (!context) return reply.code(404).send({ error: 'business_not_found' });

    const { id } = request.params as { id: string };
    const existing = await getAppointmentById(db, session.businessId, id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    try {
      /**
       * `cancelAppointment` proves ownership with the caller's phone number,
       * because on the phone that is the only proof there is. Here the proof
       * is the session: the row was just fetched WHERE businessId = the
       * session's, which is the tenancy boundary. Passing the appointment's
       * own number satisfies a guard that is answering a different question.
       */
      const appointment = await cancelAppointment(db, {
        business: context.business,
        appointmentId: existing.id,
        customerPhone: existing.customerPhone,
      });

      app.log.info(
        { businessId: session.businessId, appointmentId: id },
        'appointment cancelled from the dashboard',
      );
      return { appointment };
    } catch (error) {
      return bookingFailure(reply, error);
    }
  });

  app.get('/dashboard/settings', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const context = await getBusinessContext(db, session.businessId);
    if (!context) return reply.code(404).send({ error: 'business_not_found' });

    const { business, services, staff } = context;
    return {
      business: {
        id: business.id,
        name: business.name,
        timezone: business.timezone,
        languages: business.languages,
        greetingTemplate: business.greetingTemplate,
        ownerMobile: business.ownerMobile,
        workingHours: business.workingHours,
        inboundNumber: business.inboundNumber,
      },
      services: services.map((s) => ({
        id: s.id,
        nameMk: s.nameMk,
        durationMinutes: s.durationMinutes,
        price: s.price,
        currency: s.currency,
        active: s.active,
      })),
      staff: staff.map((m) => ({
        id: m.id,
        name: m.name,
        active: m.active,
        serviceIds: m.serviceIds,
      })),
    };
  });

  /**
   * The settings the owner can actually change from the dashboard.
   *
   * Deliberately a short list. `inboundNumber` is not on it — that is the
   * carrier's truth, not the owner's, and a typo there silently unroutes every
   * inbound call. Services and staff are read-only in Phase 4 for the same
   * reason the calendar is: editing them means availability maths, and the
   * thin version proves the product without it.
   */
  app.patch('/dashboard/settings', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};

    if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim();
    if (typeof body.greetingTemplate === 'string' && body.greetingTemplate.trim()) {
      updates.greetingTemplate = body.greetingTemplate.trim();
    }
    if (typeof body.ownerMobile === 'string') {
      // Empty string clears it, which is a real thing an owner may want:
      // with no route, a transfer says so politely instead of dialling.
      updates.ownerMobile = body.ownerMobile.trim() || null;
    }
    if (Array.isArray(body.languages)) {
      const langs = body.languages.filter(
        (l): l is string => l === 'mk' || l === 'sq' || l === 'en',
      );
      if (langs.length > 0) updates.languages = langs;
    }
    if (body.workingHours !== undefined) {
      const parsed = workingHoursSchema.safeParse(body.workingHours);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'bad_working_hours', detail: parsed.error.message });
      }
      updates.workingHours = parsed.data;
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: 'nothing_to_update' });
    }

    const { businesses } = await import('@frontly/core');
    await db
      .update(businesses)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(businesses.id, session.businessId));

    app.log.info(
      { businessId: session.businessId, fields: Object.keys(updates) },
      'dashboard settings updated',
    );
    return { ok: true, updated: Object.keys(updates) };
  });
}

/**
 * Turn a booking failure into a status the form can act on.
 *
 * The codes exist because each one is a different thing to tell a person, and
 * that was true of a caller before it was true of a form. `slot_taken` is 409
 * rather than 400 on purpose: nothing about the request was wrong, somebody
 * else simply got there first, and the fix is to pick another time rather than
 * to correct a field.
 */
function bookingFailure(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof BookingError)) throw error;
  const status = error.code === 'slot_taken' ? 409 : error.code === 'not_found' ? 404 : 400;
  return reply.code(status).send({ error: error.code, message: error.message });
}
