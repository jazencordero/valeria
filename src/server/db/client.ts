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
 *
 * One PGlite per process, one process per data folder (M1-49):
 * - `next dev` evaluates this module more than once inside its one server
 *   process (route handlers and pages are bundled apart; hot reload evaluates
 *   it again). Measured on Next 16.4.6: a route handler and a page reported
 *   the same process id but two different module instances. A module-level
 *   variable is therefore not a singleton, and two PGlite instances on one
 *   folder do not see each other's writes and can corrupt it. So the open
 *   client and its migration promise live on `globalThis`.
 * - A second process (another dev server, a script) is kept out by a lock
 *   file next to the data folder, `.data/pglite.lock`, holding the owner's
 *   process id. A lock whose owner is no longer running is taken over.
 */
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

/** The open local database of this process. Lives on `globalThis`. */
export type LocalDb = {
  dataDir: string;
  /** The raw client. Use `db` for queries; this one does not wait for migrations. */
  client: PGlite;
  /** Settles when the migrations have been applied (or rejects if one failed). */
  ready: Promise<void>;
  /** Closes the client and gives the lock back. */
  close: () => Promise<void>;
};

// Symbol.for is shared by every copy of this module in the process.
const LOCAL_DB = Symbol.for("ready.server.db.local");
type GlobalSlot = { [LOCAL_DB]?: LocalDb };
const slot = globalThis as GlobalSlot;

function lockPathFor(dataDir: string): string {
  return `${dataDir}.lock`;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: only asks whether the process exists
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else. Anything else: gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes `<dataDir>.lock` for this process or throws. The file is written
 * whole and then linked into place, so it is never seen half written.
 * Returns the function that gives the lock back.
 */
function takeLock(dataDir: string): () => void {
  const lockPath = lockPathFor(dataDir);
  const mine = `${lockPath}.${process.pid}.tmp`;
  writeFileSync(mine, `${process.pid}\n`);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        linkSync(mine, lockPath); // fails with EEXIST if someone holds it
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      let owner = Number.NaN;
      try {
        owner = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
      } catch {
        // Gone again between the two calls: try once more.
      }
      if (owner === process.pid) break; // ours already (left by a closed copy in this process)
      if (Number.isInteger(owner) && owner > 0 && isRunning(owner)) {
        throw new Error(
          `Another dev process holds the local database (process ${owner}, lock file ${lockPath}). ` +
            "Stop that process first. Two writers on one PGlite folder corrupt it.",
        );
      }
      if (attempt >= 3) throw new Error(`Could not take the local database lock ${lockPath}.`);
      // The owner is not running any more (or the file is unreadable): take over.
      try {
        unlinkSync(lockPath);
      } catch {
        // Someone else removed it first.
      }
    }
  } finally {
    unlinkSync(mine);
  }

  const release = () => {
    process.off("exit", release);
    try {
      if (Number.parseInt(readFileSync(lockPath, "utf8"), 10) === process.pid) unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  };
  process.once("exit", release);
  return release;
}

/**
 * Opens the local PGlite once per process and applies the migrations once.
 * Every later call, from any copy of this module, gets the same object, so
 * concurrent first calls cannot race: the client and the `ready` promise are
 * stored before anything is awaited.
 *
 * Throws "Another dev process holds the local database" if a running process
 * other than this one holds the lock.
 */
export function openLocalDb(
  dataDir: string = PGLITE_DIR,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): LocalDb {
  const open = slot[LOCAL_DB];
  if (open) {
    if (open.dataDir !== dataDir) {
      throw new Error(`The local database is already open at ${open.dataDir}; cannot also open ${dataDir}.`);
    }
    return open;
  }

  mkdirSync(dataDir, { recursive: true });
  const release = takeLock(dataDir);
  let client: PGlite;
  try {
    client = new PGlite(dataDir);
  } catch (err) {
    release();
    throw err;
  }
  const ready = migrate(drizzlePglite({ client }), { migrationsFolder });
  // Surface a broken migration on every query rather than as an unhandled rejection.
  ready.catch(() => {});

  const local: LocalDb = {
    dataDir,
    client,
    ready,
    close: async () => {
      if (slot[LOCAL_DB] === local) delete slot[LOCAL_DB];
      try {
        await ready.catch(() => {});
        await client.close();
      } finally {
        release();
      }
    },
  };
  slot[LOCAL_DB] = local;
  return local;
}

function openPglite(): Db {
  // The client is shared by the whole process; the drizzle wrapper is made per
  // copy of this module, so a hot-reloaded schema is the one that is used.
  const { client, ready } = openLocalDb();
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
