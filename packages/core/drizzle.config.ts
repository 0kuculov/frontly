import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit runs with cwd = packages/core, but the .env and the local
 * database file both live at the repo root. Resolving both here keeps
 * `drizzle-kit generate/push/studio` pointed at the same database the API
 * uses. (Mirrors src/db/paths.ts, inlined because drizzle-kit loads this file
 * standalone.)
 *
 * The root is found by walking up for pnpm-workspace.yaml rather than from
 * import.meta: drizzle-kit transpiles this config to CJS before running it,
 * where `import.meta.dirname` is undefined and every command dies with
 * `The "paths[0]" argument must be of type string`.
 */
function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

const repoRoot = findRepoRoot(process.cwd());
loadDotenv({ path: path.join(repoRoot, '.env'), quiet: true });

function resolveDatabaseUrl(url: string): string {
  if (!url.startsWith('file:')) return url;
  const raw = url.slice('file:'.length);
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return url;
  return `file:${path.resolve(repoRoot, raw).split(path.sep).join('/')}`;
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'turso',
  dbCredentials: {
    url: resolveDatabaseUrl(process.env.DATABASE_URL ?? 'file:./frontly.db'),
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
  verbose: true,
  strict: true,
});
