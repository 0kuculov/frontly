import { createDb, enableForeignKeys } from './client.js';
import { MIGRATIONS_DIR, runMigrations } from './migrator.js';
import { loadRootEnv } from './paths.js';

/**
 * Applies everything in packages/core/drizzle. Runs identically against a
 * local file: database and against Turso, and is safe to re-run - drizzle
 * tracks which migrations have already been applied.
 *
 * Render runs this as the pre-deploy command.
 */
async function main(): Promise<void> {
  loadRootEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set - copy .env.example to .env');

  const target = url.startsWith('file:') ? url : url.replace(/\?.*$/, '');
  console.log(`[migrate] target   : ${target}`);
  console.log(`[migrate] migrations: ${MIGRATIONS_DIR}`);

  const db = createDb({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
  await enableForeignKeys(db);

  const started = Date.now();
  await runMigrations(db);
  console.log(`[migrate] done in ${Date.now() - started}ms`);

  db.$client.close();
}

main().catch((error: unknown) => {
  console.error('[migrate] failed:', error);
  process.exit(1);
});
