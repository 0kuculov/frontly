import { loadRootEnv } from '@frontly/core';
import { EnvValidationError, loadEnv, type ServerEnv } from '@frontly/shared';

/**
 * Reads the repo-root .env (one file for the whole monorepo, so the API and
 * the db scripts can never disagree about which database they are on), then
 * validates it. On Render there is no .env and real environment variables
 * take over, which is a no-op here.
 */
export function loadApiEnv(): ServerEnv {
  loadRootEnv();
  try {
    return loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(`\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

export type { ServerEnv };
