/*
 * M3-57: seed one student's whole account from files, with no Moodle sign-in.
 *
 *   npx tsx scripts/study/seed-account.ts <account-dir> <bundles-dir> [--name <first name>] [--username <name>] [--set-password] [--dry-run] [--origin <url>]
 *   npx tsx scripts/study/seed-account.ts <account-dir> --link [--username <name>] [--set-password] [--origin <url>]
 *
 * The work is done by src/server/study/seed-account.ts (see there for the input shapes and
 * the matching rules). This file only reads the arguments and prints.
 *
 * Privacy: her folders are read in place, never copied. The printed one-time code is never
 * written to disk; the database keeps only its sha256.
 *
 * Log in (M5-14): `--username <name>` gives the seeded user that username and, when it has no
 * password yet, asks for one at a hidden prompt (twice, never echoed, never an argument, never
 * printed); only its scrypt hash is stored. `--set-password` asks for a new one on a later run.
 * A run with `--username` for a user that already has a password keeps the password.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Db, LocalDb } from "@/server/db/client";
import { BundleInvalid, ImportFailed, type Count, type ImportProblem } from "@/server/study/import-bundle";
import { BAD_USERNAME, normalizeUsername } from "@/server/auth/accounts";
import { passwordProblem } from "@/server/auth/password";
import {
  applySeed,
  findSeededUser,
  loadSeed,
  mintOpenLink,
  openUrl,
  planSeed,
  seededLoginOf,
  seedKeyFor,
  SeedInvalid,
  SeedRefused,
  setSeededLogin,
  type SeedResult,
} from "@/server/study/seed-account";

export const DEFAULT_ORIGIN = "http://localhost:3000";

export const HELP = `Seed one student's whole account from files, with no Moodle sign-in.

Usage:
  npx tsx scripts/study/seed-account.ts <account-dir> <bundles-dir> [--name <first name>] [--username <name>] [--set-password] [--dry-run] [--origin <url>]
  npx tsx scripts/study/seed-account.ts <account-dir> --link [--username <name>] [--set-password] [--origin <url>]

  <account-dir>   holds account.json (courses, assignments, calendar), as M0-16's pull wrote it
  <bundles-dir>   holds account.json (exams, grade weights, AI rules) and one folder per course
                  with seed.json (the study bundles; study-only ones bring pages only)
  --name          her first name, for the greeting
  --username      the username she logs in with (3 to 32 of a-z 0-9 . _ -); asks for a
                  password at a hidden prompt when the account has none yet
  --set-password  asks for a new password at a hidden prompt (the account needs a username)
  --dry-run       check and count everything, write nothing (no link either)
  --link          only print a fresh one-time link for the student seeded from <account-dir>
  --origin        where the app runs, for the link (default ${DEFAULT_ORIGIN}); give a
                  preview or production origin (https://...) to open it there. The link only
                  works against the database this command wrote to.

The first run creates her user (no Moodle connection); a rerun finds the same user and
updates in place, never duplicating. Everything is one transaction.
The link (/open?code=...) works once, within 15 minutes; rerun with --link for a new one.
The password is never an argument and never printed; only its hash is stored.

Database: DATABASE_URL set uses Neon; unset uses the local PGlite in .data/pglite.
The local database takes a lock file: stop \`next dev\` first.

Exit code: 1 when nothing could be written (bad files, refused) or the username or password
could not be set (the seed itself is kept), else 0, also when some parts were skipped (they
are listed).`;

export type CliArgs = {
  accountDir: string;
  bundlesDir: string | null;
  name?: string;
  dryRun: boolean;
  linkOnly: boolean;
  origin: string;
  /** The username to set (as typed; lowered when stored). */
  username?: string;
  /** Ask for a new password even when the account has one. */
  setPassword: boolean;
};

