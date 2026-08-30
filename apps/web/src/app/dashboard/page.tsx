import Link from 'next/link';
import { apiGet, type DashboardAppointment, type TodayResponse } from '../../lib/api';
import { formatDuration, formatTime, LOCALES, outcomeLabel, translator } from '../../lib/i18n';
import { getLang, type Lang } from '../../lib/session';
import { AutoRefresh } from './auto-refresh';
import { CancelButton } from './cancel-button';

export const dynamic = 'force-dynamic';

/**
 * Today.
 *
 * The one page built around a shape rather than a list. A clinic's day IS a
 * column of time — the appointment book is the object this software replaces —
 * so the day is drawn as a time axis with the patients pinned to it and the
 * gaps between them drawn to scale. The owner is looking for two things when
 * they open this between patients: who is next, and where the holes are. Both
 * are read off the rail without reading a single row.
 */
export default async function TodayPage() {
  const lang = await getLang();
  const t = translator(lang);
  const data = await apiGet<TodayResponse>('/dashboard/today');
  const tz = data.business.timezone;

  const booked = data.appointments.filter((a) => a.status === 'booked');
  const now = Date.now();

  /** appointment id -> when it starts, for the call rows. */
  const bookedFor = new Map(
    data.bookedByCalls.filter((a) => a.status === 'booked').map((a) => [a.id, a.startsAt]),
  );

  return (
    <>
      <AutoRefresh />
      <div className="page-head">
        <div>
          {/*
            The clinic is greeted by name, the way it would be walking in.
            It also answers a question the demo-reset incident proved matters:
            WHICH business is on screen. A dashboard that could be anyone's is
            one wrong environment variable away from being someone else's.
          */}
          <h1>
            {t('welcome')}, {data.business.name}
          </h1>
          <p className="page-sub">{longDate(data.day.startsAt, tz, lang)}</p>
        </div>
      </div>

      <div className="figures">
        <Figure value={data.counts.appointments} label={t('appointmentsToday')} />
        <Figure value={data.counts.conversations} label={t('handledToday')} />
        <Figure value={data.counts.booked} label={t('bookedToday')} />
        <Figure value={data.counts.transferred} label={t('forYou')} />
      </div>

      <div className="grid-2">
        <section>
          <h2>{t('todaySchedule')}</h2>
          {booked.length === 0 ? (
            <div className="panel empty">{t('noAppointments')}</div>
          ) : (
            <DayRail appointments={booked} timezone={tz} now={now} lang={lang} />
          )}
        </section>

        <section>
          <h2>{t('handledToday')}</h2>
          {data.conversations.length === 0 ? (
            <div className="panel empty">{t('nothingYet')}</div>
          ) : (
            <div className="panel">
              <table>
                <thead>
                  <tr>
                    <th>{t('when')}</th>
                    <th>{t('caller')}</th>
                    <th>{t('outcome')}</th>
                    <th>{t('duration')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.conversations.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{formatTime(c.startedAt, tz)}</td>
                      <td>
                        <Link className="row-link" href={`/dashboard/conversations/${c.id}`}>
                          {c.fromIdentifier ?? '—'}
                        </Link>
                      </td>
                      <td>
                        <span className="badge" data-outcome={c.outcome ?? 'open'}>
                          {outcomeLabel(c.outcome, lang)}
                        </span>
                        {/*
                          What the call actually booked, and when.

                          The rail below draws appointments starting TODAY, so
                          a caller who books next Tuesday used to move a counter
                          and change nothing else on screen — on stage, the
                          judge books a slot and the dashboard appears not to
                          have noticed. This is the line that notices.
                        */}
                        {bookedFor.get(c.appointmentId ?? '') ? (
                          <span className="booked-for">
                            {shortWhen(bookedFor.get(c.appointmentId ?? '')!, tz, lang)}
                          </span>
                        ) : null}
                      </td>
                      <td className="mono muted">{formatDuration(c.durationMs, lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function Figure({ value, label }: { value: number; label: string }) {
  return (
    <div className="figure">
      <div className="figure-value">{value}</div>
      <div className="figure-label">{label}</div>
    </div>
  );
}

/**
 * The rail.
 *
 * Gaps are rendered as their own element carrying `--gap-mins`, so the CSS can
 * scale their height with how long they actually are — a three-hour hole looks
 * like a three-hour hole. Clamped, so it cannot push the rest of the day off
 * the screen.
 *
 * The "now" marker is only drawn if the current time falls between two
 * appointments in the list. Pinning it to the top or bottom when the clinic is
 * closed would be a decoration that lies.
 */
function DayRail({
  appointments,
  timezone,
  now,
  lang,
}: {
  appointments: DashboardAppointment[];
  timezone: string;
  now: number;
  lang: Lang;
}) {
  const rows: React.ReactNode[] = [];

  appointments.forEach((appointment, index) => {
    const start = new Date(appointment.startsAt).getTime();
    const previous = index > 0 ? appointments[index - 1] : undefined;

    if (previous) {
      const previousEnd = new Date(previous.endsAt).getTime();
      const gapMinutes = Math.round((start - previousEnd) / 60_000);

      // Only a gap worth noticing. Back-to-back patients need no annotation,
      // and a "0 min gap" label on every row would be noise pretending to be
      // information.
      if (gapMinutes >= 15) {
        rows.push(
          <div
            key={`gap-${appointment.id}`}
            className="gap"
            style={{ '--gap-mins': gapMinutes } as React.CSSProperties}
          >
            <span className="gap-label">{formatGap(gapMinutes, lang)}</span>
          </div>,
        );
      }

      if (now > previousEnd && now < start) {
        rows.push(<NowMarker key={`now-${appointment.id}`} now={now} timezone={timezone} lang={lang} />);
      }
    }

    rows.push(
      <div
        key={appointment.id}
        className="slot"
        data-status={appointment.status}
        data-past={new Date(appointment.endsAt).getTime() < now}
      >
        <span className="slot-time">{formatTime(appointment.startsAt, timezone)}</span>
        <div className="slot-card">
          <span className="slot-name">{appointment.customerName}</span>
          <span className="slot-service">{appointment.serviceName}</span>
          <span className="slot-meta">
            <span>{appointment.staffName}</span>
            <span>
              {appointment.serviceDurationMinutes}
              {MINUTE_UNIT[lang]}
            </span>
          </span>
        </div>
        {/*
          The cancel sits on the row it cancels, not behind a menu. An owner
          rubbing an appointment out is doing it while the patient is on the
          phone saying they cannot come, and a two-step confirm on the row is
          the whole safety this needs.
        */}
        <CancelButton appointmentId={appointment.id} lang={lang} label={appointment.customerName} />
      </div>,
    );
  });

  return <div className="rail">{rows}</div>;
}

function NowMarker({
  now,
  timezone,
  lang,
}: {
  now: number;
  timezone: string;
  lang: Lang;
}) {
  return (
    <div className="now-marker" aria-label={NOW_WORD[lang]}>
      <span className="now-label">{formatTime(new Date(now).toISOString(), timezone)}</span>
    </div>
  );
}

/** Hour and minute abbreviations, which do not come from Intl. */
const HOUR_UNIT: Record<Lang, string> = { mk: 'ч', sq: 'orë', en: 'h' };
const MINUTE_UNIT: Record<Lang, string> = { mk: 'мин', sq: 'min', en: 'min' };

function formatGap(minutes: number, lang: Lang): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}${HOUR_UNIT[lang]}`);
  if (rest > 0) parts.push(`${rest}${MINUTE_UNIT[lang]}`);
  return `${parts.join(' ')} ${GAP_WORD[lang]}`;
}

const GAP_WORD: Record<Lang, string> = { mk: 'пауза', sq: 'pauzë', en: 'gap' };
const NOW_WORD: Record<Lang, string> = { mk: 'сега', sq: 'tani', en: 'now' };

/**
 * "вт 10:00" — enough to recognise the slot, short enough to sit inside a
 * table cell beside a badge. The full date is one click away on the call.
 */
function shortWhen(iso: string, timeZone: string, lang: Lang): string {
  return new Intl.DateTimeFormat(LOCALES[lang], {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function longDate(iso: string, timeZone: string, lang: Lang): string {
  return new Intl.DateTimeFormat(LOCALES[lang], {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(iso));
}
