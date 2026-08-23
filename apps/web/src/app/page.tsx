const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

interface HealthResponse {
  status: string;
  version: string;
  uptimeSeconds: number;
  checks: { database: { status: string; latencyMs: number } };
}

/**
 * Phase 1 placeholder. Its only job is to prove the dashboard can reach the
 * API across the Vercel/Render boundary — the real Today view lands in Phase 4.
 */
async function fetchHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${API_URL}/health`, { cache: 'no-store' });
    if (!res.ok && res.status !== 503) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

export default async function Home() {
  const health = await fetchHealth();
  const online = health?.status === 'ok';

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <div>
        <p className="text-sm font-medium tracking-widest text-brand-700 uppercase">Frontly</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight text-slate-900">
          AI рецепционер
        </h1>
        <p className="mt-3 text-lg text-slate-600">
          Одговара на повици и пораки на македонски, албански и англиски. Закажува термини.
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-slate-700">Состојба на системот</span>
          <span
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${
              online ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${online ? 'bg-emerald-500' : 'bg-rose-500'}`}
              aria-hidden
            />
            {online ? 'Активен' : 'Недостапен'}
          </span>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <dt className="text-slate-500">API</dt>
          <dd className="text-right font-mono text-slate-900">{health?.version ?? '—'}</dd>
          <dt className="text-slate-500">База на податоци</dt>
          <dd className="text-right font-mono text-slate-900">
            {health ? `${health.checks.database.status} · ${health.checks.database.latencyMs}ms` : '—'}
          </dd>
        </dl>

        {!health && (
          <p className="mt-4 text-sm text-slate-500">
            API не одговара на <span className="font-mono">{API_URL}</span>. Стартувај го со{' '}
            <span className="font-mono">pnpm dev:api</span>.
          </p>
        )}
      </div>

      <p className="text-sm text-slate-500">
        Фаза 1 · основа. Таблата за преглед доаѓа во Фаза 4.
      </p>
    </main>
  );
}
