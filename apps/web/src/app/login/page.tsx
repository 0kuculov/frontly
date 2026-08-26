import { redirect } from 'next/navigation';
import { apiLogin } from '../../lib/api';
import { getLang, getSessionToken, setSessionToken } from '../../lib/session';
import { translator } from '../../lib/i18n';
import './login.css';

export const dynamic = 'force-dynamic';

/**
 * The way in.
 *
 * One card, the clinic's own typography, and nothing else — no marketing, no
 * feature list. The only person who ever sees this screen already knows what
 * the product is.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Already signed in: skip the form rather than making them prove it twice.
  if (await getSessionToken()) redirect('/');

  const lang = await getLang();
  const t = translator(lang);
  const { error } = await searchParams;

  async function signIn(formData: FormData): Promise<void> {
    'use server';

    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');
    const result = await apiLogin(email, password);

    if ('error' in result) {
      /**
       * Two messages, and only two.
       *
       * "Wrong password" and "no such account" stay indistinguishable — telling
       * them apart is how an account list gets built. But "the API is not
       * answering" is a different problem with a different fix, and collapsing
       * it into the credentials message sends the owner off to reset a
       * password that was never wrong.
       */
      redirect(result.error === 'api_unreachable' ? '/login?error=api' : '/login?error=1');
    }

    await setSessionToken(result.token);
    redirect('/');
  }

  return (
    <main className="login">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-dot" aria-hidden />
          <span>Frontly</span>
        </div>
        <p className="login-tagline">{t('signInTagline')}</p>

        {error && (
          <p className="notice" data-kind="bad">
            {error === 'api' ? t('signInUnreachable') : t('signInFailed')}
          </p>
        )}

        <form action={signIn}>
          <div className="field">
            <label htmlFor="email">{t('email')}</label>
            <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
          </div>

          <div className="field">
            <label htmlFor="password">{t('password')}</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>

          <button className="btn" type="submit" style={{ width: '100%' }}>
            {t('signIn')}
          </button>
        </form>
      </div>
    </main>
  );
}
