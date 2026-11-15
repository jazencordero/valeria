/*
 * M3-57: seed one student's whole account from files, with no Moodle sign-in.
 *
 *   npx tsx scripts/study/seed-account.ts <account-dir> <bundles-dir> [--name <first name>] [--username <name>] [--set-password] [--tutor on|off] [--dry-run] [--origin <url>]
 *   npx tsx scripts/study/seed-account.ts <account-dir> --link [--username <name>] [--set-password] [--origin <url>]
 *   npx tsx scripts/study/seed-account.ts <account-dir> <bundles-dir> --upload https://<host> --username <name> [--tutor on|off] [--dry-run]
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
 *
 * Upload (M3-58): `--upload https://<host>` opens no database. It logs in to the app at that
 * address as `--username` (here: the account to log in to, which must exist already; nothing is
 * renamed), with the password asked at a hidden prompt, and sends what it read from the files to
 * POST /api/seed one part at a time: the account first, then each course folder's batches. The
 * app plans and writes them with the code a direct run uses, into the logged-in account only.
 * - The password goes to POST /api/login of that address and nowhere else: it is never an
 *   argument, never read from the environment, never printed or written. A plain http address
 *   is refused unless it is this machine (localhost, 127.0.0.1, [::1]), before anything is asked.
 * - The session cookie the app answers with is kept in memory for this run only, and the
 *   session is ended (POST /logout) when the run is over.
 * - Redirects are not followed, so neither the password nor the cookie can be passed on to
 *   another host.
 * - Of an answer only the documented fields are used: the counts, and a refusal's `message`,
 *   `problems` and Retry-After.
 * When the password is piped in (stdin is not a terminal) its first line is taken: for tests.
 *
 * Tutor (M2-28): `--tutor on|off` switches the tutor for the account (`users.settings.tutor.
 * enabled`, merged into the other settings); left out, the setting is left alone. A direct run
 * sets it in the seed's transaction. An upload sends it as one more request after the account
 * part; the app applies it only for a username its `TUTOR_USERS` lists, else ignores it, and
 * the run prints which (an ignored switch is not an error: exit code 0).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Db, LocalDb } from "@/server/db/client";
import { BundleInvalid, ImportFailed, type Count, type ImportProblem } from "@/server/study/import-bundle";
import { BAD_USERNAME, normalizeUsername } from "@/server/auth/accounts";
import { passwordProblem } from "@/server/auth/password";
import { SESSION_COOKIE } from "@/server/auth/session";
import {
  applySeed,
  bundlePartsOf,
  combineAnswers,
  findSeededUser,
  loadSeed,
  mintOpenLink,
  openUrl,
  planSeed,
  seededLoginOf,
  seedKeyFor,
  SeedInvalid,
  seedPartsOf,
  SeedRefused,
  serialisePart,
  setSeededLogin,
  UPLOAD_PART_BYTES,
  type BundleCourse,
  type BundlePart,
  type SeedAnswer,
  type SeedInput,
  type SeedPlan,
  type SeedResult,
  type TutorPart,
  type TutorSwitch,
  type UploadPart,
  type UploadSummary,
} from "@/server/study/seed-account";

export const DEFAULT_ORIGIN = "http://localhost:3000";

export const HELP = `Seed one student's whole account from files, with no Moodle sign-in.

Usage:
  npx tsx scripts/study/seed-account.ts <account-dir> <bundles-dir> [--name <first name>] [--username <name>] [--set-password] [--tutor on|off] [--dry-run] [--origin <url>]
  npx tsx scripts/study/seed-account.ts <account-dir> --link [--username <name>] [--set-password] [--origin <url>]
  npx tsx scripts/study/seed-account.ts <account-dir> <bundles-dir> --upload https://<host> --username <name> [--tutor on|off] [--dry-run]

The first two write straight to a database. The third (--upload) opens no database: it logs
in to the app at <host> and sends the files' content there, into the logged-in account.

  <account-dir>   holds account.json (courses, assignments, calendar), as M0-16's pull wrote it
  <bundles-dir>   holds account.json (exams, grade weights, AI rules) and one folder per course
                  with seed.json (the study bundles; study-only ones bring pages only)
  --name          her first name, for the greeting
  --username      without --upload: GIVES the seeded student this username (3 to 32 of
                  a-z 0-9 . _ -) and asks for a password at a hidden prompt when the account
                  has none yet.
                  with --upload: the EXISTING account to log in to. Nothing is renamed and no
                  password is set; its password is asked at a hidden prompt.
  --set-password  asks for a new password at a hidden prompt (the account needs a username)
  --tutor on|off  switches the tutor (the chat in the notes panel) on or off for this
                  account; left out, the setting is left alone. A direct run sets it with the
                  seed. With --upload the app takes it only from an account listed in its
                  TUTOR_USERS setting (the server's environment) and otherwise ignores it; the
                  run says which. Does not go with --link.
  --dry-run       check and count everything, write nothing (no link either)
  --link          only print a fresh one-time link for the student seeded from <account-dir>
  --origin        where the app runs, for the link (default ${DEFAULT_ORIGIN}); give a
                  preview or production origin (https://...) to open it there. The link only
                  works against the database this command wrote to.
  --upload        the app's address (https://<host>). Logs in there as --username and sends
                  the account, then each course folder in batches, to be written into that
                  account. Needs --username; does not go with --set-password, --link, --origin
                  or --name (an upload sets no password, prints no link and no first name).
                  Plain http is only taken for this machine (localhost, 127.0.0.1, [::1]).
                  With --dry-run: plans from the files and prints what would be sent; logs in
                  to nothing, asks for no password and sends nothing.

The first run creates her user (no Moodle connection); a rerun finds the same user and
updates in place, never duplicating. Everything is one transaction.
The link (/open?code=...) works once, within 15 minutes; rerun with --link for a new one.
The password is never an argument and never printed; only its hash is stored.

An upload updates in place too: a second one changes nothing. The account must exist (sign up
in the app first). The app takes 30 requests an hour per account; when it says to wait, run
the same command again after the wait and it carries on (what is already there is skipped).
The upload's password goes only to <host>; the session it gets is kept in memory for the run.

Database: DATABASE_URL set uses Neon; unset uses the local PGlite in .data/pglite.
The local database takes a lock file: stop \`next dev\` first.

Exit code: 1 when nothing could be written (bad files, refused) or the username or password
could not be set (the seed itself is kept), else 0, also when some parts were skipped (they
are listed). An upload: 1 when it could not log in or stopped before every part was sent
(what was sent is kept and listed), else 0 (also when the app ignored --tutor: it says so).`;

/** Hosts a plain http upload is taken for: this machine only. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type CliArgs = {
  accountDir: string;
  bundlesDir: string | null;
  name?: string;
  dryRun: boolean;
  linkOnly: boolean;
  origin: string;
  /** The username to set (as typed; lowered when stored). With `upload`: the account to log in to. */
  username?: string;
  /** The app to upload to (its origin). Set: no database is opened. */
  upload?: string;
  /** Ask for a new password even when the account has one. */
  setPassword: boolean;
  /** `--tutor on|off` (M2-28); left out, the setting is left alone. */
  tutor?: TutorSwitch;
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
  let upload: string | undefined;
  let tutor: TutorSwitch | undefined;
  let originGiven = false;
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
    else if (a === "--tutor") {
      const v = value()?.trim().toLowerCase();
      if (v !== "on" && v !== "off") return fail("--tutor needs on or off.");
      tutor = v;
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
      originGiven = true;
    } else if (a === "--upload") {
      const v = value();
      if (!v) return fail("--upload needs the app's address, like https://example.com.");
      let url: URL;
      try {
        url = new URL(v);
      } catch {
        return fail("--upload must be an address like https://example.com.");
      }
      if (url.username || url.password) return fail("--upload: give the address only; the username goes in --username and the password is asked for.");
      const thisMachine = LOCAL_HOSTS.has(url.hostname);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && thisMachine)) {
        return fail("--upload must be an https:// address: the password is sent to it. Plain http is only taken for localhost, 127.0.0.1 or [::1].");
      }
      upload = url.origin;
    } else if (a.startsWith("--")) return fail(`Unknown option ${a}.`);
    else dirs.push(a);
  }
  if (linkOnly && dryRun) return fail("--link and --dry-run do not go together.");
  if (setPassword && dryRun) return fail("--set-password and --dry-run do not go together.");
  if (tutor && linkOnly) return fail("--tutor and --link do not go together: run the seed (it updates in place) with --tutor.");
  if (upload) {
    if (linkOnly) return fail("--upload and --link do not go together: an upload prints no link.");
    if (setPassword) return fail("--upload and --set-password do not go together: an upload logs in with the password the account has.");
    if (originGiven) return fail("--upload and --origin do not go together: --upload already says where the app is.");
    if (name) return fail("--upload and --name do not go together: an upload does not set her first name.");
    if (!username) return fail("--upload needs --username <name>: the account to log in to.");
  }
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
      ...(upload ? { upload } : {}),
      ...(tutor ? { tutor } : {}),
      setPassword,
    },
  };
}

