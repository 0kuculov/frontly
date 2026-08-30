import Link from 'next/link';
import {
  apiGet,
  type CalendarService,
  type CalendarStaff,
  type DashboardAppointment,
} from '../../../lib/api';
import {
  appointmentWord,
  DAY_KEYS,
  dayLabel,
  formatTime,
  LOCALES,
  translator,
} from '../../../lib/i18n';
import { getLang, type Lang } from '../../../lib/session';
import { AutoRefresh } from '../auto-refresh';
import { BookingForm } from '../booking-form';
import { CancelButton } from '../cancel-button';

export const dynamic = 'force-dynamic';

interface CalendarResponse {
  business: { timezone: string; workingHours: Record<string, { start: string; end: string }[]> };
  appointments: DashboardAppointment[];
  services: CalendarService[];
  staff: CalendarStaff[];
}

/**
 * The week, and the one place a person can put somebody on it.
 *
 * Still not draggable, and the reason has not changed: moving an appointment
 * means re-running availability, staff competence and the double-booking
 * guard, and getting any of that subtly wrong is worse than not having it.
 * Adding and cancelling need none of that — the API asks the same
 * `findFreeSlots` the phone asks, and `bookAppointment` applies the same three
 * checks — so those two are here and moving is not. Reschedule is a cancel
 * plus a booking, in the open, where both halves are visible.
 *
 * Closed days are drawn, not hidden. An empty Sunday next to an empty Tuesday
 * would look identical otherwise, and one of those is a problem.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const lang = await getLang();
  const t = translator(lang);
  const { week } = await searchParams;

  const offset = Number(week) || 0;
  const monday = mondayOf(new Date(), offset);
  const sunday = new Date(monday.getTime() + 7 * 86_400_000 - 1);

  const data = await apiGet<CalendarResponse>(
    `/dashboard/calendar?from=${monday.toISOString()}&to=${sunday.toISOString()}`,
  );
  const tz = data.business.timezone;

  const days = DAY_KEYS.map((key, index) => {
    const date = new Date(monday.getTime() + index * 86_400_000);
    return {
      key,
      date,
      hours: data.business.workingHours?.[key] ?? [],
      appointments: data.appointments.filter(
        (a) => localDateKey(a.startsAt, tz) === localDateKey(date.toISOString(), tz),
      ),
    };
  });

  const todayKey = localDateKey(new Date().toISOString(), tz);

  return (
    <>
      <AutoRefresh />
      <div className="page-head">
        <div>
          <h1>{t('calendar')}</h1>
          <p className="page-sub">
            {rangeLabel(monday, sunday, tz, lang)} · {data.appointments.length}{' '}
            {appointmentWord(data.appointments.length, lang)}
          </p>
        </div>
        <div className="head-actions">
          <BookingForm
            services={data.services}
            staff={data.staff}
            timezone={tz}
            lang={lang}
            /*
             * The day the calendar is already showing, so the form opens on the
             * week in front of the owner rather than on today. Monday when the
             * week is a future one; today when it is this one.
             */
            defaultDate={localDateKey(
              (offset === 0 ? new Date() : monday).toISOString(),
              tz,
            )}
          />
          <Link className="btn btn-quiet" href={`/dashboard/calendar?week=${offset - 1}`}>
            ← {t('previous')}
          </Link>
          <Link className="btn btn-quiet" href="/dashboard/calendar">
            {t('thisWeek')}
          </Link>
          <Link className="btn btn-quiet" href={`/dashboard/calendar?week=${offset + 1}`}>
            {t('next')} →
          </Link>
        </div>
      </div>

      <div className="scroll-x">
        <div className="week">
          {days.map((day) => (
            <div
              className="day-col"
              key={day.key}
              data-today={localDateKey(day.date.toISOString(), tz) === todayKey}
            >
              <div className="day-head">
                <span className="day-name">{dayLabel(day.key, lang)}</span>
                <span className="day-num">{dayNumber(day.date, tz)}</span>
              </div>

              <span className="day-hours">
                {day.hours.length === 0
                  ? t('closed')
                  : day.hours.map((h) => `${h.start}–${h.end}`).join(', ')}
              </span>

              {day.appointments.map((a) => (
                <div className="chip" key={a.id} data-status={a.status}>
                  <span className="chip-time">{formatTime(a.startsAt, tz)}</span>
                  <span className="chip-name">{a.customerName}</span>
                  <span className="chip-service">{a.serviceName}</span>
                  {a.status === 'booked' ? (
                    <CancelButton appointmentId={a.id} lang={lang} label={a.customerName} />
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** Monday of the week containing today, plus a week offset. */
function mondayOf(from: Date, weeksAhead: number): Date {
  const date = new Date(from);
  date.setHours(0, 0, 0, 0);
  // getDay(): Sunday is 0, so Sunday belongs to the week that started six days ago.
  const shift = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - shift + weeksAhead * 7);
  return date;
}

/** "YYYY-MM-DD" in the clinic's timezone, so day bucketing matches the phone. */
function localDateKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function dayNumber(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric' }).format(date);
}

function rangeLabel(from: Date, to: Date, timeZone: string, lang: Lang): string {
  const fmt = new Intl.DateTimeFormat(LOCALES[lang], {
    timeZone,
    day: 'numeric',
    month: 'short',
  });
  return `${fmt.format(from)} – ${fmt.format(to)}`;
}
