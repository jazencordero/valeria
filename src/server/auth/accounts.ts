/*
 * Accounts (M5-14): a username and a password on a `users` row, so an account made for a student
 * (M3-57) can be handed over and opened on any device.
 *
 *   signUp(username, password, opts)  -> { ok, userId, token } | { ok: false, error }
 *   logIn(username, password, opts)   -> { ok, userId, token } | { ok: false, error }
 *
 * Both make a device session the way `src/server/auth/session.ts` does (a fresh random token,
 * only its sha256 stored in `sessions`); the caller sets the `ready_session` cookie to the token
 * and ends the session the browser had before (`endDeviceSession`). The old device user is left
 * as it was: it is not merged into the account (that would pour a demo or a half-done first run
 * into a handed-over account) and not deleted (the idle-visitor cleanup removes it in time).
 *
 * Usernames: 3 to 32 of a-z 0-9 . _ -, stored lower-case (typed capitals are lowered). Passwords:
 * src/server/auth/password.ts (scrypt, length 5 to 200 only).
 *
 * Log in gives one answer for a wrong name and a wrong password ("That username and password do
 * not match."), after the same work: one lookup by name and one scrypt check, against a dummy
 * hash when the name is unknown.
 *
 * The brake: after 5 failed tries for one username in 15 minutes, or 20 from one address, every
 * try is refused with "Too many tries. Wait 15 minutes." until the oldest of those fails is 15
 * minutes old. A refused try is not counted and does not check the password. A right password
 * clears that username's count (not the address's). Fails are counted in the database, so every
 * server instance sees the same count: one `jobs` row per fail, already `done` so the queue never
 * picks it up (it only claims queued or running rows): kind `login_fail_user` or
 * `login_fail_addr`, `run_after` = the time of the fail (so the count uses the
 * (status, run_after) index), `payload.key` = sha256 of the lower-cased name or the address,
 * never the name or the address itself, and no `user_id` (a visitor who has no cookie yet has no
 * user, and an unknown name must be counted exactly like a known one). `confirm_codes` was the
 * other choice the ticket offered; its `user_id` is required, so every cookie-less try would
 * first have to make a throwaway user. Rows older than a day are deleted when a new fail is
 * written. Two tries at the same instant can both pass the check, so the limit can be overrun by
 * the number of tries in flight; that is accepted.
 *
 * M5-15: a signed-in account gives itself a login in Settings (`setLogin` with `firstOnly`: only
 * a user with neither a name nor a password, never a demo, and never a second name) and changes
 * its password (`changePassword`). The current password is checked behind the same brake as log
 * in: the same per-name and per-address counts, a wrong one counts as a failed try for that name,
 * and the right one clears the name's count.
 *
 * Nothing here logs a username, a password, a hash or an address.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { jobs } from "@/server/db/schema/system";
import { sessions, users, USERNAME_SQL_PATTERN } from "@/server/db/schema/users";
import { hashPassword, passwordProblem, verifyPassword } from "./password";
import { hashToken, isWellFormedToken, newToken } from "./session";

export const NO_MATCH = "That username and password do not match.";
export const TOO_MANY = "Too many tries. Wait 15 minutes.";
export const TAKEN = "That username is taken. Pick another one.";
export const BAD_USERNAME = "Use 3 to 32 letters, numbers, dots, dashes or underscores, with no spaces.";
export const WRONG_CURRENT = "That is not your current password.";
export const HAS_LOGIN = "This account already has a username.";
export const NO_LOGIN = "This account has no password yet.";
export const DEMO_NO_LOGIN = "The demo cannot have a username and password.";

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const FAILS_PER_USERNAME = 5;
export const FAILS_PER_ADDRESS = 20;
export const FAIL_USER_KIND = "login_fail_user";
export const FAIL_ADDRESS_KIND = "login_fail_addr";
const KEEP_FAILS_MS = 24 * 60 * 60 * 1000;

const USERNAME = new RegExp(USERNAME_SQL_PATTERN);
/**
 * The `users.settings` key that marks a demo user: `DEMO_FLAG` in src/server/demo/seed.ts. Not
 * imported from there, as that module pulls the whole demo seed (and the Moodle fake) into log in.
 */
const DEMO_FLAG = "demo";

/** The stored form of a typed username (trimmed, lower-case), or null when it breaks the rule. */
export function normalizeUsername(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return USERNAME.test(name) ? name : null;
}

export type AuthResult = { ok: true; userId: string; token: string } | { ok: false; error: string };

type Common = {
  db?: Db;
  /** The clock (tests). */
  now?: Date;
  userAgent?: string | null;
};

/** A new device session for `userId`; returns the token for the cookie. Only its hash is stored. */
export async function startDeviceSession(
  database: Db,
  userId: string,
  opts: { userAgent?: string | null; now?: Date } = {},
): Promise<string> {
  const token = newToken();
  const now = opts.now ?? new Date();
  await database.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    userAgent: opts.userAgent ?? null,
    createdAt: now,
    lastSeenAt: now,
  });
  return token;
}

