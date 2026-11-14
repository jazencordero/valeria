/*
 * The one database handle for server code: `import { db } from "@/server/db/client"`.
 *
 * - DATABASE_URL set: Neon serverless driver (WebSocket Pool, so transactions
 *   behave the same as on PGlite). Migrations are not run from here; they
 *   are applied to Neon with `npm run db:migrate`.
 * - DATABASE_URL unset: PGlite stored in `.data/pglite`. The migrations in
 *   `./drizzle` are applied on first use; every query waits for them.
 *
 * Nothing is opened at import time. The driver is created the first time
 * `db` is touched, so `next build` can import this module with no database.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as calendar from "./schema/calendar";
import * as courses from "./schema/courses";
import * as grades from "./schema/grades";
import * as learn from "./schema/learn";
import * as moodle from "./schema/moodle";
import * as study from "./schema/study";
import * as system from "./schema/system";
import * as users from "./schema/users";
import * as work from "./schema/work";

if (typeof window !== "undefined") {
  throw new Error("src/server/db/client.ts is server-only; it must not be imported by client code.");
}

export const schema = {
  ...users,
  ...moodle,
  ...courses,
  ...work,
  ...calendar,
  ...grades,
  ...study,
  ...learn,
  ...system,
};
export type Schema = typeof schema;

/** What both drivers share. Write queries against this type. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");
const PGLITE_DIR = path.join(process.cwd(), ".data", "pglite");

/**
 * Wraps a PGlite client so every query first waits for `ready`. The migrator
 * itself is handed the raw client, so it is never blocked by the gate.
 */
export function gateUntil(client: PGlite, ready: Promise<unknown>): PGlite {
  const gated = new Set<PropertyKey>(["query", "exec", "transaction", "sql"]);
  return new Proxy(client, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (!gated.has(prop)) return fn.bind(target);
      return async (...args: unknown[]) => {
        await ready;
        return fn.apply(target, args);
      };
    },
  });
}

function openPglite(): Db {
  mkdirSync(PGLITE_DIR, { recursive: true });
  const client = new PGlite(PGLITE_DIR);
  const ready = migrate(drizzlePglite({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
  // Surface a broken migration on every query rather than as an unhandled rejection.
  ready.catch(() => {});
  return drizzlePglite({ client: gateUntil(client, ready), schema }) as unknown as Db;
}

function openNeon(url: string): Db {
  return drizzleNeon({ client: new Pool({ connectionString: url }), schema }) as unknown as Db;
}

let instance: Db | undefined;

function getDb(): Db {
  if (!instance) {
    const url = process.env.DATABASE_URL;
    instance = url ? openNeon(url) : openPglite();
  }
  return instance;
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getDb();
    const value: unknown = Reflect.get(real, prop, real);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});
