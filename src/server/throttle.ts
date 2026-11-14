/*
 * A small brake on repeated tries, per visitor (M1-43). No table of its own.
 *
 *   allow(key, { max, perSeconds }, { userId?, db?, now? }) -> true | false
 *
 * True means "go ahead", and the try is counted. False means the limit is
 * reached; nothing is counted and the caller must not do the work.
 *
 * Who is counted: the visitor. Every visitor has a user row, made from their
 * session cookie when they first arrive (`ensureSessionFor`), so the session's
 * user id is the visitor. Pass it as `userId` and the count lives in that
 * user's `users.settings.throttle[key] = { start, count }` (start in epoch ms).
 * Without a `userId` (or when that user row does not exist), the count lives
 * in this server instance's memory, keyed by `key` alone, so the caller must
 * then put the session id into `key` itself.
 *
 * The window is fixed and starts at the first counted try: `max` tries until
 * `perSeconds` have passed since that try, then the count starts over. Two
 * limits on one action (5 a minute and 30 a day) are two keys.
 *
 * Choices and limits:
 * - The database count is one UPDATE ... WHERE (window over OR count < max)
 *   RETURNING, so two requests at once cannot both take the last try.
 * - Memory is per server instance. On serverless hosting each instance has its
 *   own memory and a cold start forgets it, so the memory path is a weak
 *   brake only; real visitors always have a user row and use the database.
 * - A visitor who throws away their cookie gets a new user and a fresh count.
 *   Per-address limits are cut (the hosting proxy hides addresses), so this
 *   brakes a careless or casual guesser, not a determined one with many
 *   sessions. Moodle's own limits stay behind it.
 * - When two devices are merged into one user, the survivor keeps its own
 *   counts; the merged user's counts go with it.
 */
import { and, eq, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { users } from "@/server/db/schema/users";

export type Limit = {
  /** Tries allowed per window. */
  max: number;
  /** Window length in seconds. */
  perSeconds: number;
};

export type AllowOptions = {
  /** The visitor's user id (from the session). Counts go in `users.settings` when given. */
  userId?: string | null;
  db?: Db;
  /** Epoch ms; defaults to `Date.now()`. */
  now?: number;
};

type Entry = { start: number; count: number };

const memory = new Map<string, Entry>();

/** Forget every count kept in memory (tests). */
export function resetThrottle(): void {
  memory.clear();
}

function allowInMemory(key: string, limit: Limit, now: number): boolean {
  const windowMs = limit.perSeconds * 1000;
  const entry = memory.get(key);
  if (!entry || now - entry.start >= windowMs) {
    memory.set(key, { start: now, count: 1 });
    return true;
  }
  if (entry.count >= limit.max) return false;
  entry.count += 1;
  return true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function allowInDb(userId: string, key: string, limit: Limit, now: number, database: Db): Promise<boolean | null> {
  const windowMs = limit.perSeconds * 1000;
  const entry = sql`(${users.settings} -> 'throttle' -> ${key}::text)`;
  const count = sql`coalesce((${entry} ->> 'count')::int, 0)`;
  const over = sql`(${entry} is null or ${now}::bigint - coalesce((${entry} ->> 'start')::bigint, 0) >= ${windowMs}::bigint)`;
  const next = sql`case when ${over}
    then jsonb_build_object('start', ${now}::bigint, 'count', 1)
    else jsonb_build_object('start', (${entry} ->> 'start')::bigint, 'count', ${count} + 1) end`;
  const rows = await database
    .update(users)
    .set({
      settings: sql`jsonb_set(
        jsonb_set(${users.settings}, '{throttle}', coalesce(${users.settings} -> 'throttle', '{}'::jsonb)),
        array['throttle', ${key}::text], ${next})`,
    })
    .where(and(eq(users.id, userId), sql`(${over} or ${count} < ${limit.max}::int)`))
    .returning({ id: users.id });
  if (rows.length > 0) return true;
  const [exists] = await database.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  return exists ? false : null;
}

/** Counts one try against `key` and says whether it may go ahead. */
export async function allow(key: string, limit: Limit, options: AllowOptions = {}): Promise<boolean> {
  const now = options.now ?? Date.now();
  if (!(limit.max > 0) || !(limit.perSeconds > 0)) return false;
  if (options.userId && UUID.test(options.userId)) {
    const inDb = await allowInDb(options.userId, key, limit, now, options.db ?? defaultDb);
    if (inDb !== null) return inDb;
  }
  const memKey = options.userId ? `${options.userId}|${key}` : key;
  return allowInMemory(memKey, limit, now);
}