/** Ends the one device session `token` belongs to (this browser), if any. Other devices stay signed in. */
export async function endDeviceSession(database: Db, token: string | undefined | null): Promise<void> {
  if (!isWellFormedToken(token)) return;
  await database.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/**
 * Makes an account and a device session for it. A taken name gets one plain sentence. `settings`
 * goes on the new user as given (the sign-up screen passes `agreedAt`, M8-33).
 */
export async function signUp(
  username: string,
  password: string,
  opts: Common & { settings?: Record<string, unknown> } = {},
): Promise<AuthResult> {
  const database = opts.db ?? defaultDb;
  const name = normalizeUsername(username);
  if (!name) return { ok: false, error: BAD_USERNAME };
  const problem = passwordProblem(password);
  if (problem) return { ok: false, error: problem };
  const passwordHash = await hashPassword(password);
  const now = opts.now ?? new Date();

  const [created] = await database
    .insert(users)
    .values({ username: name, passwordHash, settings: opts.settings ?? {}, createdAt: now })
    .onConflictDoNothing({ target: users.username })
    .returning({ id: users.id });
  if (!created) return { ok: false, error: TAKEN };
  const token = await startDeviceSession(database, created.id, { userAgent: opts.userAgent, now });
  return { ok: true, userId: created.id, token };
}

const keyFor = (kind: "user" | "addr", value: string) => createHash("sha256").update(`${kind}:${value}`).digest("hex");

let dummy: Promise<string> | undefined;
/** A real hash of a random password nobody knows, so an unknown name costs one scrypt check too. */
function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(24).toString("base64url"));
  return dummy;
}

async function failsSince(database: Db, kind: string, key: string, since: Date): Promise<number> {
  const [row] = await database
    .select({ n: count() })
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "done"),
        gt(jobs.runAfter, since),
        eq(jobs.kind, kind),
        sql`${jobs.payload} ->> 'key' = ${key}`,
      ),
    );
  return row?.n ?? 0;
}

/** The brake's key for a client address, or null when the host reported none. */
function addressKeyOf(raw: string | null | undefined): string | null {
  const address = raw?.trim().toLowerCase().slice(0, 64) || null;
  return address ? keyFor("addr", address) : null;
}

/** True when this name, or this address, has used up its tries for the last 15 minutes. */
async function braked(database: Db, nameKey: string, addressKey: string | null, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - LOGIN_WINDOW_MS);
  if ((await failsSince(database, FAIL_USER_KIND, nameKey, since)) >= FAILS_PER_USERNAME) return true;
  return addressKey !== null && (await failsSince(database, FAIL_ADDRESS_KIND, addressKey, since)) >= FAILS_PER_ADDRESS;
}

/** Counts one failed try for the name (and the address), and drops fails older than a day. */
async function recordFail(database: Db, nameKey: string, addressKey: string | null, now: Date): Promise<void> {
  const fail = (kind: string, key: string) => ({
    kind,
    status: "done" as const,
    payload: { key },
    createdAt: now,
    runAfter: now,
  });
  await database
    .insert(jobs)
    .values([fail(FAIL_USER_KIND, nameKey), ...(addressKey ? [fail(FAIL_ADDRESS_KIND, addressKey)] : [])]);
  await database
    .delete(jobs)
    .where(
      and(
        eq(jobs.status, "done"),
        lt(jobs.runAfter, new Date(now.getTime() - KEEP_FAILS_MS)),
        inArray(jobs.kind, [FAIL_USER_KIND, FAIL_ADDRESS_KIND]),
      ),
    );
}

/** A right password: this name's earlier fails stop counting (the address's stay). */
async function clearNameFails(database: Db, nameKey: string): Promise<void> {
  await database
    .delete(jobs)
    .where(and(eq(jobs.kind, FAIL_USER_KIND), sql`${jobs.payload} ->> 'key' = ${nameKey}`));
}

/**
 * Logs in to an account and makes a device session for it.
 *
 * `address` is the client address the host reports; without one only the per-name limit applies.
 * `verify` is for tests (to see that both paths check a hash).
 */
export async function logIn(
  username: string,
  password: string,
  opts: Common & { address?: string | null; verify?: typeof verifyPassword } = {},
): Promise<AuthResult> {
  const database = opts.db ?? defaultDb;
  const verify = opts.verify ?? verifyPassword;
  const now = opts.now ?? new Date();
  // Not checked against the rule here: a malformed name takes the same path as an unknown one.
  const name = username.trim().toLowerCase().slice(0, 64);
  const nameKey = keyFor("user", name);
  const addressKey = addressKeyOf(opts.address);

  if (await braked(database, nameKey, addressKey, now)) return { ok: false, error: TOO_MANY };

  const [row] = await database
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.username, name))
    .limit(1);
  const stored = row?.passwordHash ?? null;
  const matches = await verify(password, stored ?? (await dummyHash()));

  if (!row || !stored || !matches) {
    await recordFail(database, nameKey, addressKey, now);
    return { ok: false, error: NO_MATCH };
  }

  // Right password: this name's earlier fails stop counting.
  await clearNameFails(database, nameKey);
  const token = await startDeviceSession(database, row.id, { userAgent: opts.userAgent, now });
  return { ok: true, userId: row.id, token };
}