export type Io = {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Reads one line without showing it (the password). Tests pass their own. */
  askHidden?: (question: string) => Promise<string>;
  /** How an upload reaches the app. Tests pass one that calls the route handlers in-process. */
  fetch?: typeof fetch;
  /** What an upload fills one request to (tests; default `UPLOAD_PART_BYTES`). */
  partBytes?: number;
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

function printResult(r: SeedResult | UploadSummary, io: Io, heading?: string): void {
  io.out(heading ?? (r.dryRun ? "Dry run, nothing was written; it would give:" : "Seeded:"));
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

/** The line a direct run prints for `--tutor`. */
function tutorLine(r: SeedResult): string | null {
  if (!r.tutor) return null;
  const state = r.tutor.on ? "on" : "off";
  if (r.dryRun) return r.tutor.changed ? `Tutor: would be switched ${state}.` : `Tutor: already ${state}; would stay so.`;
  return r.tutor.changed ? `Tutor: switched ${state}.` : `Tutor: already ${state}.`;
}

async function printLink(database: Db, userId: string, origin: string, io: Io): Promise<void> {
  const { code, expiresAt } = await mintOpenLink(database, userId);
  io.out("");
  io.out(`Open this once, within 15 minutes (until ${expiresAt.toISOString()}):`);
  io.out(`  ${openUrl(origin, code)}`);
  io.out("For a new link later: rerun with --link.");
}

// ---------------------------------------------------------------------------
// --upload (M3-58): log in to the app and send the parts to POST /api/seed
// ---------------------------------------------------------------------------

/** The first line of a piped stdin (the password, for tests). Never echoed. */
function readPipedLine(): Promise<string> {
  return new Promise((done, fail) => {
    const stdin = process.stdin;
    let text = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.off("end", finish);
      stdin.off("error", fail);
      stdin.pause();
      done(text.split(/\r?\n/)[0]);
    };
    const onData = (chunk: string | Buffer) => {
      text += chunk.toString();
      if (text.includes("\n")) finish();
    };
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.once("end", finish);
    stdin.once("error", fail);
  });
}

const REQUEST_TIMEOUT_MS = 120_000;
/** The app's hourly limit (POST /api/seed), to warn before a long upload. */
const REQUESTS_AN_HOUR = 30;
/** `ready_session=<token>` at the start of a Set-Cookie line; only the token is kept. */
const SESSION_COOKIE_VALUE = new RegExp(`^${SESSION_COOKIE}=([A-Za-z0-9_-]{43})(?:;|$)`);

type Reply = { status: number; data: unknown; retryAfter: number | null; cookies: string[] };

/** One JSON POST. Redirects are not followed: the password and the cookie only go to `url`'s host. */
async function postJson(fetcher: typeof fetch, url: string, body: string, cookie?: string): Promise<Reply> {
  const res = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data: unknown = await res.json().catch(() => null);
  const wait = Number(res.headers.get("retry-after"));
  return {
    status: res.status,
    data,
    retryAfter: res.headers.has("retry-after") && Number.isFinite(wait) && wait >= 0 ? wait : null,
    cookies: typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [],
  };
}

/** Text from an answer as one short line with no control characters. */
const oneLine = (text: string) =>
  Array.from(text, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch))
    .join("")
    .trim()
    .slice(0, 300);

