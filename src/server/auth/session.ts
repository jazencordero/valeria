/*
 * Device sessions: every visitor gets a user row without signing up.
 *
 * The browser holds a random token in the httpOnly `ready_session` cookie;
 * the database holds only `sha256(token)`. `src/proxy.ts` mints the cookie
 * before render (Server Components cannot set cookies); `ensureSession()`
 * creates the `users` and `sessions` rows the first time a token is seen.
 *
 * Every function here has a core that takes a `Db` (and a token) so tests can
 * run it against `createTestDb()` with no Next request. The thin wrappers
 * without the `For` suffix read and write the real cookie through `cookies()`.
 */
import { createHash, randomBytes } from "node:crypto";
import { eq, sql, TransactionRollbackError, type SQL } from "drizzle-orm";
import { getTableConfig, PgTable, type PgColumn } from "drizzle-orm/pg-core";
import { cookies } from "next/headers";
import { db as defaultDb, schema, type Db } from "@/server/db/client";
import { sessions, users } from "@/server/db/schema/users";

export const SESSION_COOKIE = "ready_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const TOUCH_EVERY_MS = 60 * 60 * 1000;
/** 32 random bytes as base64url, no padding. Same shape `src/proxy.ts` mints. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const sessionCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV !== "development",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_MAX_AGE_SECONDS,
});

export type User = typeof users.$inferSelect;

export class NotSignedIn extends Error {
  constructor() {
    super("No valid ready_session cookie.");
    this.name = "NotSignedIn";
  }
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isWellFormedToken(token: string | undefined | null): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

async function findSession(database: Db, token: string) {
  const [row] = await database
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hashToken(token)))
    .limit(1);
  return row ?? null;
}

export type EnsuredSession = {
  user: User;
  token: string;
  /** True when this call minted the token (the caller must set the cookie). */
  newToken: boolean;
};

/**
 * Returns the user for `token`, creating a user and a session for it when the
 * token is missing, malformed or unknown. A malformed or missing token is
 * replaced by a fresh one (`newToken: true`); an unknown well-formed token is
 * kept, because the proxy has already put it in her browser.
 */
export async function ensureSessionFor(
  database: Db,
  token: string | undefined,
  opts: { userAgent?: string | null } = {},
): Promise<EnsuredSession> {
  if (isWellFormedToken(token)) {
    const found = await findSession(database, token);
    if (found) return { user: found.user, token, newToken: false };
  }
  const minted = !isWellFormedToken(token);
  const useToken = minted ? newToken() : token;
  const tokenHash = hashToken(useToken);

  const created = await database.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({}).returning();
    const inserted = await tx
      .insert(sessions)
      .values({ userId: user.id, tokenHash, userAgent: opts.userAgent ?? null })
      .onConflictDoNothing({ target: sessions.tokenHash })
      .returning({ id: sessions.id });
    if (inserted.length === 0) {
      // A parallel request created this token's session first. Undo our user.
      tx.rollback();
    }
    return user;
  }).catch((err: unknown) => {
    if (err instanceof TransactionRollbackError) return null;
    throw err;
  });

  if (created) return { user: created, token: useToken, newToken: minted };
  const winner = await findSession(database, useToken);
  if (!winner) throw new Error("Session vanished right after a parallel insert.");
  return { user: winner.user, token: useToken, newToken: minted };
}

/**
 * The signed-in user for `token`, or throws `NotSignedIn`. Moves the
 * session's `last_seen_at` forward at most once an hour.
 */
export async function currentUserFor(
  database: Db,
  token: string | undefined,
  now: Date = new Date(),
): Promise<User> {
  if (!isWellFormedToken(token)) throw new NotSignedIn();
  const found = await findSession(database, token);
  if (!found) throw new NotSignedIn();
  if (now.getTime() - found.session.lastSeenAt.getTime() >= TOUCH_EVERY_MS) {
    await database
      .update(sessions)
      .set({ lastSeenAt: now })
      .where(eq(sessions.id, found.session.id));
  }
  return found.user;
}

/** Deletes every session of `userId`; each device gets a new user next visit. */
export async function signOutEverywhere(userId: string, database: Db = defaultDb): Promise<void> {
  await database.delete(sessions).where(eq(sessions.userId, userId));
}

/* ------------------------------------------------------------------------- */
/* Cookie wrappers (need a Next request).                                    */
/* ------------------------------------------------------------------------- */

