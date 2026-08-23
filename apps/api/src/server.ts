import { loadApiEnv } from './env.js';
import { buildApp, API_VERSION } from './app.js';

/**
 * Process entry point. Validates the environment before anything else so a
 * misconfigured deploy dies at boot with a readable message instead of at the
 * first phone call.
 */
async function main(): Promise<void> {
  const env = loadApiEnv();
  const { app, db } = await buildApp(env);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      db.$client.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  await app.listen({ port: env.PORT, host: env.HOST });

  app.log.info(
    {
      version: API_VERSION,
      env: env.NODE_ENV,
      database: env.DATABASE_URL.startsWith('file:') ? 'local file' : 'turso',
    },
    'frontly api ready',
  );
}

main().catch((error: unknown) => {
  console.error('Failed to start frontly-api:', error);
  process.exit(1);
});
