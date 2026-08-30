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

  /**
   * Two fields the API may not be sending yet.
   *
   * Vercel and Render deploy on separate pipelines, so there is always a window
   * where this page is newer than the API answering it — the same shape as the
   * documented "a failed deploy leaves the OLD build running against the NEW
   * schema", one layer up. Reading `.length` off an absent array white-screens
   * the whole dashboard for that window; defaulting shows a dashboard missing
   * one section, which is the right way round.
   */
  const upcoming = data.upcoming ?? [];
  const bookedByCalls = data.bookedByCalls ?? [];

  /** appointment id -> when it starts, for the call rows. */
  const bookedFor = new Map(
    bookedByCalls.filter((a) => a.status === 'booked').map((a) => [a.id, a.startsAt]),
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

      {/*
        One number leads, three support it.

        This was four equal boxes, which is the default answer to "we have four
        numbers" and encodes no opinion about which one matters. For a
        receptionist product the answer is not ambiguous: calls handled is what
        the product DID today, and the other three are its breakdown. So that
        one is set at four times the size and the rest hang off it, separated
        by rules rather than boxed — the same reasoning that made the day rail
        a rail instead of a list.
      */}
      <div className="figures">
        <div className="figure-lead">
          <span className="figure-lead-value">{data.counts.conversations}</span>
          <span className="figure-lead-label">{t('handledToday')}</span>
        </div>
        <div className="figure-rest">
          <Figure value={data.counts.booked} label={t('bookedToday')} tone="booked" />
          <Figure value={data.counts.appointments} label={t('appointmentsToday')} />
          <Figure value={data.counts.transferred} label={t('forYou')} tone="transferred" />
        </div>
      </div>

      <div className="grid-2">
        {/*
          The rail draws today when there is a today, and what is coming when
          there is not.

          An empty box in the strongest position on the screen taught the owner
          nothing on exactly the days they open this asking "so what IS
          happening?". The fallback uses the same rows, so the one idea this
          dashboard is built around is on screen every day rather than only on
          busy ones. The heading says which of the two they are looking at.
        */}
        <section>
          <h2>{booked.length === 0 && upcoming.length > 0 ? t('comingUp') : t('todaySchedule')}</h2>
          {booked.length > 0 ? (
            <DayRail appointments={booked} timezone={tz} now={now} lang={lang} />
          ) : upcoming.length > 0 ? (
            <DayRail
              appointments={upcoming}
              timezone={tz}
              now={now}
              lang={lang}
              withDates
            />
          ) : (
            <div className="panel empty">{t('noAppointments')}</div>
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

/**
 * A supporting figure.
 *
 * `tone` colours the value, not a chip behind it — booked reads green,
 * transferred reads amber, and the neutral one stays ink. Three words of
 * colour in a quiet layout is enough; three coloured boxes would compete with
 * the lead number they exist to break down.
 */
function Figure({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: 'booked' | 'transferred';
}) {
  // A zero is not a warning. Colouring "0 transferred" amber says something
  // happened when the point is that nothing did.
  return (
    <div className="figure" {...(tone && value > 0 ? { 'data-tone': tone } : {})}>
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
  withDates = false,
}: {
  appointments: DashboardAppointment[];
  timezone: string;
  now: number;
  lang: Lang;
  /** Upcoming rows span several days, so the day has to be on the row. */
  withDates?: boolean;
}) {
  const rows: React.ReactNode[] = [];

  appointments.forEach((appointment, index) => {
    const start = new Date(appointment.startsAt).getTime();
    const previous = index > 0 ? appointments[index - 1] : undefined;

    if (previous && !withDates) {
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
        <span className="slot-time">
          {withDates ? (
            <span className="slot-day">{dayStamp(appointment.startsAt, timezone, lang)}</span>
          ) : null}
          {formatTime(appointment.startsAt, timezone)}
        </span>
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

  return (
    <div className="rail" {...(withDates ? { 'data-dates': 'true' } : {})}>
      {rows}
    </div>
  );
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
/** "чет 3.9" — the day a row belongs to, for a rail spanning several. */
function dayStamp(iso: string, timeZone: string, lang: Lang): string {
  return new Intl.DateTimeFormat(LOCALES[lang], {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'numeric',
  }).format(new Date(iso));
}

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
