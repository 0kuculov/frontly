import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

/**
 * The monorepo has ONE .env at its root, and `DATABASE_URL=file:./frontly.db`
 * must mean the same file whether it is read by the Fastify server (cwd =
 * repo root), by drizzle-kit (cwd = packages/core) or by vitest. Resolving
 * relative file: URLs here is what stops "the migration ran but the API sees
 * an empty database" — a bug that costs an hour every time it appears.
 *
 * Four levels up lands on the repo root from both src/db and dist/db.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(here, '../../../..');

let dotenvLoaded = false;

/** Loads the root .env once. A missing file is fine — Render injects real vars. */
export function loadRootEnv(): void {
  if (dotenvLoaded) return;
  loadDotenv({ path: path.join(REPO_ROOT, '.env'), quiet: true });
  dotenvLoaded = true;
}

/**
 * Turns a relative `file:` URL into an absolute one anchored at the repo root.
 * Remote libSQL URLs and already-absolute paths pass through untouched.
 */
export function resolveDatabaseUrl(url: string): string {
  if (!url.startsWith('file:')) return url;

  const raw = url.slice('file:'.length);
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return url;

  const absolute = path.resolve(REPO_ROOT, raw);
  return `file:${absolute.split(path.sep).join('/')}`;
}