/**
 * The visitor's user, created on first sight. Call from a Server Component,
 * Server Function or Route Handler. The proxy normally sets the cookie; if it
 * did not run for this request, a new token is set here when Next allows it
 * (Server Functions and Route Handlers). In a Server Component that set is
 * not allowed and is skipped; the proxy sets a cookie on the next request.
 */
export async function ensureSession(): Promise<User> {
  const store = await cookies();
  const result = await ensureSessionFor(defaultDb, store.get(SESSION_COOKIE)?.value);
  if (result.newToken) {
    try {
      store.set(SESSION_COOKIE, result.token, sessionCookieOptions());
    } catch {
      // Server Component render: cookies are read-only here.
    }
  }
  return result.user;
}

/** The signed-in user, or throws `NotSignedIn`. */
export async function currentUser(): Promise<User> {
  const store = await cookies();
  return currentUserFor(defaultDb, store.get(SESSION_COOKIE)?.value);
}

/* ------------------------------------------------------------------------- */
/* Merging two users.                                                        */
/* ------------------------------------------------------------------------- */

type TableInfo = {
  name: string;
  /** The `user_id` column, if the table has one. */
  userIdColumn: string | null;
  /** Every unique key (constraint, unique column, unique index) as column names. */
  uniqueKeys: string[][];
  /** Single-column foreign keys: this table's column -> other table's `id`. */
  foreignKeys: { column: string; references: string }[];
};

function describeSchema(): TableInfo[] {
  const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => v instanceof PgTable);
  return tables.map((table) => {
    const c = getTableConfig(table);
    const names = (cols: PgColumn[]) => cols.map((col) => col.name);
    const uniqueKeys = [
      ...c.uniqueConstraints.map((u) => names(u.columns)),
      ...c.columns.filter((col) => col.isUnique).map((col) => [col.name]),
      ...c.indexes
        .filter((i) => i.config.unique)
        .map((i) => i.config.columns.map((col) => (col as PgColumn).name)),
    ];
    const foreignKeys = c.foreignKeys.flatMap((fk) => {
      const ref = fk.reference();
      if (ref.columns.length !== 1 || ref.foreignColumns[0]?.name !== "id") return [];
      return [{ column: ref.columns[0].name, references: getTableConfig(ref.foreignTable).name }];
    });
    const userIdColumn = c.columns.some((col) => col.name === "user_id") ? "user_id" : null;
    return { name: c.name, userIdColumn, uniqueKeys, foreignKeys };
  });
}

type Pair = { src: string; dst: string };

const id = (name: string) => sql.identifier(name);

function pairsValues(pairs: Pair[]): SQL {
  return sql.join(
    pairs.map((p) => sql`(${p.src}::uuid, ${p.dst}::uuid)`),
    sql`, `,
  );
}