export type ParsedArgs = { ok: true; args: CliArgs } | { ok: false; help: true } | { ok: false; help: false; error: string };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const dirs: string[] = [];
  let name: string | undefined;
  let origin = DEFAULT_ORIGIN;
  let dryRun = false;
  let linkOnly = false;
  let username: string | undefined;
  let setPassword = false;
  const fail = (error: string): ParsedArgs => ({ ok: false, help: false, error });
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return undefined;
      i += 1;
      return v;
    };
    if (a === "--help" || a === "-h") return { ok: false, help: true };
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--link") linkOnly = true;
    else if (a === "--set-password") setPassword = true;
    else if (a === "--username") {
      username = value()?.trim();
      if (!username) return fail("--username needs a name.");
      if (!normalizeUsername(username)) return fail(`--username: ${BAD_USERNAME}`);
    }
    else if (a === "--name") {
      name = value()?.trim();
      if (!name) return fail("--name needs her first name.");
    } else if (a === "--origin") {
      const v = value();
      if (!v) return fail("--origin needs a URL.");
      let url: URL;
      try {
        url = new URL(v);
      } catch {
        return fail("--origin must be a URL like https://example.com.");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return fail("--origin must start with http:// or https://.");
      origin = url.origin;
    } else if (a.startsWith("--")) return fail(`Unknown option ${a}.`);
    else dirs.push(a);
  }
  if (linkOnly && dryRun) return fail("--link and --dry-run do not go together.");
  if (setPassword && dryRun) return fail("--set-password and --dry-run do not go together.");
  if (dirs.length === 0) return fail("Give <account-dir> and <bundles-dir>.");
  if (dirs.length > 2) return fail("Only <account-dir> and <bundles-dir>, please.");
  if (!linkOnly && dirs.length !== 2) return fail("Give <bundles-dir> too.");
  return {
    ok: true,
    args: {
      accountDir: path.resolve(dirs[0]),
      bundlesDir: dirs[1] ? path.resolve(dirs[1]) : null,
      ...(name ? { name } : {}),
      dryRun,
      linkOnly,
      origin,
      ...(username ? { username } : {}),
      setPassword,
    },
  };
}

export type Io = {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Reads one line without showing it (the password). Tests pass their own. */
  askHidden?: (question: string) => Promise<string>;
};

