import { createClient, type Client, type Config } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { loadRootEnv, resolveDatabaseUrl } from './paths.js';

export type Database = LibSQLDatabase<typeof schema> & { $client: Client };

export interface DbConfig {
  url: string;
  authToken?: string | undefined;
}

/**
 * One connection factory for every entry point: the Fastify server, the
 * migration runner, the seed script and the tests. Nothing else calls
 * createClient directly, so there is exactly one place where connection
 * behaviour can drift.
 */
export function createDb(config: DbConfig): Database {
  const clientConfig: Config = { url: resolveDatabaseUrl(config.url) };
  if (config.authToken) clientConfig.authToken = config.authToken;
  const client = createClient(clientConfig);
  return drizzle(client, { schema, casing: 'snake_case' }) as Database;
}

/**
 * Local SQLite files ship with foreign keys OFF, which would let an orphaned
 * appointment sail straight past the schema. Hosted libSQL already enforces
 * them, so the failure there is expected and ignored.
 */
export async function enableForeignKeys(db: Database): Promise<void> {
  try {
    await db.$client.execute('PRAGMA foreign_keys = ON');
  } catch {
    // Remote libSQL: already on, and the pragma is not accepted over HTTP.
  }
}

export async function closeDb(db: Database): Promise<void> {
  db.$client.close();
}

/** Cheap liveness probe used by GET /health. */
export async function pingDb(db: Database): Promise<void> {
  await db.$client.execute('select 1');
}

let singleton: Database | undefined;

/**
 * Process-wide database handle, built from DATABASE_URL. Tests and scripts
 * that need isolation should call createDb() directly instead.
 */
export function getDb(): Database {
  if (singleton) return singleton;
  loadRootEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set - copy .env.example to .env');
  }
  singleton = createDb({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
  return singleton;
}

export function resetDbSingleton(): void {
  singleton = undefined;
}