/** A refusal's `message`; anything else in a body is never shown. */
function messageOf(data: unknown): string | null {
  const v = typeof data === "object" && data !== null ? (data as Record<string, unknown>).message : null;
  return typeof v === "string" && oneLine(v) ? oneLine(v) : null;
}

/** A 400's `problems`: path-named lines, never a value of the files. */
function problemsOf(data: unknown): string[] {
  const v = typeof data === "object" && data !== null ? (data as Record<string, unknown>).problems : null;
  if (!Array.isArray(v)) return [];
  return v.filter((p): p is string => typeof p === "string").slice(0, 50).map(oneLine);
}

const minutes = (seconds: number) => {
  const m = Math.max(1, Math.ceil(seconds / 60));
  return `${m} minute${m === 1 ? "" : "s"}`;
};

const kB = (bytes: number) => (bytes < 1000 ? `${bytes} B` : bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)} kB` : `${(bytes / 1_000_000).toFixed(1)} MB`);
const some = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function partName(p: UploadPart): string {
  return p.part === "account" ? "account" : p.part === "tutor" ? "tutor" : `bundle ${p.courseCode} ${p.batch.n}/${p.batch.of}`;
}

function partHolds(p: UploadPart): string {
  if (p.part === "account") return some(p.account.courses.length, "course");
  if (p.part === "tutor") return `switch the tutor ${p.tutor} (taken only from accounts the app lists)`;
  const pages = `${p.pages.length} page${p.pages.length === 1 ? "" : "s"}`;
  if (p.kind === "studyOnly") return `study-only, ${pages}`;
  const cardCount = p.decks.reduce((s, d) => s + d.cards.length, 0);
  return `${cardCount} cards, ${pages}, ${p.documents.length} exam document${p.documents.length === 1 ? "" : "s"}`;
}

/** Whether a 200 answer is the answer to `part` (anything else is not this app's seed route). */
function isAnswerTo(part: UploadPart, data: unknown): data is SeedAnswer {
  if (typeof data !== "object" || data === null) return false;
  const a = data as Record<string, unknown>;
  if (a.part !== part.part) return false;
  if (part.part === "tutor") return a.applied === false || (a.applied === true && typeof a.on === "boolean" && typeof a.changed === "boolean");
  const counted = typeof a.counts === "object" && a.counts !== null;
  if (part.part === "account") return counted && Array.isArray(a.skipped) && Array.isArray(a.notStored) && Array.isArray(a.notes);
  if (a.imported === false) return typeof a.reason === "string";
  return a.imported === true && counted && (a.kind !== "exam" || Array.isArray(a.problems));
}

/**
 * A course folder sent again in smaller batches: the rows its first batches already wrote come
 * back as "already there" the second time. Takes them off again, so the folder's sums are what
 * one clean pass gives.
 */
function withoutResent(first: SeedAnswer[], second: SeedAnswer[]): SeedAnswer[] {
  const again: Record<string, number> = {};
  for (const a of first) {
    if (a.part !== "bundle" || !a.imported) continue;
    for (const [name, c] of Object.entries(a.counts)) again[name] = (again[name] ?? 0) + c.created + c.updated + c.skipped;
  }
  return second.map((a) => {
    if (a.part !== "bundle" || !a.imported) return a;
    const counts = Object.fromEntries(
      Object.entries(a.counts).map(([name, c]) => {
        const take = Math.min(c.skipped, again[name] ?? 0);
        again[name] = (again[name] ?? 0) - take;
        return [name, { ...c, skipped: c.skipped - take }];
      }),
    );
    return { ...a, counts } as SeedAnswer;
  });
}

function printPlanned(plan: SeedPlan, parts: UploadPart[], args: CliArgs, io: Io): void {
  const account = normalizeUsername(args.username!) ?? args.username!;
  io.out("Dry run: nothing was sent, nobody was logged in and no password was asked.");
  io.out(`An upload to ${args.upload} into the account ${account} would send ${parts.length} request${parts.length === 1 ? "" : "s"}:`);
  let total = 0;
  parts.forEach((p, i) => {
    const bytes = Buffer.byteLength(serialisePart(p));
    total += bytes;
    io.out(`  ${String(i + 1).padStart(2)}. ${partName(p).padEnd(28)} ${kB(bytes).padStart(10)}   ${partHolds(p)}`);
  });
  io.out(`  In all ${kB(total)}; one request may be ${kB(UPLOAD_PART_BYTES)} at most.`);
  io.out(`Planned from the files: ${some(plan.courses.length, "course")}, ${some(plan.exams.length, "exam")}, ${some(plan.bundles.length, "course folder")}.`);
  for (const [title, lines] of [["Skipped", plan.skipped], ["Not stored", plan.notStored], ["Notes", plan.notes]] as const) {
    if (!lines.length) continue;
    io.out(`${title}:`);
    for (const s of lines) io.out(`  - ${s}`);
  }
}

/** `--upload`: returns the exit code. Opens no database. */
async function runUpload(args: CliArgs, io: Io): Promise<number> {
  const origin = args.upload!;
  const account = normalizeUsername(args.username!) ?? args.username!;
  let maxBytes = io.partBytes ?? UPLOAD_PART_BYTES;

  const input: SeedInput = await loadSeed(args.accountDir, args.bundlesDir!);
  const plan = planSeed(input);
  const parts = seedPartsOf(input, maxBytes);
  const tutorPart: TutorPart | null = args.tutor ? { part: "tutor", tutor: args.tutor } : null;
  const requests = parts.length + (tutorPart ? 1 : 0);
  if (requests > REQUESTS_AN_HOUR) {
    io.out(`This is ${requests} requests and the app takes ${REQUESTS_AN_HOUR} an hour per account: it will stop part way and say how long to wait. Run the same command again then.`);
  }
  if (args.dryRun) {
    // The tutor switch goes right after the account part.
    printPlanned(plan, tutorPart ? [parts[0], tutorPart, ...parts.slice(1)] : parts, args, io);
    return 0;
  }

  // The course folders, each with its own batches, in the order `seedPartsOf` gave them.
  const [accountPart, ...rest] = parts;
  const folders: { bundle: BundleCourse; batches: BundlePart[] }[] = [];
  let at = 0;
  for (const bundle of input.bundles) {
    const first = rest[at] as BundlePart;
    const batches = rest.slice(at, at + first.batch.of) as BundlePart[];
    at += batches.length;
    folders.push({ bundle, batches });
  }

  let password: string;
  try {
    const question = `Password of the account ${account} at ${origin} (hidden): `;
    password = await (io.askHidden ?? (process.stdin.isTTY ? askHiddenOnTty : readPipedLine))(question);
  } catch (err) {
    io.err(`${(err as Error).message} Nothing was sent.`);
    return 1;
  }
  if (!password) {
    io.err("No password was given. Nothing was sent.");
    return 1;
  }

  const fetcher = io.fetch ?? fetch;
  const unreachable = (err: unknown) => {
    const e = err as { name?: string; cause?: { code?: unknown } };
    const why = e.name === "TimeoutError" ? "it did not answer in time" : typeof e.cause?.code === "string" ? e.cause.code : "no connection";
    return `Could not reach ${origin} (${why}).`;
  };
  const redirected = `${origin} answered with a redirect. Give --upload the address the app really runs at (for example with or without www).`;

  // Log in. The password goes into this one request and is not kept after it.
  let cookie: string;
  try {
    const reply = await postJson(fetcher, `${origin}/api/login`, JSON.stringify({ username: args.username, password }));
    password = "";
    if (reply.status === 401) {
      io.err("Log in failed: that username and password do not match. Nothing was sent.");
      return 1;
    }
    if (reply.status === 429) {
      io.err(`Log in refused: too many tries. Wait ${minutes(reply.retryAfter ?? 15 * 60)} and run this again. Nothing was sent.`);
      return 1;
    }
    if (reply.status >= 300 && reply.status < 400) {
      io.err(`${redirected} Nothing was sent.`);
      return 1;
    }
    const token = reply.cookies.map((c) => SESSION_COOKIE_VALUE.exec(c)?.[1]).find((v) => v !== undefined);
    if (reply.status !== 200 || !token) {
      const more = reply.status === 200 ? " with no session" : reply.status === 404 ? " (this app has no log-in for the tool yet)" : "";
      io.err(`Log in failed: ${origin} answered ${reply.status}${more}. Nothing was sent.`);
      return 1;
    }
    cookie = `${SESSION_COOKIE}=${token}`;
  } catch (err) {
    io.err(`${unreachable(err)} Nothing was sent.`);
    return 1;
  }

  const answers: SeedAnswer[] = [];
  const also: string[] = [];
  /** Why the upload ended early (then the exit code is 1). */
  let stopped: string | null = null;
  let stoppedProblems: string[] = [];

  /** What the app said to `--tutor`, when it was sent. */
  let tutorAnswer: SeedAnswer | null = null;

  /** Sends one part; a 200 that fits comes back as the answer, anything else as the reply. */
  const send = async (part: UploadPart): Promise<{ answer: SeedAnswer } | { reply: Reply }> => {
    const reply = await postJson(fetcher, `${origin}/api/seed`, serialisePart(part), cookie);
    if (reply.status === 200 && isAnswerTo(part, reply.data)) return { answer: reply.data };
    return { reply };
  };
  /** The sentence for a reply that ends the upload. */
  const whyStopped = (part: UploadPart, reply: Reply): string => {
    const where = `At ${partName(part)}:`;
    const message = messageOf(reply.data);
    switch (reply.status) {
      case 200:
        return `${where} ${origin} did not answer as the app does. Stopped.`;
      case 400:
        stoppedProblems = problemsOf(reply.data);
        return `${where} the app says this part does not fit; it wrote nothing of it. Stopped.`;
      case 401:
        return `${where} the log in is no longer valid (it ended or ran out). Run this again.`;
      case 403:
        return `${where} refused${message ? `: ${message}` : "."} Stopped.`;
      case 413:
        return `${where} too large for the app, also in smaller batches. Stopped.`;
      case 429:
        return `${where} the app has taken its ${REQUESTS_AN_HOUR} requests for this hour. Wait ${reply.retryAfter === null ? "up to an hour" : minutes(reply.retryAfter)}, then run the same command again: what is already there is skipped.`;
      default:
        if (reply.status >= 300 && reply.status < 400) return `${where} ${redirected}`;
        return `${where} ${origin} answered ${reply.status}${message ? `: ${message}` : "."} Stopped.`;
    }
  };

  try {
    const first = await send(accountPart);
    if ("answer" in first) answers.push(first.answer);
    else if (first.reply.status === 409) {
      also.push("The account part (courses, assignments, calendar, grade weights, exams, AI rules): not written. This account is connected to the school's Moodle, so its sync keeps those; the course folders were still sent.");
    } else stopped = whyStopped(accountPart, first.reply);

    // `--tutor`: one small request after the account part (also when that one was refused for
    // a Moodle connection: the switch is not part of what the sync owns).
    if (tutorPart && !stopped) {
      const sent = await send(tutorPart);
      if ("answer" in sent) tutorAnswer = sent.answer;
      else stopped = whyStopped(tutorPart, sent.reply);
    }

    for (const folder of stopped ? [] : folders) {
      let batches = folder.batches;
      let earlier: SeedAnswer[] = [];
      let got: SeedAnswer[] = [];
      let resplit = false;
      pass: for (;;) {
        got = [];
        for (const part of batches) {
          const sent = await send(part);
          if ("answer" in sent) {
            got.push(sent.answer);
            // Not imported (say, no such course in her account): its other batches would say the same.
            if (sent.answer.part === "bundle" && !sent.answer.imported) break pass;
            continue;
          }
          if (sent.reply.status === 413 && !resplit) {
            // Once: the same folder again in batches half the size (later folders use that size too).
            resplit = true;
            maxBytes = Math.floor(maxBytes / 2);
            try {
              batches = bundlePartsOf(folder.bundle, maxBytes);
            } catch (err) {
              if (!(err instanceof SeedInvalid)) throw err;
              stopped = `${whyStopped(part, sent.reply)} ${err.message}`;
              break pass;
            }
            io.out(`${partName(part)} was too large for the app; sending ${folder.bundle.courseCode} again in ${batches.length} smaller batches.`);
            earlier = got;
            continue pass;
          }
          stopped = whyStopped(part, sent.reply);
          break pass;
        }
        break;
      }
      answers.push(...earlier, ...withoutResent(earlier, got));
      if (stopped) break;
      if (resplit) {
        // The folders still to come, at the size that went through.
        for (const later of folders.slice(folders.indexOf(folder) + 1)) {
          try {
            later.batches = bundlePartsOf(later.bundle, maxBytes);
          } catch (err) {
            if (!(err instanceof SeedInvalid)) throw err;
          }
        }
      }
    }
  } catch (err) {
    stopped = `${unreachable(err)} Stopped; run the same command again.`;
  }

  // End the session this run made (only this one; her own devices stay logged in). If that
  // fails it runs out by itself, and its token was never anywhere but in this process.
  await fetcher(`${origin}/logout`, { method: "POST", headers: { Cookie: cookie }, redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch(() => {});

  const any = answers.length > 0 || also.length > 0 || tutorAnswer !== null;
  if (any) {
    const summary = combineAnswers(plan, answers);
    summary.skipped.push(...also);
    printResult(summary, io, stopped ? `Stopped before the end. Sent to ${origin}, into the account ${account}, so far:` : `Uploaded to ${origin}, into the account ${account}:`);
  }
  if (tutorAnswer?.part === "tutor") {
    if (tutorAnswer.applied) {
      const state = tutorAnswer.on ? "on" : "off";
      io.out(tutorAnswer.changed ? `Tutor: switched ${state} (applied by the app).` : `Tutor: already ${state} (applied by the app; nothing changed).`);
    } else {
      io.out(`Tutor: ignored by the app; the setting was not changed. It takes --tutor only from accounts listed in its TUTOR_USERS setting.`);
    }
  }
  if (stopped) {
    io.err(any ? stopped : `${stopped} Nothing was written.`);
    for (const p of stoppedProblems) io.err(`  problem: ${p}`);
    return 1;
  }
  return 0;
}

/**
 * Runs the CLI; returns the exit code. The database is passed in so tests can use a test db;
 * an upload opens none (pass null).
 */
export async function run(argv: readonly string[], database: Db | null, io: Io = { out: console.log, err: console.error }): Promise<number> {
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
    if (args.upload) return await runUpload(args, io);
    if (!database) {
      io.err("No database was opened.");
      return 1;
    }
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
    const tutor = args.tutor === undefined ? undefined : args.tutor === "on";
    const result = await applySeed(database, plan, { dryRun: args.dryRun, name: args.name, tutor });
    printResult(result, io);
    const tutorSaid = tutorLine(result);
    if (tutorSaid) io.out(tutorSaid);
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
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  // An upload opens no database (and so takes no lock: the local dev server can keep running).
  const db = parsed.ok && parsed.args.upload ? null : (await import("@/server/db/client")).db;
  let code = 1;
  try {
    code = await run(argv, db);
  } finally {
    // Close PGlite, if this run opened it, so its files are flushed and the lock is given back.
    const open = (globalThis as { [k: symbol]: LocalDb | undefined })[Symbol.for("ready.server.db.local")];
    await open?.close().catch(() => {});
  }
  process.exit(code);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) void main();
