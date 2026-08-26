import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Dashboard sessions, as a signed token rather than a cookie.
 *
 * The dashboard is a client of this API and lives on a different origin —
 * Vercel talks to Render — so a cookie set here would be cross-site, needing
 * `SameSite=None; Secure` and credentialed CORS on every request, which is a
 * lot of surface to get exactly right for a login form.
 *
 * A bearer token avoids all of it. The browser holds an httpOnly cookie on the
 * DASHBOARD's own origin; the dashboard's server sends this token to the API.
 * The token never reaches the browser, so there is no XSS token-theft story
 * and no third-party cookie to be blocked by a browser that has decided it
 * does not like them any more.
 *
 * HMAC-SHA256 over `payload.signature`, both base64url. Deliberately not JWT:
 * no library, no algorithm-confusion class of bug, and nothing here needs a
 * format anyone else has to parse.
 */

export interface SessionClaims {
  userId: string;
  businessId: string;
  /** Seconds since the epoch. */
  exp: number;
}

/** Long enough for a working day, short enough that a stolen token expires. */
export const DEFAULT_SESSION_SECONDS = 12 * 60 * 60;

const b64url = (buf: Buffer): string => buf.toString('base64url');

function sign(payload: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(payload).digest());
}

export function issueSession(
  claims: Omit<SessionClaims, 'exp'>,
  secret: string,
  { now = Date.now(), ttlSeconds = DEFAULT_SESSION_SECONDS } = {},
): string {
  const full: SessionClaims = {
    ...claims,
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
  const payload = b64url(Buffer.from(JSON.stringify(full), 'utf8'));
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verify, or return undefined. Never throws and never explains which half
 * failed — a caller that could tell a bad signature from an expired token
 * could use this as an oracle.
 */
export function readSession(
  token: string | undefined,
  secret: string,
  { now = Date.now() } = {},
): SessionClaims | undefined {
  if (!token) return undefined;

  const dot = token.indexOf('.');
  if (dot <= 0) return undefined;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(payload, secret);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Equal-width comparison anyway, so a wrong length is not faster to reject.
    timingSafeEqual(b, b);
    return undefined;
  }
  if (!timingSafeEqual(a, b)) return undefined;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < now) return undefined;
    if (typeof claims.userId !== 'string' || typeof claims.businessId !== 'string') {
      return undefined;
    }
    return claims;
  } catch {
    return undefined;
  }
}

/** `Authorization: Bearer <token>`. */
export function bearerToken(headers: Record<string, unknown>): string | undefined {
  const auth = headers.authorization;
  if (typeof auth !== 'string' || !/^bearer /i.test(auth)) return undefined;
  const value = auth.slice(7).trim();
  return value.length > 0 ? value : undefined;
}