/**
 * Where an account lands after log in: Home, or the first run (/school) when it never got past
 * the start of it (no school picked, no Moodle connection, no courses, not seeded). Having no
 * Moodle connection alone is a normal state (M3-57) and still lands on Home.
 */
export async function landingFor(database: Db, userId: string): Promise<"/home" | "/school"> {
  const [user] = await database
    .select({ school: users.school, seeded: sql<boolean>`(${users.settings} ? 'seededFrom')` })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return "/school";
  if (user.school || user.seeded) return "/home";
  const [[conn], [course]] = await Promise.all([
    database.select({ id: moodleConnections.userId }).from(moodleConnections).where(eq(moodleConnections.userId, userId)).limit(1),
    database.select({ id: courses.id }).from(courses).where(eq(courses.userId, userId)).limit(1),
  ]);
  return conn || course ? "/home" : "/school";
}

/**
 * Sets (or changes) the username and password of an existing user. A name held by another user is
 * refused; the password is hashed here and never returned.
 *
 * Two callers:
 * - the seed tool (M3-57): any of the two, on any user, set or changed;
 * - Settings (M5-15), with `firstOnly`: both are required, and only a user with neither a name
 *   nor a password gets them (`HAS_LOGIN` otherwise: no name change once set, and no new
 *   password without the current one, see `changePassword`). A demo is refused. The UPDATE
 *   itself checks the user still has no name, so two saves at once cannot both win.
 */
export async function setLogin(
  database: Db,
  userId: string,
  login: { username?: string; password?: string },
  opts: { firstOnly?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (opts.firstOnly) {
    if (login.username === undefined || login.password === undefined) return { ok: false, error: BAD_USERNAME };
    const [user] = await database
      .select({ username: users.username, passwordHash: users.passwordHash, settings: users.settings })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return { ok: false, error: "That user does not exist." };
    if ((user.settings as Record<string, unknown> | null)?.[DEMO_FLAG] === true) return { ok: false, error: DEMO_NO_LOGIN };
    if (user.username !== null || user.passwordHash !== null) return { ok: false, error: HAS_LOGIN };
  }
  const set: { username?: string; passwordHash?: string } = {};
  if (login.username !== undefined) {
    const name = normalizeUsername(login.username);
    if (!name) return { ok: false, error: BAD_USERNAME };
    const [other] = await database.select({ id: users.id }).from(users).where(eq(users.username, name)).limit(1);
    if (other && other.id !== userId) return { ok: false, error: TAKEN };
    set.username = name;
  }
  if (login.password !== undefined) {
    const problem = passwordProblem(login.password);
    if (problem) return { ok: false, error: problem };
    set.passwordHash = await hashPassword(login.password);
  }
  if (Object.keys(set).length === 0) return { ok: true };
  const where = opts.firstOnly
    ? and(eq(users.id, userId), isNull(users.username), isNull(users.passwordHash))
    : eq(users.id, userId);
  try {
    const updated = await database.update(users).set(set).where(where).returning({ id: users.id });
    if (updated.length === 0) return { ok: false, error: opts.firstOnly ? HAS_LOGIN : "That user does not exist." };
  } catch (err) {
    // A parallel run took the name between the check and the update.
    const e = err as { code?: string; cause?: { code?: string } };
    if (e.code === "23505" || e.cause?.code === "23505") return { ok: false, error: TAKEN };
    throw err;
  }
  return { ok: true };
}

/**
 * Changes the password of a user that has a login (M5-15), after checking the current one behind
 * the log-in brake: refused with `TOO_MANY` while the name (or the address) is braked, without
 * checking anything; a wrong current password counts as a failed log-in try for that name (and
 * address) and gets `WRONG_CURRENT`; the right one clears the name's count. A new password that
 * breaks the rule is refused before the current one is checked, so it costs no try. Other device
 * sessions stay signed in.
 */
export async function changePassword(
  database: Db,
  userId: string,
  current: string,
  next: string,
  opts: { now?: Date; address?: string | null; verify?: typeof verifyPassword } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const verify = opts.verify ?? verifyPassword;
  const now = opts.now ?? new Date();
  const [user] = await database
    .select({ username: users.username, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.username || !user.passwordHash) return { ok: false, error: NO_LOGIN };
  const nameKey = keyFor("user", user.username);
  const addressKey = addressKeyOf(opts.address);

  if (await braked(database, nameKey, addressKey, now)) return { ok: false, error: TOO_MANY };
  const problem = passwordProblem(next);
  if (problem) return { ok: false, error: problem };
  if (!(await verify(current, user.passwordHash))) {
    await recordFail(database, nameKey, addressKey, now);
    return { ok: false, error: WRONG_CURRENT };
  }
  await clearNameFails(database, nameKey);
  // Only over the hash just checked: a change made in between is not overwritten.
  const updated = await database
    .update(users)
    .set({ passwordHash: await hashPassword(next) })
    .where(and(eq(users.id, userId), eq(users.passwordHash, user.passwordHash)))
    .returning({ id: users.id });
  if (updated.length === 0) return { ok: false, error: WRONG_CURRENT };
  return { ok: true };
}
