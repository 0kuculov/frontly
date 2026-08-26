import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import type { Database } from './client.js';
import { users, type User } from './schema.js';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

/**
 * Dashboard accounts.
 *
 * `scrypt` from node:crypto rather than bcrypt or argon2: both of those are
 * native modules, and this repo has already lost a deploy to native
 * postinstalls once (see `allowBuilds` in pnpm-workspace.yaml). Node's scrypt
 * is memory-hard, in the standard library, and needs no build step — the right
 * trade for an owner dashboard with a handful of users.
 */

/** OWASP's floor for scrypt, and comfortably fast enough for a login form. */
const KEY_LENGTH = 64;

export async function hashPassword(
  password: string,
): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return { hash: derived.toString('hex'), salt };
}

/**
 * Compare without leaking the answer in how long it took.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * signal, so the lengths are checked first and a mismatch still does one
 * comparison of equal width.
 */
export async function verifyPassword(
  password: string,
  hash: string,
  salt: string,
): Promise<boolean> {
  const derived = await scrypt(password, salt, KEY_LENGTH);
  const expected = Buffer.from(hash, 'hex');
  if (derived.length !== expected.length) {
    timingSafeEqual(derived, derived);
    return false;
  }
  return timingSafeEqual(derived, expected);
}

/** Lowercased on the way in AND on the way out, so the unique index means it. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(
  db: Database,
  email: string,
): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.email, normalizeEmail(email)));
  return row;
}

export async function findUserById(db: Database, id: string): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row;
}

export interface CreateUserInput {
  businessId: string;
  email: string;
  password: string;
  name?: string | undefined;
}

export async function createUser(db: Database, input: CreateUserInput): Promise<User> {
  const { hash, salt } = await hashPassword(input.password);
  const [row] = await db
    .insert(users)
    .values({
      businessId: input.businessId,
      email: normalizeEmail(input.email),
      passwordHash: hash,
      passwordSalt: salt,
      ...(input.name ? { name: input.name } : {}),
    })
    .returning();
  return row!;
}

/**
 * Change a password in place.
 *
 * A fresh salt every time, not just a fresh hash: reusing the salt would make
 * two passwords for the same account comparable, which is the whole thing a
 * per-password salt exists to prevent.
 */
export async function setPassword(
  db: Database,
  userId: string,
  password: string,
): Promise<void> {
  const { hash, salt } = await hashPassword(password);
  await db
    .update(users)
    .set({ passwordHash: hash, passwordSalt: salt, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function recordLogin(db: Database, userId: string, at: Date): Promise<void> {
  await db.update(users).set({ lastLoginAt: at }).where(eq(users.id, userId));
}

/**
 * Authenticate, or say no without saying why.
 *
 * Returns undefined for both "no such account" and "wrong password", and does
 * the scrypt work in both cases. Answering faster for an unknown email would
 * turn the login form into a way to enumerate who has an account.
 */
export async function authenticate(
  db: Database,
  email: string,
  password: string,
): Promise<User | undefined> {
  const user = await findUserByEmail(db, email);

  if (!user) {
    // Burn the same work so a missing account is not measurably quicker.
    await hashPassword(password);
    return undefined;
  }

  const ok = await verifyPassword(password, user.passwordHash, user.passwordSalt);
  return ok ? user : undefined;
}
