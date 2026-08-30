import Link from 'next/link';
import { apiGet, type DashboardConversation, type SettingsResponse } from '../../../lib/api';
import { formatDuration, formatTime, outcomeLabel, translator } from '../../../lib/i18n';
import { getLang } from '../../../lib/session';
import { AutoRefresh } from '../auto-refresh';

export const dynamic = 'force-dynamic';

/**
 * Every call, newest first.
 *
 * The columns are the questions actually asked about a call: who, when, how
 * long, how did it end, and how fast did the agent answer. `Одговор` is the
 * caller-facing latency — measured from the caller stopping speaking to the
 * first audio back, which is the wait a person actually sits through, not the
 * flattering per-turn number that starts counting after Azure has finalized.
 */
export default async function ConversationsPage() {
  const lang = await getLang();
  const t = translator(lang);

  const [{ conversations }, settings] = await Promise.all([
    apiGet<{ conversations: DashboardConversation[] }>('/dashboard/conversations?limit=100'),
    apiGet<SettingsResponse>('/dashboard/settings'),
  ]);
  const tz = settings.business.timezone;

  return (
    <>
      <AutoRefresh />
      <div className="page-head">
        <div>
          <h1>{t('allConversations')}</h1>
          <p className="page-sub">
            {conversations.length} {lang === 'mk' ? 'вкупно' : 'total'}
          </p>
        </div>
      </div>

      {conversations.length === 0 ? (
        <div className="panel empty">{t('noConversations')}</div>
      ) : (
        <div className="panel scroll-x">
          <table>
            <thead>
              <tr>
                <th>{t('when')}</th>
                <th>{t('caller')}</th>
                <th>{t('outcome')}</th>
                <th>{t('language')}</th>
                <th>{t('duration')}</th>
                <th>{t('response')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {conversations.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{when(c.startedAt, tz, lang)}</td>
                  <td>
                    <Link className="row-link" href={`/conversations/${c.id}`}>
                      {c.fromIdentifier ?? c.externalId}
                    </Link>
                  </td>
                  <td>
                    <span className="badge" data-outcome={c.outcome ?? 'open'}>
                      {outcomeLabel(c.outcome, lang)}
                    </span>
                  </td>
                  <td className="mono muted">{c.languageDetected ?? '—'}</td>
                  <td className="mono muted">{formatDuration(c.durationMs, lang)}</td>
                  <td className="mono muted">
                    {/* Null, never 0. A zero here would read as "instant". */}
                    {c.avgCallerFacingMs === null
                      ? '—'
                      : `${(c.avgCallerFacingMs / 1000).toFixed(1)}s`}
                  </td>
                  <td className="muted mono">
                    {c.turnCount} {t('turns')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function when(iso: string, timeZone: string, lang: 'mk' | 'en'): string {
  const date = new Intl.DateTimeFormat(lang === 'mk' ? 'mk-MK' : 'en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
  }).format(new Date(iso));
  return `${date} ${formatTime(iso, timeZone)}`;
}
