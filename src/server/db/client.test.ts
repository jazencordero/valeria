// @vitest-environment node
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalDb } from "./client";

// Counts real migration runs. Hoisted, so it survives vi.resetModules().
const counts = vi.hoisted(() => ({ migrate: 0 }));
vi.mock("drizzle-orm/pglite/migrator", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm/pglite/migrator")>();
  const migrate: typeof real.migrate = (...args) => {
    counts.migrate++;
    return real.migrate(...args);
  };
  return { ...real, migrate };
});

const REPO = process.cwd();
const SLOT = Symbol.for("ready.server.db.local");
const slot = globalThis as { [SLOT]?: LocalDb };

// A stand-in project root in the temp folder, with PGLITE_DIR pointing into it, so nothing
// is created in the repository or in the real cache folder. `drizzle` points at the real migrations.
let root: string;
let dataDir: string;
let lockPath: string;
let savedUrl: string | undefined;
let savedDir: string | undefined;
const children: ChildProcess[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ready-db-client-"));
  symlinkSync(path.join(REPO, "drizzle"), path.join(root, "drizzle"), "dir");
  dataDir = path.join(root, "db", "pglite");
  lockPath = `${dataDir}.lock`;
  savedDir = process.env.PGLITE_DIR;
  process.env.PGLITE_DIR = dataDir;
  vi.spyOn(process, "cwd").mockReturnValue(root);
  savedUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  counts.migrate = 0;
  vi.resetModules();
});

afterEach(async () => {
  await slot[SLOT]?.close();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  vi.restoreAllMocks();
  if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
  if (savedDir !== undefined) process.env.PGLITE_DIR = savedDir;
  else delete process.env.PGLITE_DIR;
  rmSync(root, { recursive: true, force: true });
});

/** A separate process that stays alive until killed. */
async function otherProcess(): Promise<{ pid: number; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const stop = () =>
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
  return { pid: child.pid as number, stop };
}

describe("local database: one PGlite per process", () => {
  it("gives two concurrent first calls the same instance and migrates once", async () => {
    const { openLocalDb } = await import("./client");

    const [a, b] = await Promise.all([
      Promise.resolve().then(() => openLocalDb()),
      Promise.resolve().then(() => openLocalDb()),
    ]);

    expect(a).toBe(b);
    expect(a.client).toBe(b.client);
    expect(a.ready).toBe(b.ready);
    expect(a.dataDir).toBe(dataDir);
    await a.ready;
    expect(counts.migrate).toBe(1);
    // The migrations really ran: a table from the schema is there.
    const tables = await a.client.query<{ n: number }>(
      "select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'users'",
    );
    expect(tables.rows[0].n).toBe(1);
  });

  it("reuses the instance when the module is evaluated a second time", async () => {
    // What `next dev` does: route handlers and pages each get their own copy
    // of the module, in one process.
    const first = await import("./client");
    await first.db.execute(sql`create table probe (v text not null)`);
    await first.db.execute(sql`insert into probe (v) values ('written by the first copy')`);
    const opened = slot[SLOT];
    expect(opened).toBeDefined();

    vi.resetModules();
    const second = await import("./client");
    expect(second.db).not.toBe(first.db); // really a second evaluation

    const read = (await second.db.execute(sql`select v from probe`)) as unknown as { rows: { v: string }[] };
    expect(read.rows).toEqual([{ v: "written by the first copy" }]);
    expect(slot[SLOT]).toBe(opened);
    expect(second.openLocalDb().client).toBe(first.openLocalDb().client);
    expect(counts.migrate).toBe(1);
  });

  it("refuses to open while another running process holds the lock", async () => {
    const other = await otherProcess();
    const { openLocalDb, db } = await import("./client");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${other.pid}\n`);

    expect(() => openLocalDb()).toThrow(/Another dev process holds the local database/);
    expect(() => db.select).toThrow(/Another dev process holds the local database/);
    expect(slot[SLOT]).toBeUndefined();
    expect(counts.migrate).toBe(0);
    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(other.pid)); // left alone
    expect(existsSync(path.join(dataDir, "PG_VERSION"))).toBe(false); // nothing was opened

    // Once that process is gone the same call succeeds: the failure is not remembered.
    await other.stop();
    const local = openLocalDb();
    await local.ready;
    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
  });

  it("takes over a lock whose process is no longer running, and gives it back on close", async () => {
    const other = await otherProcess();
    await other.stop();
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${other.pid}\n`);

    const { openLocalDb } = await import("./client");
    const local = openLocalDb();
    await local.ready;

    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
    expect(counts.migrate).toBe(1);

    await local.close();
    expect(existsSync(lockPath)).toBe(false);
    expect(slot[SLOT]).toBeUndefined();
  });
});

describe("localDbDir", () => {
  const HOME = "/Users/someone";

  it("is outside the project root, under the home cache folder", async () => {
    const { localDbDir } = await import("./client");
    const project = "/work/ready";
    const dir = localDbDir(project, {}, HOME);
    expect(dir).toMatch(/^\/Users\/someone\/\.cache\/ready\/pglite-[0-9a-f]{12}$/);
    expect(path.relative(project, dir).startsWith("..")).toBe(true);
  });

  it("lets PGLITE_DIR win, and reads a relative one from the project root", async () => {
    const { localDbDir } = await import("./client");
    expect(localDbDir("/work/ready", { PGLITE_DIR: "/tmp/elsewhere/db" }, HOME)).toBe("/tmp/elsewhere/db");
    expect(localDbDir("/work/ready", { PGLITE_DIR: "  ../db  " }, HOME)).toBe("/work/db");
    // Empty or blank counts as not set.
    expect(localDbDir("/work/ready", { PGLITE_DIR: "  " }, HOME)).toBe(localDbDir("/work/ready", {}, HOME));
  });

  it("gives two project paths two folders, and one path the same folder every time", async () => {
    const { localDbDir } = await import("./client");
    const main = localDbDir("/work/ready", {}, HOME);
    const worktree = localDbDir("/work/ready/.claude/worktrees/one", {}, HOME);
    expect(main).not.toBe(worktree);
    expect(localDbDir("/work/ready/", {}, HOME)).toBe(main);
  });

  it("opens the database where PGLITE_DIR says, and says once that the old in-project one is not used", async () => {
    mkdirSync(path.join(root, ".data", "pglite"), { recursive: true });
    const said = vi.spyOn(console, "log").mockImplementation(() => {});
    const { openLocalDb } = await import("./client");
    const local = openLocalDb();
    await local.ready;
    expect(local.dataDir).toBe(dataDir);
    expect(existsSync(path.join(dataDir, "PG_VERSION"))).toBe(true);
    expect(existsSync(path.join(root, ".data", "pglite", "PG_VERSION"))).toBe(false);
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0][0])).toContain(dataDir);
    // Open again (the folder exists now): nothing more is said.
    await local.close();
    await openLocalDb().ready;
    expect(said).toHaveBeenCalledTimes(1);
  });
});
