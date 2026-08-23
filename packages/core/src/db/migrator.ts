import path from 'node:path';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { Database } from './client.js';
import { REPO_ROOT } from './paths.js';

/**
 * Where the generated SQL lives. Kept here so that nothing outside
 * @frontly/core ever has to know drizzle exists — apps/api runs migrations in
 * tests through this function, not through the ORM.
 */
export const MIGRATIONS_DIR = path.resolve(REPO_ROOT, 'packages/core/drizzle');

/** Idempotent: drizzle records which migrations have already been applied. */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
