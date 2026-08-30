import { cookies } from 'next/headers';
import { toLang, type Lang } from './lang';

/**
 * The browser's half of the login.
 *
 * The API issues a bearer token; this stores it in an httpOnly cookie on the
 * DASHBOARD's own origin. So the token never reaches client JavaScript, and it
 * is never a cross-site cookie — the browser talks to Vercel, and Vercel's
 * server talks to Render with the token in a header.
 *
 * That split is why there is no `SameSite=None` anywhere in this codebase.
 */

const TOKEN_COOKIE = 'frontly_session';
const LANG_COOKIE = 'frontly_lang';

/** Matches the API's own session lifetime; a cookie outliving it is just a 401. */
const MAX_AGE_SECONDS = 12 * 60 * 60;

export async function setSessionToken(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Vercel is https; localhost is not, and a `secure` cookie would silently
    // never be set there — which looks exactly like a broken login.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function getSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(TOKEN_COOKIE)?.value;
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(TOKEN_COOKIE);
}

export { LANGS, type Lang } from './lang';

/**
 * Macedonian unless asked otherwise.
 *
 * The product is Macedonian and so is the demo clinic. Albanian is a first
 * class choice rather than a fallback — the phone already answers in it — and
 * English is there so a judge reading over a shoulder is not locked out.
 *
 * Anything unrecognised becomes Macedonian rather than throwing: this reads a
 * cookie, and a cookie is whatever the browser last sent.
 */
export async function getLang(): Promise<Lang> {
  return toLang((await cookies()).get(LANG_COOKIE)?.value);
}

export async function setLang(lang: Lang): Promise<void> {
  const jar = await cookies();
  jar.set(LANG_COOKIE, lang, {
    sameSite: 'lax',
    path: '/',
    maxAge: 365 * 24 * 60 * 60,
  });
}
