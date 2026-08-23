import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, enableForeignKeys, type Database } from './client.js';
import { runMigrations } from './migrator.js';
import { seedDemoBusiness } from './seed.js';

export interface TestDatabase {
  db: Database;
  /** libSQL URL of the temp file, for handing to a second connection. */
  url: string;
  cleanup: () => void;
}

export interface CreateTestDbOptions {
  /** Seed the Ohrid demo clinic. On by default — most tests want it. */
  seed?: boolean;
}

/**
 * A migrated, seeded, throwaway database on a real SQLite file.
 *
 * Real file rather than :memory: because the double-booking guard is a partial
 * unique index enforced by SQLite itself; testing it against anything other
 * than the migrations that ship would prove nothing.
 */
export async function createTestDb(options: CreateTestDbOptions = {}): Promise<TestDatabase> {
  const dir = mkdtempSync(path.join(tmpdir(), 'frontly-test-'));
  const file = path.join(dir, 'test.db').split(path.sep).join('/');
  const url = `file:${file}`;

  const db = createDb({ url });
  await enableForeignKeys(db);
  await runMigrations(db);
  if (options.seed !== false) await seedDemoBusiness(db);

  return {
    db,
    url,
    cleanup: () => {
      db.$client.close();
      try {
        // Windows releases the SQLite handle a beat after close().
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // The OS reclaims the temp directory; never fail a green run over it.
      }
    },
  };
}
