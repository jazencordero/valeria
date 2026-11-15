import { sql, type SQL } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/*
 * Shared column helpers for every schema file. Value sets ('a' | 'b') are
 * plain `text` columns typed with `enum` plus a CHECK constraint built by
 * `oneOf`; we do not use pgEnum anywhere.
 */

/** `id uuid primary key default gen_random_uuid()` */
export const id = () => uuid("id").primaryKey().defaultRandom();

/** `created_at timestamptz not null default now()` */
export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** A `timestamptz` column; every time in the schema uses this. */
export const tstz = (name: string) => timestamp(name, { withTimezone: true });

/** `user_id uuid not null references users(id) on delete cascade` */
export const userId = () =>
  uuid("user_id")
    .notNull()
    .references((): AnyPgColumn => users.id, { onDelete: "cascade" });

/** CHECK (column IN ('a', 'b', ...)). NULL passes, so nullable sets work too. */
export function oneOf(name: string, column: AnyPgColumn, values: readonly string[]) {
  const list: SQL = sql.join(
    values.map((v) => sql.raw(`'${v.replace(/'/g, "''")}'`)),
    sql`, `,
  );
  return check(name, sql`${column} in (${list})`);
}

/** 3 to 32 of a-z 0-9 . _ - (M5-14). Stored lower-case; `normalizeUsername` in src/server/auth/accounts.ts. */
export const USERNAME_SQL_PATTERN = "^[a-z0-9._-]{3,32}$";

export const users = pgTable(
  "users",
  {
    id: id(),
    createdAt: createdAt(),
    displayName: text("display_name"),
    school: text("school"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    /** Null for a device-only visitor (no account). Unique, lower-case (M5-14). */
    username: text("username").unique(),
    /** `scrypt$N$r$p$salt$hash` from src/server/auth/password.ts. Never logged. */
    passwordHash: text("password_hash"),
  },
  (t) => [check("users_username_check", sql`${t.username} ~ ${sql.raw(`'${USERNAME_SQL_PATTERN}'`)}`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    tokenHash: text("token_hash").notNull().unique(),
    lastSeenAt: tstz("last_seen_at").notNull().defaultNow(),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const identities = pgTable(
  "identities",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    kind: text("kind").notNull(),
    siteUrl: text("site_url").notNull(),
    externalId: text("external_id").notNull(),
  },
  (t) => [
    index("identities_user_id_idx").on(t.userId),
    unique("identities_kind_site_external_key").on(t.kind, t.siteUrl, t.externalId),
  ],
);

export const confirmCodes = pgTable(
  "confirm_codes",
  {
    id: id(),
    createdAt: createdAt(),
    userId: userId(),
    purpose: text("purpose").notNull(),
    payloadHash: text("payload_hash").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    usedAt: tstz("used_at"),
  },
  (t) => [index("confirm_codes_user_id_idx").on(t.userId)],
);
