#!/usr/bin/env node
/**
 * Is .env intact?
 *
 *   pnpm env:check
 *
 * This exists because .env has now been emptied twice, and both times it was
 * discovered indirectly — a deploy failing, a call not connecting — rather than
 * by anyone noticing the file. Two seconds of checking beats finding out
 * mid-demo.
 *
 * READ ONLY. It never writes, never repairs, and never prints a secret. If
 * something is wrong it says which variable, and the owner fixes it — .env is
 * theirs. (A script that "helpfully" restored .env is precisely the thing the
 * rest of this repo's guards exist to prevent.)
 *
 * Values are reported as a length and an 8-character SHA-256 prefix rather
 * than as themselves. That is enough to compare two points in time, which
 * catches the failure mode key-presence alone misses: a sync client restoring
 * an OLDER .env, where every variable is present and several are stale. That
 * is the exact shape of the first wipe.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

/**
 * Empty here means broken, not merely unset.
 *
 * Deliberately short. Per-phase secrets are demanded at point of use rather
 * than at boot (see requireEnv), so listing every variable would cry wolf on a
 * perfectly good half-configured machine. These five are the ones whose
 * absence means the product does not work at all.
 */
const CRITICAL = [
  'DATABASE_URL',
  'DATABASE_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'TELNYX_API_KEY',
  'AZURE_SPEECH_KEY',
];

const bold = (t) => `[1m${t}[0m`;
const dim = (t) => `[2m${t}[0m`;
const red = (t) => `[31m${t}[0m`;
const green = (t) => `[32m${t}[0m`;
const yellow = (t) => `[33m${t}[0m`;

/** Key/value pairs, ignoring comments and blank lines. Values are never echoed. */
function parse(file) {
  const out = new Map();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return out;
}

function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

if (!existsSync(envPath)) {
  console.error(`\n  ${red('.env IS MISSING')} — ${envPath}\n`);
  console.error('  It has been wiped, not merely emptied. Restore it from your own copy;');
  console.error('  nothing in this repo will recreate it, by design.\n');
  process.exit(1);
}

const env = parse(envPath);
const example = existsSync(examplePath) ? parse(examplePath) : new Map();
const bytes = readFileSync(envPath).length;

const withValues = [...env.values()].filter((v) => v !== '').length;

console.log(`\n  ${bold('.env')} ${dim(`— ${bytes} bytes, ${env.size} variables, ${withValues} with values`)}\n`);

const problems = [];

for (const key of CRITICAL) {
  const value = env.get(key);
  if (value === undefined) {
    problems.push(`${key} is absent`);
    console.log(`  ${red('MISSING')}  ${key}`);
  } else if (value === '') {
    problems.push(`${key} is empty`);
    console.log(`  ${red('EMPTY  ')}  ${key}`);
  } else {
    console.log(`  ${green('ok     ')}  ${key.padEnd(24)} ${dim(`${value.length} chars  ${fingerprint(value)}`)}`);
  }
}

/** Everything else, so a stale value can be spotted by comparing fingerprints. */
const others = [...env.keys()].filter((k) => !CRITICAL.includes(k));
if (others.length > 0) {
  console.log(`\n  ${dim('other variables')}`);
  for (const key of others) {
    const value = env.get(key) ?? '';
    const state = value === '' ? yellow('unset  ') : green('ok     ');
    const detail = value === '' ? '' : dim(`${value.length} chars  ${fingerprint(value)}`);
    console.log(`  ${state}  ${key.padEnd(24)} ${detail}`);
  }
}

/**
 * Declared in .env.example but absent here. Usually means a new variable was
 * added by a phase and never set locally — worth saying, never fatal.
 */
const undeclared = [...example.keys()].filter((k) => !env.has(k));
if (undeclared.length > 0) {
  console.log(`\n  ${yellow('declared in .env.example but not in .env:')}`);
  for (const key of undeclared) console.log(`    ${key}`);
}

if (problems.length > 0) {
  console.error(`\n  ${red(bold('PROBLEM'))} — ${problems.join(', ')}.`);
  console.error('  Fix .env yourself; this script will not touch it.\n');
  process.exit(1);
}

console.log(`\n  ${green('Intact.')} ${dim('Compare the fingerprints after any suspected wipe.')}\n`);
