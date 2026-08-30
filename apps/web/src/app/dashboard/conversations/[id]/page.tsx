import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  apiGet,
  type DashboardConversation,
  type SettingsResponse,
  type TranscriptTurn,
} from '../../../../lib/api';
import { formatDuration, formatTime, outcomeLabel, translator } from '../../../../lib/i18n';
import { getLang } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

type Detail = DashboardConversation & { transcript: unknown };

/**
 * One call, read back.
 *
 * Tool calls are shown inline with the turn that made them, because that is
 * the moment the product stops looking like a chatbot — the same reason the
 * stage screen gives them their own card. Everything else is a transcript.
 */
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const lang = await getLang();
  const t = translator(lang);

  let detail: Detail;
  try {
    detail = await apiGet<Detail>(`/dashboard/conversations/${encodeURIComponent(id)}`);
  } catch {
    // A 404 here means the call belongs to another clinic, or never existed.
    // Both are "not found" from this login's point of view, on purpose.
    notFound();
  }

  const settings = await apiGet<SettingsResponse>('/dashboard/settings');
  const tz = settings.business.timezone;
  const turns: TranscriptTurn[] = Array.isArray(detail.transcript)
    ? (detail.transcript as TranscriptTurn[])
    : [];

  return (
    <>
      <div className="page-head">
        <div>
          <Link className="linkish" href="/conversations">
            ← {t('back')}
          </Link>
          <h1 style={{ marginTop: '0.5rem' }}>{detail.fromIdentifier ?? detail.externalId}</h1>
          <p className="page-sub">
            {new Intl.DateTimeFormat(lang === 'mk' ? 'mk-MK' : 'en-GB', {
              timeZone: tz,
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            }).format(new Date(detail.startedAt))}{' '}
            · {formatTime(detail.startedAt, tz)}
          </p>
        </div>
        <span className="badge" data-outcome={detail.outcome ?? 'open'}>
          {outcomeLabel(detail.outcome, lang)}
        </span>
      </div>

      <div className="figures">
        <Fig value={formatDuration(detail.durationMs, lang)} label={t('duration')} />
        <Fig
          value={
            detail.avgCallerFacingMs === null
              ? '—'
              : `${(detail.avgCallerFacingMs / 1000).toFixed(1)}s`
          }
          label={t('response')}
        />
        <Fig value={detail.languageDetected ?? '—'} label={t('language')} />
        <Fig value={String(turns.length)} label={t('turns')} />
      </div>

      <h2>{t('transcript')}</h2>
      <div className="panel pad">
        {turns.length === 0 ? (
          <div className="empty">—</div>
        ) : (
          <div className="turns">
            {turns.map((turn, index) => (
              <div className="turn" key={index} data-role={turn.role}>
                <span className="turn-role">
                  {turn.role === 'agent' ? t('agent') : turn.role === 'customer' ? t('customer') : turn.role}
                </span>
                <div>
                  <p className="turn-text">{turn.text}</p>
                  {(turn.toolCalls ?? []).map((call, i) => (
                    <span className="turn-tool" key={i}>
                      {call.name}
                      {typeof call.durationMs === 'number' ? ` · ${call.durationMs}ms` : ''}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Fig({ value, label }: { value: string; label: string }) {
  return (
    <div className="figure">
      <div className="figure-value">{value}</div>
      <div className="figure-label">{label}</div>
    </div>
  );
}
