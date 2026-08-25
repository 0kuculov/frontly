import {
  createDb,
  listBusinesses,
  loadRootEnv,
  updateVoiceConfig,
  type Business,
} from '@frontly/core';
import {
  DEFAULT_RECOGNITION_CONFIG,
  DEFAULT_VOICE_CONFIG,
  recognitionConfigSchema,
  recognitionFor,
  type VoiceConfig,
} from '@frontly/shared';

/**
 * Tune when Azure decides the caller has stopped talking — by ear, on a real
 * line, without a deploy.
 *
 * These thresholds cannot be chosen from a desk. Azure's default ends a phrase
 * after 500 ms of silence, which is shorter than the pause a person takes while
 * working out which day suits them, so the agent answered half-finished
 * sentences. The right number is whatever stops doing that for real callers.
 *
 * Writes to the business row, so the NEXT call picks it up: no restart, no
 * redeploy, no build.
 *
 *   pnpm --filter @frontly/api tune:speech                 # show current
 *   pnpm --filter @frontly/api tune:speech --silence 1100
 *   pnpm --filter @frontly/api tune:speech --barge-in 500 --barge-in-chars 3
 *   pnpm --filter @frontly/api tune:speech --strategy Semantic
 *   pnpm --filter @frontly/api tune:speech --reprompt-after 6000
 *   pnpm --filter @frontly/api tune:speech --phrase-weight 1.0   # OFF by default: measured harmful, see sweep:phrases
 *   pnpm --filter @frontly/api tune:speech --min-confidence 0.3
 *   pnpm --filter @frontly/api tune:speech --silent-low-confidence 1
 *   pnpm --filter @frontly/api tune:speech --low-confidence-hold 2000
 *   pnpm --filter @frontly/api tune:speech --presence-window 20000   # never hang up on a present caller
 *   pnpm --filter @frontly/api tune:speech --abandon-after 120000    # the ONLY agent hangup
 *   pnpm --filter @frontly/api tune:speech --reset
 */

loadRootEnv();

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const bold = (t: string) => `[1m${t}[0m`;
const dim = (t: string) => `[2m${t}[0m`;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const db = createDb({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
  const all = await listBusinesses(db);
  if (all.length === 0) {
    console.error('No businesses in this database. Run pnpm db:seed first.');
    process.exit(1);
  }

  const slug = flag('business');
  const targets = slug ? all.filter((b) => b.slug === slug || b.id === slug) : all;
  if (targets.length === 0) {
    console.error(`No business matching "${slug}".`);
    process.exit(1);
  }

  // Say which database, out loud. This writes to whatever DATABASE_URL points
  // at, and during a demo week that is production.
  console.log(dim(`\n  database: ${describeUrl(url)}`));

  const changes: Record<string, unknown> = {};
  const silence = flag('silence');
  const strategy = flag('strategy');
  const bargeInMs = flag('barge-in');
  const bargeInChars = flag('barge-in-chars');
  const maximum = flag('max-phrase');
  const reprompt = flag('reprompt-after');
  const maxReprompts = flag('max-reprompts');
  const phraseWeight = flag('phrase-weight');
  const minConfidence = flag('min-confidence');
  const maxLowConfidence = flag('max-low-confidence');
  const silentLowConfidence = flag('silent-low-confidence');
  const lowConfidenceHold = flag('low-confidence-hold');
  const presenceWindow = flag('presence-window');
  const abandonAfter = flag('abandon-after');

  if (silence !== undefined) changes.segmentationSilenceMs = Number(silence);
  if (strategy !== undefined) changes.segmentationStrategy = strategy;
  if (bargeInMs !== undefined) changes.bargeInMs = Number(bargeInMs);
  if (bargeInChars !== undefined) changes.bargeInMinChars = Number(bargeInChars);
  if (maximum !== undefined) changes.segmentationMaximumMs = Number(maximum);
  if (reprompt !== undefined) changes.repromptAfterMs = Number(reprompt);
  if (maxReprompts !== undefined) changes.maxReprompts = Number(maxReprompts);
  if (phraseWeight !== undefined) changes.phraseListWeight = Number(phraseWeight);
  if (minConfidence !== undefined) changes.minConfidence = Number(minConfidence);
  if (maxLowConfidence !== undefined) changes.maxLowConfidenceTurns = Number(maxLowConfidence);
  if (silentLowConfidence !== undefined)
    changes.silentLowConfidenceTurns = Number(silentLowConfidence);
  if (lowConfidenceHold !== undefined) changes.lowConfidenceHoldMs = Number(lowConfidenceHold);
  if (presenceWindow !== undefined) changes.presenceWindowMs = Number(presenceWindow);
  if (abandonAfter !== undefined) changes.abandonAfterMs = Number(abandonAfter);

  const resetting = args.includes('--reset');

  if (!resetting && Object.keys(changes).length === 0) {
    for (const business of targets) show(business);
    console.log(dim('\n  Nothing changed. Pass --silence <ms> to tune.\n'));
    db.$client.close();
    return;
  }

  for (const business of targets) {
    const current = recognitionFor(business.voiceConfig);
    const merged = resetting
      ? DEFAULT_RECOGNITION_CONFIG
      : recognitionConfigSchema.safeParse({ ...current, ...changes });

    const next = resetting
      ? DEFAULT_RECOGNITION_CONFIG
      : merged && 'success' in merged && merged.success
        ? merged.data
        : undefined;

    if (!next) {
      const issues =
        merged && 'success' in merged && !merged.success
          ? merged.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : 'invalid value';
      console.error(`\n  Rejected for ${business.name}: ${issues}`);
      console.error(dim('  Azure accepts 100-5000 ms of segmentation silence.\n'));
      process.exitCode = 1;
      continue;
    }

    const voiceConfig: VoiceConfig = {
      ...(business.voiceConfig ?? DEFAULT_VOICE_CONFIG),
      recognition: next,
    };
    await updateVoiceConfig(db, business.id, voiceConfig);

    console.log(bold(`\n  ${business.name}`));
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      const before = current[key];
      const after = next[key];
      const marker = before === after ? ' ' : '*';
      console.log(
        `  ${marker} ${String(key).padEnd(24)} ${String(before).padEnd(10)} -> ${String(after)}`,
      );
    }
  }

  console.log(dim('\n  Live on the next call. No restart needed.\n'));
  db.$client.close();
}

function show(business: Business): void {
  const current = recognitionFor(business.voiceConfig);
  console.log(bold(`\n  ${business.name}`) + dim(`  (${business.slug})`));
  for (const [key, value] of Object.entries(current)) {
    const isDefault =
      value === DEFAULT_RECOGNITION_CONFIG[key as keyof typeof DEFAULT_RECOGNITION_CONFIG];
    console.log(`    ${key.padEnd(24)} ${String(value)}${isDefault ? dim('  (default)') : ''}`);
  }
}

/** Host only — the auth token lives in the URL for some providers. */
function describeUrl(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

main().catch((error: unknown) => {
  console.error('tune failed:', error);
  process.exit(1);
});
