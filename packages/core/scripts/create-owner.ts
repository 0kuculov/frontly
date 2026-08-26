import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createDb } from '../src/db/client.js';
import { loadRootEnv } from '../src/db/paths.js';
import { DEMO_IDS } from '../src/db/seed.js';
import { createUser, findUserByEmail, setPassword, verifyPassword } from '../src/db/users.js';
import { listBusinesses } from '../src/db/queries.js';

/**
 * Create (or re-password) the dashboard login.
 *
 *   pnpm db:create-owner --email ana@dental.mk
 *   pnpm db:create-owner --email ana@dental.mk --business biz_demo_dental_ohrid
 *   pnpm db:create-owner --email ana@dental.mk --verify   # check it, change nothing
 *
 * The password is asked for interactively and never taken from a flag, so it
 * does not end up in shell history, in a process list, or in a screenshot of
 * this terminal during a demo. Nothing is written to .env — the credential
 * lives in the database as a scrypt hash, and this script is the only way it
 * gets there.
 *
 * Re-running it for an existing email sets a new password rather than failing,
 * because "I forgot it the day before the pitch" is the likeliest reason
 * anyone runs this twice.
 */

loadRootEnv();

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const email = flag('email');
  if (!email) {
    console.error('Usage: pnpm db:create-owner --email <address> [--business <id>]');
    process.exit(1);
  }

  const db = createDb({ url, authToken: process.env.DATABASE_AUTH_TOKEN });

  /**
   * Which clinic this login belongs to.
   *
   * Falls back to the only business when there is exactly one — the same rule
   * inbound call routing uses, and for the same reason: the demo deployment
   * has one clinic and making the operator type its id would be ceremony.
   */
  let businessId = flag('business');
  if (!businessId) {
    const all = await listBusinesses(db);
    if (all.length === 1) businessId = all[0]!.id;
    else if (all.some((b) => b.id === DEMO_IDS.business)) businessId = DEMO_IDS.business;
    else {
      console.error(
        `Several businesses exist; name one with --business. Found: ${all.map((b) => b.id).join(', ')}`,
      );
      process.exit(1);
    }
  }

  console.log(`\n  database : ${describeUrl(url)}`);
  console.log(`  business : ${businessId}`);
  console.log(`  email    : ${email}\n`);

  /**
   * Interactive when a human is there, piped when one is not.
   *
   * Still never a `--password` flag: a flag ends up in shell history, in the
   * process list, and in a screenshot of this terminal during a demo. Reading
   * stdin keeps it out of all three while letting a script (or a test) drive
   * this without a TTY.
   */
  const { password, again } = stdin.isTTY
    ? await askInteractively()
    : await readTwoLinesFromStdin();

  if (password.length < 10) {
    console.error('\n  Too short. Use at least 10 characters.\n');
    process.exit(1);
  }
  const verifying = process.argv.includes('--verify');

  if (password !== again && !verifying) {
    console.error('\n  They do not match. Nothing was changed.\n');
    process.exit(1);
  }

  const existing = await findUserByEmail(db, email);

  /**
   * `--verify` answers "is this actually my password?" without changing it.
   *
   * The thing that prompts a password reset is almost never a bad hash — it is
   * "is the API even running, and am I pointed at the database I think I am".
   * This answers both against the same database the API reads, and writes
   * nothing.
   */
  if (verifying) {
    if (!existing) {
      console.error(`\n  No account for ${email} in THIS database (${describeUrl(url)}).\n`);
      process.exit(1);
    }
    const ok = await verifyPassword(password, existing.passwordHash, existing.passwordSalt);
    console.log(
      ok
        ? `\n  Correct. ${email} authenticates against ${describeUrl(url)}.\n`
        : `\n  Wrong password for ${email}. Re-run without --verify to set a new one.\n`,
    );
    db.$client.close();
    process.exit(ok ? 0 : 1);
  }

  if (existing) {
    await setPassword(db, existing.id, password);
    console.log(`\n  Password updated for ${email}.\n`);
  } else {
    const user = await createUser(db, { businessId, email, password });
    console.log(`\n  Created ${user.email} (${user.id}).\n`);
  }

  db.$client.close();
}

async function askInteractively(): Promise<{ password: string; again: string }> {
  const rl = createInterface({ input: stdin, output: stdout });
  const password = await rl.question('  password (typed visibly — nobody behind you?): ');
  const again = await rl.question('  again: ');
  rl.close();
  return { password, again };
}

const SPLIT_PATTERN = new RegExp(String.raw`\r?\n`);

/** Two lines: the password, then the same password again. */
async function readTwoLinesFromStdin(): Promise<{ password: string; again: string }> {
  let raw = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) raw += chunk;
  // Split on either line ending: a password piped from a Windows shell
  // arrives with a carriage return that would otherwise become part of it.
  const lines = raw.split(SPLIT_PATTERN);
  return { password: lines[0] ?? '', again: lines[1] ?? '' };
}

/** Host only — some providers carry the auth token in the URL. */
function describeUrl(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

main().catch((error: unknown) => {
  console.error('create-owner failed:', error);
  process.exit(1);
});
