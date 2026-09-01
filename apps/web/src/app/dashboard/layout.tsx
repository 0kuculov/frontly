import { redirect } from 'next/navigation';
import { apiGet, type SettingsResponse } from '../../lib/api';
import { getLang, getSessionToken } from '../../lib/session';
import { translator } from '../../lib/i18n';
import { signOut } from './actions';
import { LanguageToggle, Nav } from './nav';
import { Wordmark } from '../logo';
import './dashboard.css';

/**
 * The shell every dashboard page sits in.
 *
 * The session check lives here rather than in middleware because middleware
 * runs on the edge runtime, where node:crypto is unavailable — and the token
 * is an HMAC. Checking in the layout costs one redirect and keeps all the
 * auth in one runtime.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!(await getSessionToken())) redirect('/login');

  const lang = await getLang();
  const t = translator(lang);

  /**
   * The clinic's name in the sidebar, so it is never ambiguous which business
   * is on screen — the thing the demo-reset incident proved matters.
   */
  let clinic = 'Frontly';
  try {
    const settings = await apiGet<SettingsResponse>('/dashboard/settings');
    clinic = settings.business.name;
  } catch {
    // A name is a nicety. Never let it stop the dashboard rendering.
  }

  return (
    <div className="app" lang={lang}>
      <aside className="side">
        {/*
          Two lines, and the order is the point: the PRODUCT first, then who is
          signed in to it.

          They used to share one line — mark, then "Дентал Охрид" — which read
          as though the clinic were the product's name. It is the customer. So
          Frontly takes the wordmark and the top slot, and the clinic sits
          under a label that says what it is, in the quieter register the rest
          of the sidebar uses for machine values.
        */}
        <div className="brand">
          <Wordmark size={22} />
        </div>
        <div className="tenant">
          <span className="tenant-label">{t('clinic')}</span>
          <span className="tenant-name">{clinic}</span>
        </div>

        <Nav lang={lang} />

        <div className="side-foot">
          <LanguageToggle lang={lang} />
          <form action={signOut}>
            <button type="submit" className="linkish">
              {t('signOut')}
            </button>
          </form>
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
