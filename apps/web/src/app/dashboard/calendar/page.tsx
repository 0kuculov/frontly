import Link from 'next/link';
import { apiGet, type DashboardAppointment } from '../../../lib/api';
import { DAY_KEYS, dayLabel, formatTime, translator } from '../../../lib/i18n';
import { getLang } from '../../../lib/session';
import { AutoRefresh } from '../auto-refresh';

export const dynamic = 'force-dynamic';

interface CalendarResponse {
  business: { timezone: string; workingHours: Record<string, { start: string; end: string }[]> };
  appointments: DashboardAppointment[];
}

/**
 * The week, read-only.
 *
 * Deliberately not draggable. Dragging an appointment to a new slot means
 * re-running availability, staff competence and the double-booking guard, and
 * getting any of that subtly wrong on stage is worse than not having the
 * feature — the phone is the product, and this view exists to prove the
 * bookings are real, not to become a scheduling app.
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
            {lang === 'mk' ? 'термини' : 'appointments'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Link className="btn btn-quiet" href={`/calendar?week=${offset - 1}`}>
            ← {t('previous')}
          </Link>
          <Link className="btn btn-quiet" href="/calendar">
            {t('thisWeek')}
          </Link>
          <Link className="btn btn-quiet" href={`/calendar?week=${offset + 1}`}>
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
                <div className="chip" key={a.id}>
                  <span className="chip-time">{formatTime(a.startsAt, tz)}</span>
                  <span className="chip-name">{a.customerName}</span>
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

function rangeLabel(from: Date, to: Date, timeZone: string, lang: 'mk' | 'en'): string {
  const fmt = new Intl.DateTimeFormat(lang === 'mk' ? 'mk-MK' : 'en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
  });
  return `${fmt.format(from)} – ${fmt.format(to)}`;
}
