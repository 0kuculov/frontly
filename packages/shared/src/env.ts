import { z } from 'zod';

/**
 * One zod schema for every server-side environment variable in the monorepo.
 *
 * Two rules shape it:
 *  1. Phase-1 booting must not require carrier/Azure/Anthropic keys, so those
 *     are optional here and demanded at point of use via `requireEnv`.
 *  2. Anything that would silently misbehave in production is checked here
 *     instead — a `file:` database on Render's ephemeral disk, a Turso URL
 *     with no auth token. Fail at boot, loudly, not at 3am on stage.
 */

const csv = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * A blank environment variable means "not set", not "set to an invalid value".
 * Both .env files and Render's dashboard produce empty strings for anything
 * left untouched, and without this every unfilled optional key — an empty
 * PUBLIC_BASE_URL, an empty AUTH_SECRET — would block boot for no reason.
 */
function stripEmptyStrings(source: unknown): unknown {
  if (typeof source !== 'object' || source === null) return source;
  return Object.fromEntries(
    Object.entries(source as Record<string, unknown>).filter(
      ([, value]) => !(typeof value === 'string' && value.trim() === ''),
    ),
  );
}

const serverEnvShape = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    HOST: z.string().min(1).default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    // --- Phase 1 -------------------------------------------------------
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (file:./frontly.db for local dev)'),
    DATABASE_AUTH_TOKEN: z.string().optional(),
    APP_ORIGIN: z.string().default('http://localhost:3000').transform(csv),
    PUBLIC_BASE_URL: z.url().optional(),

    // --- Phase 2 -------------------------------------------------------
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),

    // --- Phase 3 -------------------------------------------------------
    /** Telnyx API v2 key. Bearer token on every Call Control command. */
    TELNYX_API_KEY: z.string().optional(),
    /** E.164, the number callers dial. Also the caller ID a transfer presents. */
    TELNYX_PHONE_NUMBER: z.string().optional(),
    /**
     * Account Settings → Keys & Credentials → Public Key, base64.
     *
     * Optional so local development works without it, but its absence turns
     * webhook signature checking off — which is why production demands it
     * below rather than trusting the default.
     */
    TELNYX_PUBLIC_KEY: z.string().optional(),
    AZURE_SPEECH_KEY: z.string().optional(),
    AZURE_SPEECH_REGION: z.string().default('italynorth'),

    // --- Phase 4 -------------------------------------------------------
    AUTH_SECRET: z.string().min(32).optional(),

    // --- Phase 7 -------------------------------------------------------
    DEMO_RESET_TOKEN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    const isTurso = /^libsql:\/\//i.test(env.DATABASE_URL) || /^wss?:\/\//i.test(env.DATABASE_URL);
    const isFile = /^file:/i.test(env.DATABASE_URL);

    if (isTurso && !env.DATABASE_AUTH_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_AUTH_TOKEN'],
        message: 'A libsql:// DATABASE_URL needs DATABASE_AUTH_TOKEN (turso db tokens create <db>)',
      });
    }

    if (env.NODE_ENV === 'production' && isFile) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message:
          'Refusing a file: database in production — Render\'s disk is ephemeral and every ' +
          'deploy would wipe the bookings. Point DATABASE_URL at Turso.',
      });
    }

    /**
     * In production the voice channel is not optional.
     *
     * These were optional-at-boot through Phase 1 and 2, which was right then:
     * no inbound channel existed. From Phase 3 the phone line IS the product,
     * and leaving them optional meant a deploy missing one came up green with
     * no voice route at all — healthy, and unable to answer. The guard names
     * the variable so the Render log says which one.
     */
    if (env.NODE_ENV === 'production') {
      const forVoice: [keyof typeof env, string][] = [
        ['AZURE_SPEECH_KEY', 'the agent has no voice and cannot hear the caller'],
        ['TELNYX_API_KEY', 'inbound calls are never answered'],
      ];
      for (const [key, consequence] of forVoice) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required in production — without it ${consequence}.`,
          });
        }
      }
    }

    /**
     * PUBLIC_BASE_URL only means anything once an inbound channel has to hand
     * out callback URLs, which is telephony in Phase 3. Requiring it at boot
     * blocked the Phase 1 deploy over a Phase 3 concern — so it is demanded
     * when the carrier is actually configured, and by requireEnv at the point
     * the voice adapter builds a stream URL.
     */
    if (env.NODE_ENV === 'production' && env.TELNYX_API_KEY && !env.PUBLIC_BASE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_BASE_URL'],
        message:
          'TELNYX_API_KEY is set but PUBLIC_BASE_URL is not — the media stream URL handed ' +
          'to Telnyx is built from it, so answered calls would carry no audio.',
      });
    }

    /**
     * Without the public key the adapter cannot verify webhook signatures and
     * accepts anything. That is fine on a laptop and unacceptable on a public
     * URL, where the endpoint answers phone calls that cost money.
     */
    if (env.NODE_ENV === 'production' && env.TELNYX_API_KEY && !env.TELNYX_PUBLIC_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['TELNYX_PUBLIC_KEY'],
        message:
          'TELNYX_API_KEY is set but TELNYX_PUBLIC_KEY is not — webhook signatures would go ' +
          'unverified, leaving a public endpoint that answers calls for anyone who posts to it. ' +
          'Copy it from Telnyx → Account Settings → Keys & Credentials → Public Key.',
      });
    }
  });

export const serverEnvSchema = z.preprocess(stripEmptyStrings, serverEnvShape);

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: z.core.$ZodIssue[]) {
    const lines = issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`);
    super(`Invalid environment configuration:\n${lines.join('\n')}\n\nSee .env.example.`);
    this.name = 'EnvValidationError';
  }
}

let cached: ServerEnv | undefined;

/** Parse and cache process.env. Throws EnvValidationError with every problem at once. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  if (cached) return cached;
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError(result.error.issues);
  cached = result.data;
  return cached;
}

/** Test helper — drops the memoised value so a fresh env can be parsed. */
export function resetEnvCache(): void {
  cached = undefined;
}

/**
 * Demand optional-at-boot secrets at the point a feature actually needs them.
 * Keeps Phase 1 bootable with an empty .env while making the failure mode for
 * a half-configured Phase 3 obvious.
 *
 *   const { AZURE_SPEECH_KEY } = requireEnv(env, ['AZURE_SPEECH_KEY'], 'Azure speech');
 */
export function requireEnv<K extends keyof ServerEnv>(
  env: ServerEnv,
  keys: readonly K[],
  feature: string,
): { [P in K]: NonNullable<ServerEnv[P]> } {
  const missing = keys.filter((k) => env[k] === undefined || env[k] === '');
  if (missing.length > 0) {
    throw new Error(`${feature} needs ${missing.join(', ')} — set ${missing.length > 1 ? 'them' : 'it'} in .env`);
  }
  return Object.fromEntries(keys.map((k) => [k, env[k]])) as { [P in K]: NonNullable<ServerEnv[P]> };
}