/** Reads a line from the terminal without echoing it. Refuses when stdin is not a terminal. */
export function askHiddenOnTty(question: string): Promise<string> {
  return new Promise((done, fail) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      fail(new Error("The password is asked at a hidden prompt: run this in a terminal."));
      return;
    }
    process.stderr.write(question);
    let value = "";
    const finish = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (err) fail(err);
      else done(value);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();
        if (ch === "\u0003") return finish(new Error("Cancelled."));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/**
 * `--username` / `--set-password` for the seeded user. Asks for the password (twice) only when
 * it is needed: `--set-password`, or a username given to an account with no password yet.
 * Prints only the username and whether the password was set. Returns false when refused.
 */
async function applyLogin(database: Db, userId: string, args: CliArgs, io: Io): Promise<boolean> {
  if (!args.username && !args.setPassword) return true;
  const current = await seededLoginOf(database, userId);
  if (!current) {
    io.err("The seeded user is gone; nothing was set.");
    return false;
  }
  if (!args.username && !current.username) {
    io.err("This student has no username yet: give --username <name> with --set-password.");
    return false;
  }
  const login: { username?: string; password?: string } = {};
  if (args.username) login.username = args.username;
  const ask = args.setPassword || !current.hasPassword;
  if (ask) {
    const askHidden = io.askHidden ?? askHiddenOnTty;
    let first: string;
    let again: string;
    try {
      first = await askHidden("Password for her account (hidden): ");
      const problem = passwordProblem(first);
      if (problem) {
        io.err(`${problem} Nothing was set.`);
        return false;
      }
      again = await askHidden("The same password again (hidden): ");
    } catch (err) {
      io.err(`${(err as Error).message} Nothing was set.`);
      return false;
    }
    if (first !== again) {
      io.err("The two passwords were not the same. Nothing was set.");
      return false;
    }
    login.password = first;
  }
  const result = await setSeededLogin(database, userId, login);
  if (!result.ok) {
    io.err(`${result.error} Nothing was set.`);
    return false;
  }
  const name = (args.username ? normalizeUsername(args.username) : current.username) ?? "";
  io.out("");
  io.out(`Log in: username ${name}, ${login.password ? "password set" : "password unchanged (--set-password to change it)"}.`);
  return true;
}

const LABELS: Record<string, string> = {
  user: "User",
  courses: "Courses",
  assignments: "Assignments",
  events: "Calendar entries",
  gradeWeights: "Grade weights",
  exams: "Exams",
  aiPolicy: "AI rules",
  exam: "Exam",
  concepts: "Concepts",
  lectures: "Lectures",
  pages: "Lecture pages",
  lectureConcepts: "Lecture-concept links",
  cards: "Cards",
  documents: "Exam documents",
};

function countLines(counts: Record<string, Count>, indent = "  "): string[] {
  return Object.keys(LABELS)
    .filter((k) => k in counts)
    .filter((k) => k !== "aiPolicy" || counts.aiPolicy.skipped + counts.aiPolicy.updated + counts.aiPolicy.created > 0)
    .map((k) => {
      const c = counts[k];
      return `${indent}${LABELS[k].padEnd(22)} ${c.created} created, ${c.skipped} already there${c.updated ? `, ${c.updated} updated` : ""}`;
    });
}

function problemLine(p: ImportProblem): string {
  return [p.file, p.index !== undefined ? `card ${p.index}` : null, p.lecture !== undefined ? `(lecture ${p.lecture})` : null].filter(Boolean).join(" ") + `: ${p.reason}`;
}

function printResult(r: SeedResult, io: Io): void {
  io.out(r.dryRun ? "Dry run, nothing was written; it would give:" : "Seeded:");
  for (const line of countLines(r.counts)) io.out(line);
  for (const imp of r.imports) {
    io.out(`  Bundle ${imp.courseCode}:`);
    if ("studyOnly" in imp) io.out(`    ${imp.summary}`);
    for (const line of countLines(imp.counts, "    ")) io.out(line);
    for (const p of imp.problems) io.out(`    problem: ${problemLine(p)}`);
    for (const n of imp.notStored) io.out(`    not stored: ${n}`);
    for (const n of imp.notes) io.out(`    note: ${n}`);
  }
  if (r.skipped.length) {
    io.out("Skipped:");
    for (const s of r.skipped) io.out(`  - ${s}`);
  }
  if (r.notStored.length) {
    io.out("Not stored:");
    for (const s of r.notStored) io.out(`  - ${s}`);
  }
  if (r.notes.length) {
    io.out("Notes:");
    for (const s of r.notes) io.out(`  - ${s}`);
  }
}

async function printLink(database: Db, userId: string, origin: string, io: Io): Promise<void> {
  const { code, expiresAt } = await mintOpenLink(database, userId);
  io.out("");
  io.out(`Open this once, within 15 minutes (until ${expiresAt.toISOString()}):`);
  io.out(`  ${openUrl(origin, code)}`);
  io.out("For a new link later: rerun with --link.");
}

/** Runs the CLI; returns the exit code. The database is passed in so tests can use a test db. */
export async function run(argv: readonly string[], database: Db, io: Io = { out: console.log, err: console.error }): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    if (parsed.help) {
      io.out(HELP);
      return 0;
    }
    io.err(`${parsed.error}\n\n${HELP}`);
    return 1;
  }
  const { args } = parsed;
  try {
    if (args.linkOnly) {
      const { readFile, realpath } = await import("node:fs/promises");
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(path.join(args.accountDir, "account.json"), "utf8"));
      } catch {
        io.err("<account-dir>/account.json cannot be read.");
        return 1;
      }
      const user = await findSeededUser(database, seedKeyFor(raw, await realpath(args.accountDir)));
      if (!user) {
        io.err("No student was seeded from this <account-dir> yet; run the seed first.");
        return 1;
      }
      if (!(await applyLogin(database, user.id, args, io))) return 1;
      await printLink(database, user.id, args.origin, io);
      return 0;
    }

    const input = await loadSeed(args.accountDir, args.bundlesDir!);
    const plan = planSeed(input);
    const result = await applySeed(database, plan, { dryRun: args.dryRun, name: args.name });
    printResult(result, io);
    if (args.dryRun) {
      if (args.username) io.out(`Would set the username ${normalizeUsername(args.username)} (no password asked in a dry run).`);
      return 0;
    }
    const loginOk = await applyLogin(database, result.userId, args, io);
    await printLink(database, result.userId, args.origin, io);
    return loginOk ? 0 : 1;
  } catch (err) {
    if (err instanceof SeedInvalid || err instanceof SeedRefused || err instanceof BundleInvalid || err instanceof ImportFailed) io.err(err.message);
    else io.err(`The seed failed and nothing was written: ${(err as Error).message}`);
    return 1;
  }
}

async function main(): Promise<void> {
  const { db } = await import("@/server/db/client");
  let code = 1;
  try {
    code = await run(process.argv.slice(2), db);
  } finally {
    // Close PGlite, if this run opened it, so its files are flushed and the lock is given back.
    const open = (globalThis as { [k: symbol]: LocalDb | undefined })[Symbol.for("ready.server.db.local")];
    await open?.close().catch(() => {});
  }
  process.exit(code);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) void main();