async function rows<T>(database: Db, query: SQL): Promise<T[]> {
  const result = (await database.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

/**
 * Moves every row owned by `fromId` to `intoId` in one transaction, then
 * deletes `fromId`. Used when she connects MyCourses on a second device.
 *
 * Tables are found from the schema: every table with a `user_id` column, so
 * tables added later are covered without touching this function.
 *
 * Conflict policy: where both users own a row with the same unique key (for
 * example the same Moodle course, or the one `moodle_connections` row per
 * user), the TARGET's row is kept and the SOURCE's row is dropped. Before a
 * source row is dropped, every row that points at it (from any table, with or
 * without `user_id`) is re-pointed to the target's twin, applying the same
 * rule one level down (e.g. her notes on a duplicate lecture move to the kept
 * lecture; a duplicate `card_states` row is dropped). So nothing is lost
 * through ON DELETE CASCADE / SET NULL, only exact duplicates are dropped.
 *
 * The target's profile wins too; empty fields are filled from the source and
 * settings are merged with the target's values on top.
 *
 * The login (M5-14): when the target has no username, it takes the source's
 * username and password hash, as a pair (a name without its password, or the
 * other way round, opens nothing). When both have a username, the target keeps
 * its own and the source's username and password go with the source: that
 * login stops working. Usernames are unique, so the source's are cleared
 * before the target takes them.
 */
export async function mergeUsers(fromId: string, intoId: string, database: Db = defaultDb) {
  if (fromId === intoId) throw new Error("mergeUsers: fromId and intoId are the same user.");
  const tables = describeSchema();

  await database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const both = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.id} in (${fromId}::uuid, ${intoId}::uuid)`);
    if (both.length !== 2) throw new Error("mergeUsers: both users must exist.");

    /** A column's value as it will be after the merge (user_id: from -> into). */
    const after = (alias: string, table: TableInfo, column: string): SQL =>
      column === table.userIdColumn
        ? sql`(case when ${id(alias)}.${id(column)} = ${fromId}::uuid then ${intoId}::uuid else ${id(alias)}.${id(column)} end)`
        : sql`${id(alias)}.${id(column)}`;

    const sameOn = (table: TableInfo, columns: string[]): SQL =>
      sql.join(
        columns.map((col) => sql`${after("s", table, col)} = ${after("d", table, col)}`),
        sql` and `,
      );

    /**
     * Re-points everything that references the `src` rows of `table` to the
     * matching `dst` rows, recursively, then deletes the `src` rows.
     */
    const dropInFavourOf = async (table: TableInfo, pairs: Pair[]): Promise<void> => {
      if (pairs.length === 0) return;
      for (const child of tables) {
        for (const fk of child.foreignKeys) {
          if (fk.references !== table.name) continue;
          const childPairs = new Map<string, string>();
          for (const key of child.uniqueKeys) {
            if (!key.includes(fk.column)) continue;
            const others = key.filter((col) => col !== fk.column);
            const found = await rows<Pair>(
              tx,
              sql`select s.id as src, d.id as dst
                  from ${id(child.name)} s
                  join (values ${pairsValues(pairs)}) as m(src, dst) on s.${id(fk.column)} = m.src
                  join ${id(child.name)} d on d.${id(fk.column)} = m.dst
                    ${others.length ? sql`and ${sameOn(child, others)}` : sql``}`,
            );
            for (const p of found) if (!childPairs.has(p.src)) childPairs.set(p.src, p.dst);
          }
          await dropInFavourOf(
            child,
            [...childPairs].map(([src, dst]) => ({ src, dst })),
          );
          await tx.execute(
            sql`update ${id(child.name)} c set ${id(fk.column)} = m.dst
                from (values ${pairsValues(pairs)}) as m(src, dst)
                where c.${id(fk.column)} = m.src`,
          );
        }
      }
      await tx.execute(
        sql`delete from ${id(table.name)}
            where id in (select src from (values ${pairsValues(pairs)}) as m(src, dst))`,
      );
    };

    // 1. Drop the source's duplicates of rows the target already has.
    for (const table of tables) {
      const userCol = table.userIdColumn;
      if (!userCol || table.name === "users") continue;
      const conflicts = new Map<string, string>();
      for (const key of table.uniqueKeys) {
        if (!key.includes(userCol)) continue;
        const found = await rows<Pair>(
          tx,
          sql`select s.id as src, d.id as dst
              from ${id(table.name)} s
              join ${id(table.name)} d
                on s.${id(userCol)} = ${fromId}::uuid
               and d.${id(userCol)} = ${intoId}::uuid
               and ${sameOn(table, key)}`,
        );
        for (const p of found) if (!conflicts.has(p.src)) conflicts.set(p.src, p.dst);
      }
      await dropInFavourOf(
        table,
        [...conflicts].map(([src, dst]) => ({ src, dst })),
      );
    }

    // 2. Move everything that is left.
    for (const table of tables) {
      if (!table.userIdColumn || table.name === "users") continue;
      await tx.execute(
        sql`update ${id(table.name)} set ${id(table.userIdColumn)} = ${intoId}::uuid
            where ${id(table.userIdColumn)} = ${fromId}::uuid`,
      );
    }

    // 3. The login: the target takes the source's username and password when it has none.
    const [from] = await tx
      .select({ username: users.username, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, fromId));
    const [into] = await tx.select({ username: users.username }).from(users).where(eq(users.id, intoId));
    if (from?.username && !into?.username) {
      await tx.update(users).set({ username: null, passwordHash: null }).where(eq(users.id, fromId));
      await tx
        .update(users)
        .set({ username: from.username, passwordHash: from.passwordHash })
        .where(eq(users.id, intoId));
    }

    // 4. Keep the target's profile, fill its gaps from the source, drop the source.
    await tx.execute(
      sql`update users t set
            display_name = coalesce(t.display_name, f.display_name),
            school = coalesce(t.school, f.school),
            settings = f.settings || t.settings
          from users f
          where t.id = ${intoId}::uuid and f.id = ${fromId}::uuid`,
    );
    await tx.delete(users).where(eq(users.id, fromId));
  });
}
