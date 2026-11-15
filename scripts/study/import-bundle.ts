/*
 * M3-51: import a hand-made study bundle into one user's account.
 *
 *   npx tsx scripts/study/import-bundle.ts <folder> --user <userId> [--course <code>]... [--dry-run]
 *   npx tsx scripts/study/import-bundle.ts <folder> --moodle-user <id> [--course <code>]... [--dry-run]
 *
 * The work is done by src/server/study/import-bundle.ts (see there for the bundle format and
 * the matching rules). This file only reads the arguments, finds the user and prints.
 *
 * Privacy: a real bundle is a student's course material. It is read in place, never copied,
 * and nothing it says is printed: problems name the deck file and the card's position only.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import type { Db, LocalDb } from "@/server/db/client";
import { moodleConnections } from "@/server/db/schema/moodle";
import { users } from "@/server/db/schema/users";
import {
  applyImport,
  applyStudyOnly,
  BundleInvalid,
  ImportFailed,
  loadBundle,
  planImport,
  planStudyOnly,
  type Count,
  type ImportProblem,
  type ImportResult,
  type StudyOnlyResult,
} from "@/server/study/import-bundle";

export const HELP = `Import a hand-made study bundle into one user's account.

Usage:
  npx tsx scripts/study/import-bundle.ts <folder> --user <userId> [--course <code>]... [--dry-run]
  npx tsx scripts/study/import-bundle.ts <folder> --moodle-user <moodleUserId> [--course <code>]... [--dry-run]

  <folder>          one course (it holds seed.json), or a folder of course folders
                    (<folder>/<CODE>/seed.json, decks, pages, exam/), with account.json at the root.
                    A study-only course (seed.json says "studyOnly": true, no exam) brings its
                    lectures and lecture pages only: its cards need an exam and are counted, not imported.
  --user            the user's id in our database (users.id)
  --moodle-user     the user's Moodle user id (looked up in moodle_connections)
  --course <code>   import only this course; repeat for more. Courses not picked are not read,
                    so one that is not ready does not block the others. Default: every course.
  --course-id <id>  only when several of her courses share the picked code (an old and a new
                    instance); needs exactly one picked course
  --dry-run         check and count everything, write nothing

Her course must already exist (Moodle sync makes it). Running the import twice adds nothing.
All picked courses go in one transaction: if one fails, none is written.

Database: DATABASE_URL set uses Neon; unset uses the local PGlite in .data/pglite.
The local database takes a lock file: stop \`next dev\` first, or this script refuses to run
("Another dev process holds the local database").

Exit code: 1 when the import could not run (bad bundle, no such user or course), else 0,
also when some cards were skipped.`;

export type CliArgs = {
  folder: string;
  user: { kind: "id"; id: string } | { kind: "moodle"; id: number };
  dryRun: boolean;
  courses: string[];
  courseId?: string;
};

export type ParsedArgs = { ok: true; args: CliArgs } | { ok: false; help: true } | { ok: false; help: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let folder: string | undefined;
  let userId: string | undefined;
  let moodleUser: string | undefined;
  let courseId: string | undefined;
  const courseCodes: string[] = [];
  let dryRun = false;
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
    else if (a === "--user") {
      userId = value();
      if (!userId) return fail("--user needs a user id.");
    } else if (a === "--moodle-user") {
      moodleUser = value();
      if (!moodleUser) return fail("--moodle-user needs a Moodle user id.");
    } else if (a === "--course") {
      const code = value();
      if (!code) return fail("--course needs a course code.");
      courseCodes.push(code.trim().toUpperCase());
    } else if (a === "--course-id") {
      courseId = value();
      if (!courseId) return fail("--course-id needs a course id.");
    } else if (a.startsWith("--")) return fail(`Unknown option ${a}.`);
    else if (folder === undefined) folder = a;
    else return fail(`Only one folder, please (got also ${a}).`);
  }
  if (!folder) return fail("Give the bundle folder.");
  if (userId && moodleUser) return fail("Give --user or --moodle-user, not both.");
  if (!userId && !moodleUser) return fail("Give --user <userId> or --moodle-user <id>.");
  if (userId && !UUID.test(userId)) return fail("--user must be a user id (a uuid).");
  if (courseId && !UUID.test(courseId)) return fail("--course-id must be a course id (a uuid).");
  if (courseId && courseCodes.length !== 1) return fail("--course-id needs exactly one --course <code>.");
  let user: CliArgs["user"];
  if (userId) user = { kind: "id", id: userId };
  else {
    const n = Number(moodleUser);
    if (!Number.isInteger(n) || n <= 0) return fail("--moodle-user must be a whole number.");
    user = { kind: "moodle", id: n };
  }
  const courses = [...new Set(courseCodes)];
  return { ok: true, args: { folder: path.resolve(folder), user, dryRun, courses, ...(courseId ? { courseId } : {}) } };
}

async function resolveUser(database: Db, user: CliArgs["user"]): Promise<string | null> {
  if (user.kind === "id") {
    const [row] = await database.select({ id: users.id }).from(users).where(eq(users.id, user.id)).limit(1);
    return row?.id ?? null;
  }
  const [row] = await database
    .select({ userId: moodleConnections.userId })
    .from(moodleConnections)
    .where(eq(moodleConnections.moodleUserId, user.id))
    .limit(1);
  return row?.userId ?? null;
}

function problemLine(p: ImportProblem): string {
  const where = [p.file, p.index !== undefined ? `card ${p.index}` : null, p.lecture !== undefined ? `(lecture ${p.lecture})` : null]
    .filter(Boolean)
    .join(" ");
  return `  ${where}: ${p.reason}`;
}

const LABELS: Record<string, string> = {
  exam: "Exam",
  concepts: "Concepts",
  lectures: "Lectures",
  pages: "Lecture pages",
  lectureConcepts: "Lecture-concept links",
  cards: "Cards",
  documents: "Exam documents",
  aiPolicy: "AI policy",
};

function countLines(counts: Record<string, Count>): string[] {
  return Object.keys(LABELS)
    .filter((k) => k in counts)
    .filter((k) => k !== "aiPolicy" || counts.aiPolicy.skipped + counts.aiPolicy.updated > 0)
    .map((k) => {
      const c = counts[k];
      const updated = c.updated ? `, ${c.updated} updated` : "";
      return `  ${LABELS[k].padEnd(22)} ${c.created} created, ${c.skipped} already there${updated}`;
    });
}

function printResult(r: ImportResult | StudyOnlyResult, io: Io): void {
  io.out(`Course ${r.courseCode}${r.dryRun ? " (dry run, nothing was written; it would give)" : ""}:`);
  if ("studyOnly" in r) io.out(`  ${r.summary}`);
  for (const line of countLines(r.counts)) io.out(line);
  if (r.problems.length) {
    io.out(`  ${r.problems.length} problem(s), skipped or left as they are:`);
    for (const p of r.problems) io.out(`  ${problemLine(p)}`);
  }
  if (r.notStored.length) {
    io.out("  Not stored:");
    for (const n of r.notStored) io.out(`    - ${n}`);
  }
  if (r.notes.length) {
    io.out("  Notes (how the bundle was read):");
    for (const n of r.notes) io.out(`    - ${n}`);
  }
  io.out("");
}

export type Io = { out: (line: string) => void; err: (line: string) => void };

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
    const bundle = await loadBundle(args.folder, { courses: args.courses });
    const plans = bundle.courses.map(planImport);
    const studyPlans = bundle.studyOnly.map(planStudyOnly);

    const userId = await resolveUser(database, args.user);
    if (!userId) {
      io.err(args.user.kind === "id" ? `No user with id ${args.user.id}.` : `No Moodle connection for Moodle user ${args.user.id}.`);
      return 1;
    }

    // One transaction for every picked course; each course is a savepoint inside it.
    const results = await database.transaction(async (tx) => {
      const out: (ImportResult | StudyOnlyResult)[] = [];
      const options = { dryRun: args.dryRun, courseId: args.courseId };
      for (const plan of plans) out.push(await applyImport(tx as unknown as Db, userId, plan, options));
      for (const plan of studyPlans) out.push(await applyStudyOnly(tx as unknown as Db, userId, plan, options));
      return out;
    });
    for (const r of results) printResult(r, io);
    io.out(args.dryRun ? "Dry run: nothing was written." : `Imported ${results.length} course(s).`);
    return 0;
  } catch (err) {
    if (err instanceof BundleInvalid || err instanceof ImportFailed) io.err(err.message);
    else io.err(`The import failed and nothing was written: ${(err as Error).message}`);
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
    // Read from the slot client.ts keeps it in, so a run that never touched the database opens nothing.
    const open = (globalThis as { [k: symbol]: LocalDb | undefined })[Symbol.for("ready.server.db.local")];
    await open?.close().catch(() => {});
  }
  process.exit(code);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) void main();
