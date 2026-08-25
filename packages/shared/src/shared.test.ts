import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildSsml,
  DEFAULT_VOICE_CONFIG,
  escapeSsml,
  fromMinutes,
  loadEnv,
  parseLanguageTag,
  requireEnv,
  resetEnvCache,
  serverEnvSchema,
  toMinutes,
  weekdayHours,
  workingHoursSchema,
} from './index.js';

const baseEnv = { DATABASE_URL: 'file:./frontly.db' };

beforeEach(() => {
  resetEnvCache();
});

describe('environment validation', () => {
  it('boots on Phase 1 config alone — no carrier, Azure or Anthropic keys', () => {
    const env = loadEnv({ ...baseEnv } as NodeJS.ProcessEnv);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(8080);
    expect(env.ANTHROPIC_MODEL).toBe('claude-sonnet-5');
  });

  it('refuses a file: database in production', () => {
    // Render's disk is ephemeral: this config would silently lose every
    // booking on the next deploy.
    const result = serverEnvSchema.safeParse({
      ...baseEnv,
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://api.frontly.mk',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/ephemeral/);
  });

  it('demands an auth token alongside a Turso URL', () => {
    const result = serverEnvSchema.safeParse({ DATABASE_URL: 'libsql://frontly.turso.io' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path.includes('DATABASE_AUTH_TOKEN'))).toBe(true);
  });

  const productionDb = {
    DATABASE_URL: 'libsql://frontly.turso.io',
    DATABASE_AUTH_TOKEN: 'token',
    NODE_ENV: 'production',
  };

  it('refuses a production deploy that cannot answer the phone', () => {
    // Through Phases 1-2 this config was legitimately fine: there was no
    // inbound channel, and demanding webhook config blocked a deploy over a
    // future concern. From Phase 3 the phone line IS the product, and a
    // deploy missing these came up green with no voice route at all.
    const result = serverEnvSchema.safeParse(productionDb);
    expect(result.success).toBe(false);
    const paths = result.error?.issues.flatMap((i) => i.path) ?? [];
    expect(paths).toContain('AZURE_SPEECH_KEY');
    expect(paths).toContain('TELNYX_API_KEY');
  });

  it('still boots outside production with nothing configured', () => {
    // The rule above is about production only. A laptop with an empty .env
    // must still start, or the dashboard cannot be worked on without keys.
    const result = serverEnvSchema.safeParse({ DATABASE_URL: 'file:./frontly.db' });
    expect(result.success).toBe(true);
  });

  it('demands PUBLIC_BASE_URL once the carrier is configured', () => {
    const result = serverEnvSchema.safeParse({
      ...productionDb,
      AZURE_SPEECH_KEY: 'azure_test',
      TELNYX_API_KEY: 'KEY_test',
      TELNYX_PUBLIC_KEY: 'pub_test',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path.includes('PUBLIC_BASE_URL'))).toBe(true);
  });

  it('refuses to run an unverified webhook endpoint in production', () => {
    // Without the public key the adapter accepts any POST, and that endpoint
    // answers phone calls. Fine on a laptop, a bill on a public URL.
    const result = serverEnvSchema.safeParse({
      ...productionDb,
      AZURE_SPEECH_KEY: 'azure_test',
      TELNYX_API_KEY: 'KEY_test',
      PUBLIC_BASE_URL: 'https://frontly-api.onrender.com',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path.includes('TELNYX_PUBLIC_KEY'))).toBe(true);
  });

  it('accepts a fully configured production deploy', () => {
    const result = serverEnvSchema.safeParse({
      ...productionDb,
      AZURE_SPEECH_KEY: 'azure_test',
      TELNYX_API_KEY: 'KEY_test',
      TELNYX_PUBLIC_KEY: 'pub_test',
      PUBLIC_BASE_URL: 'https://frontly-api.onrender.com',
    });
    expect(result.success).toBe(true);
  });

  it('treats a blank optional variable as unset, not as invalid', () => {
    // .env files and Render's dashboard both hand over empty strings for keys
    // left untouched. Those must not block boot.
    const result = serverEnvSchema.safeParse({
      ...baseEnv,
      PUBLIC_BASE_URL: '',
      AUTH_SECRET: '',
      ANTHROPIC_API_KEY: '   ',
    });
    expect(result.success).toBe(true);
    expect(result.data?.PUBLIC_BASE_URL).toBeUndefined();
    expect(result.data?.AUTH_SECRET).toBeUndefined();
  });

  it('still rejects a non-blank malformed value', () => {
    const result = serverEnvSchema.safeParse({ ...baseEnv, PUBLIC_BASE_URL: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  it('splits APP_ORIGIN into a CORS list', () => {
    const env = loadEnv({
      ...baseEnv,
      APP_ORIGIN: 'http://localhost:3000, https://app.frontly.mk',
    } as NodeJS.ProcessEnv);
    expect(env.APP_ORIGIN).toEqual(['http://localhost:3000', 'https://app.frontly.mk']);
  });

  it('names the missing secret when a later phase asks for it', () => {
    const env = loadEnv({ ...baseEnv } as NodeJS.ProcessEnv);
    expect(() => requireEnv(env, ['AZURE_SPEECH_KEY'], 'Azure speech')).toThrow(
      /Azure speech needs AZURE_SPEECH_KEY/,
    );
  });
});

describe('working hours', () => {
  it('accepts the demo clinic schedule', () => {
    const hours = weekdayHours(
      [{ start: '09:00', end: '17:00' }],
      [{ start: '09:00', end: '13:00' }],
    );
    expect(workingHoursSchema.parse(hours).sun).toEqual([]);
  });

  it('accepts a split shift', () => {
    const result = workingHoursSchema.safeParse({
      ...weekdayHours([]),
      mon: [
        { start: '09:00', end: '13:00' },
        { start: '16:00', end: '20:00' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects overlapping intervals on the same day', () => {
    const result = workingHoursSchema.safeParse({
      ...weekdayHours([]),
      mon: [
        { start: '09:00', end: '13:00' },
        { start: '12:00', end: '17:00' },
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/Overlapping/);
  });

  it('rejects an interval that ends before it starts', () => {
    const result = workingHoursSchema.safeParse({
      ...weekdayHours([]),
      mon: [{ start: '17:00', end: '09:00' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed time', () => {
    const result = workingHoursSchema.safeParse({
      ...weekdayHours([]),
      mon: [{ start: '9:00', end: '17:00' }],
    });
    expect(result.success).toBe(false);
  });

  it('round-trips minutes', () => {
    expect(toMinutes('09:30')).toBe(570);
    expect(fromMinutes(570)).toBe('09:30');
    expect(fromMinutes(toMinutes('13:45'))).toBe('13:45');
  });
});

describe('language detection helpers', () => {
  it('narrows locale tags to a supported language', () => {
    expect(parseLanguageTag('mk-MK')).toBe('mk');
    expect(parseLanguageTag('sq')).toBe('sq');
    expect(parseLanguageTag('en-GB')).toBe('en');
  });

  it('returns undefined for anything else, rather than guessing', () => {
    expect(parseLanguageTag('sr-RS')).toBeUndefined();
    expect(parseLanguageTag(null)).toBeUndefined();
  });
});

describe('SSML synthesis', () => {
  const mk = DEFAULT_VOICE_CONFIG.mk;

  it('carries the tested Macedonian voice and prosody rate', () => {
    const ssml = buildSsml('Добар ден.', 'mk', mk);
    expect(ssml).toContain('xml:lang="mk-MK"');
    expect(ssml).toContain('name="mk-MK-AleksandarNeural"');
    expect(ssml).toContain('rate="-6%"');
  });

  it('inserts the 300ms pause between the greeting and the question', () => {
    const ssml = buildSsml(
      'Добар ден, се јавивте во Дентал Охрид. Како можам да ви помогнам?',
      'mk',
      mk,
      { breakAfterFirstSentence: true },
    );
    expect(ssml).toContain('<break time="300ms"/>');
    expect(ssml.indexOf('<break')).toBeGreaterThan(ssml.indexOf('Дентал Охрид'));
  });

  it('escapes text that would otherwise break the SSML document', () => {
    // A customer named "Ana & Co" must not produce invalid XML and silence.
    const ssml = buildSsml('Ana & Co <test>', 'en', DEFAULT_VOICE_CONFIG.en);
    expect(ssml).toContain('Ana &amp; Co &lt;test&gt;');
    expect(escapeSsml(`it's`)).toBe('it&apos;s');
  });

  it('uses sq-AL for Albanian', () => {
    const ssml = buildSsml('Mirëdita.', 'sq', DEFAULT_VOICE_CONFIG.sq);
    expect(ssml).toContain('xml:lang="sq-AL"');
    expect(ssml).toContain('name="sq-AL-IlirNeural"');
  });
});
