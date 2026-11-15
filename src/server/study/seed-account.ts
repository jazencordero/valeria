/**
 * Seed one student's whole account from files, with no Moodle sign-in (ticket M3-57).
 *
 *   const input = await loadSeed(accountDir, bundlesDir);   // read + validate, no db
 *   const plan = planSeed(input);                           // pure
 *   const result = await applySeed(db, plan, { name, dryRun }); // one transaction
 *   const link = await mintOpenLink(db, result.userId);     // GET /open?code=...
 *
 * Inputs (both read at run time, never copied):
 * - `<account-dir>/account.json` (M0-16's pull): `{ pulledAt, source, courses: [{ code, name,
 *   starts, ends, assignments: [...], calendarNext60Days: [...] }], gradesFirstCourseOnly, notKnownYet }`.
 *   Assignments are read as `scripts/moodle/account-status.mjs` writes them: `{ id, cmid, name,
 *   dueAt, cutoffAt, status, graded, submittedAt, requiresSubmitPress, ... }`. Calendar entries
 *   are read leniently: `id?`, a title (`name` or `title`), a time (`timesort`, `timestart`,
 *   `startsAt`, `at` or `date`: ISO text or Unix seconds), `modulename`/`module`? Unknown keys
 *   are ignored; a missing required one is a path-named problem and nothing is written.
 * - `<bundles-dir>/account.json` (optional): `{ exams: [{ courseCode, title, kind, at,
 *   atIsPlaceholderTime, source }], gradeWeights: [{ courseCode, items, passRule, gradeBands,
 *   note, source }], aiAllowed: [{ courseCode, allowed }], unknown, noExam }`, and one folder per
 *   course with a `seed.json` (the M3-51/M3-56 bundle importer reads those).
 *
 * The user: one `users` row with no Moodle connection and no demo flag. `settings.seededFrom`
 * = `{ key, pulledAt }`; `key` is sha256 of the student's identity when account.json names one
 * (`moodleUserId`, `userid`, `userId` or `user.id`, with `source`), else of the account
 * folder's real path. Only the hash is stored. A rerun with the same key reuses the user; a
 * user that has since connected MyCourses is never seeded again (the sync owns it then).
 *
 * Rows, each matched so a second run changes nothing (and a changed file updates in place):
 * - Course: `moodle_id` = `courseMoodleId(code)`, a stable negative int4 from the code, so it
 *   never meets a real Moodle id; a later real sync takes the row over by its code. Two codes
 *   that land on the same number are refused. `starts`/`ends` have no column (reported).
 * - Assignment: by `moodle_id` = the file's `id` (a real Moodle id), else a negative number
 *   derived from course code + name. State from `status`/`graded`.
 * - Calendar entry: an `events` row by `moodle_ref`: `event:<id>` with source 'moodle' when the
 *   entry has an id (so a later real sync updates the same row), else `seed:<hash>` with source
 *   'manual'. Kind as the sync gives it (`kindFor`).
 * - Grade weights: one `grade_items` row per item, `moodle_ref seed:<hash>`, `weight` as a
 *   fraction (percents are divided by 100), `max` 100 unless given, `weight_source 'manual'`:
 *   they come from the syllabus, and the grade sync never changes a manual weight. `passRule`,
 *   `gradeBands` and `note` have no column (reported as not stored).
 * - Exam: by course + title. An exam with no date is skipped and reported. Matching a course
 *   bundle's own seed exam (so one course never gets two): same title (any case), or the
 *   course has exactly one dated account.json exam and the bundle has its one seed exam. The
 *   row then takes the bundle's title and target (so the importer finds it) and account.json's
 *   date and kind. account.json is the newer source: on a rerun a changed date is updated.
 * - AI rule: `aiAllowed[]` mapped as the importer does (`aiRuleFor`), on every seeded course.
 * Then the bundle importer runs for every course folder with a `seed.json` (study-only ones
 * bring pages only). A folder that cannot be imported (bad seed, no exam date, no such course)
 * is reported and skipped; the rest still goes in.
 *
 * Everything is one transaction; `dryRun` does every write and rolls it back.
 *
 * The one-time link: `mintOpenLink` stores sha256 of a random 256-bit code in `confirm_codes`
 * (purpose 'open', 15 minutes) and returns the code; `redeemOpenCode` marks it used in one
 * UPDATE (single use under races), then makes a device session the way `session.ts` does.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { hashToken, newToken } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { events } from "@/server/db/schema/calendar";
import { courses } from "@/server/db/schema/courses";
import { gradeItems } from "@/server/db/schema/grades";
import { moodleConnections } from "@/server/db/schema/moodle";
import { nameWithoutCode } from "@/server/moodle/read/courses";
import { helsinkiToInstant } from "@/server/study/exams";
import { exams } from "@/server/db/schema/study";
import { confirmCodes, sessions, users } from "@/server/db/schema/users";
import { assignments, ASSIGNMENT_STATES } from "@/server/db/schema/work";
import {
  AccountExamSchema,
  AccountSchema,
  aiRuleFor,
  applyImport,
  applyStudyOnly,
  BundleInvalid,
  DeckFileSchema,
  examKindOf,
  ImportFailed,
  loadBundle,
  MapSchema,
  PageSchema,
  planImport,
  planStudyOnly,
  SeedSchema,
  StudySeedSchema,
  studyOnlySummary,
  type BundlePage,
  type Count,
  type CourseBundle,
  type ImportCounts,
  type ImportPlan,
  type ImportProblem,
  type ImportResult,
  type StudyOnlyCounts,
  type StudyOnlyCourse,
  type StudyOnlyPlan,
  type StudyOnlyResult,
} from "@/server/study/import-bundle";
import { nextColor, type CourseColor } from "@/server/sync/courses";
import { EXAM_TARGET_PCT, kindFor } from "@/server/sync/events";

// ---------------------------------------------------------------------------
// Schemas (lenient: unknown keys are ignored, optional fields may be missing)
// ---------------------------------------------------------------------------

const nonEmpty = (what: string) => z.string({ error: `${what} must be text.` }).trim().min(1, { error: `${what} is empty.` });

/** "YYYY-MM-DD HH:MM" (or with a T, or seconds) and no zone: a wall-clock time. */
const LOCAL_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ISO text with a zone, Unix seconds (Moodle's 0 = not set), or a time with no zone
 * ("2026-11-20 23:59"), which is read as Europe/Helsinki local time, the way MyCourses shows
 * it. A day alone is that day's Helsinki midnight.
 */
function toDate(v: string | number | null | undefined): Date | null | "bad" {
  if (v === null || v === undefined || v === 0) return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? new Date(v < 1e12 ? v * 1000 : v) : "bad";
  const text = v.trim();
  if (text === "") return null;
  const local = LOCAL_TIME.exec(text);
  if (local) return helsinkiToInstant(local[1], local[2]) ?? "bad";
  if (LOCAL_DAY.test(text)) return helsinkiToInstant(text, "00:00") ?? "bad";
  const t = Date.parse(text);
  return Number.isNaN(t) ? "bad" : new Date(t);
}

const When = z
  .union([z.string(), z.number()], { error: "must be a date and time (ISO, or YYYY-MM-DD HH:MM in Helsinki time), Unix seconds or null." })
  .nullish()
  .transform((v, ctx) => {
    const d = toDate(v);
    if (d === "bad") {
      ctx.addIssue({ code: "custom", message: "must be a date and time (ISO, or YYYY-MM-DD HH:MM in Helsinki time), Unix seconds or null." });
      return z.NEVER;
    }
    return d;
  });

const moodleIdOrNull = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)], { error: "must be a whole number." }).nullish();

const AssignmentSchema = z.looseObject({
  id: moodleIdOrNull,
  cmid: moodleIdOrNull,
  name: nonEmpty("name"),
  dueAt: When,
  cutoffAt: When,
  opensAt: When,
  // The same three as a hand-pulled file names them.
  due: When,
  cutoff: When,
  opens: When,
  status: z.string().nullish(),
  graded: z.boolean().nullish(),
  submittedAt: When,
  requiresSubmitPress: z.boolean().nullish(),
});

const CalendarSchema = z
  .looseObject({
    id: z.union([z.number().int(), z.string()]).nullish(),
    name: z.string().nullish(),
    title: z.string().nullish(),
    timesort: When,
    timestart: When,
    startsAt: When,
    at: When,
    date: When,
    modulename: z.string().nullish(),
    module: z.string().nullish(),
  })
  .superRefine((e, ctx) => {
    if (!(e.name ?? e.title)?.trim()) ctx.addIssue({ code: "custom", message: "needs a title (name or title)." });
    if (!(e.timesort ?? e.timestart ?? e.startsAt ?? e.at ?? e.date)) {
      ctx.addIssue({ code: "custom", message: "needs a time (timesort, timestart, startsAt, at or date)." });
    }
  });

export const SeedAccountSchema = z.looseObject({
  pulledAt: z.string().nullish(),
  source: z.string().nullish(),
  courses: z
    .array(
      z.looseObject({
        code: nonEmpty("code"),
        name: nonEmpty("name"),
        starts: z.string().nullish(),
        ends: z.string().nullish(),
        assignments: z.array(AssignmentSchema, { error: "must be a list." }).nullish(),
        calendarNext60Days: z.array(CalendarSchema, { error: "must be a list." }).nullish(),
      }),
      { error: "courses must be a list." },
    )
    .min(1, { error: "courses is empty." }),
  gradesFirstCourseOnly: z.array(z.unknown(), { error: "must be a list." }).nullish(),
  notKnownYet: z.unknown().optional(),
});
export type SeedAccount = z.infer<typeof SeedAccountSchema>;

/** A weight: a number, or text like "40%" / "0.4". */
const WeightValue = z.union([z.number(), z.string().regex(/^\s*\d+(?:[.,]\d+)?\s*%?\s*$/)], {
  error: 'weight must be a number or text like "40%".',
});

const GradeItemSchema = z.union(
  [
    z
      .looseObject({
        name: z.string().nullish(),
        item: z.string().nullish(),
        title: z.string().nullish(),
        label: z.string().nullish(),
        weight: WeightValue.nullish(),
        percent: WeightValue.nullish(),
        pct: WeightValue.nullish(),
        share: WeightValue.nullish(),
        weightPct: WeightValue.nullish(),
        max: z.number().positive().nullish(),
        maxPoints: z.number().positive().nullish(),
      })
      .superRefine((g, ctx) => {
        if (!(g.name ?? g.item ?? g.title ?? g.label)?.trim()) ctx.addIssue({ code: "custom", message: "needs a name." });
        if ((g.weight ?? g.weightPct ?? g.percent ?? g.pct ?? g.share) == null) ctx.addIssue({ code: "custom", message: "needs a weight." });
      }),
    z.string().regex(/^.*\S.*?[\s:=(-]\s*\d+(?:[.,]\d+)?\s*%\)?\s*$/, { error: 'a text item must read like "Exam 60%".' }),
  ],
  { error: 'each item must be {name, weight} or text like "Exam 60%".' },
);

export const BundlesAccountSchema = z.looseObject({
  exams: z.array(AccountExamSchema, { error: "must be a list." }).default([]),
  gradeWeights: z
    .array(
      z.looseObject({
        courseCode: nonEmpty("courseCode"),
        items: z.union([z.array(GradeItemSchema), z.record(z.string(), WeightValue)], {
          error: "items must be a list of {name, weight} or a map of name to weight.",
        }),
        passRule: z.unknown().optional(),
        gradeBands: z.unknown().optional(),
        note: z.unknown().optional(),
        source: z.unknown().optional(),
      }),
      { error: "must be a list." },
    )
    .default([]),
  aiAllowed: z.array(z.unknown(), { error: "must be a list." }).optional(),
  unknown: z.unknown().optional(),
  noExam: z.unknown().optional(),
});
export type BundlesAccount = z.infer<typeof BundlesAccountSchema>;

/** The files cannot be seeded: every reason, each naming the file and the path in it. */
export class SeedInvalid extends Error {
  constructor(readonly problems: string[]) {
    super(`Nothing was written; the files do not fit:\n- ${problems.join("\n- ")}`);
    this.name = "SeedInvalid";
  }
}

/** The seed cannot run (for example the user has connected MyCourses since). Nothing was written. */
export class SeedRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedRefused";
  }
}

function issues(file: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${file}${i.path.length ? ` (at ${i.path.join(".")})` : ""}: ${i.message}`);
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

async function readJsonFile(file: string, label: string, problems: string[]): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    problems.push(`${label}: cannot be read (missing?).`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    problems.push(`${label}: is not valid JSON.`);
    return undefined;
  }
}

const normCode = (s: string) => s.trim().toUpperCase();
const sha = (s: string) => createHash("sha256").update(s).digest();
const shaHex = (s: string) => createHash("sha256").update(s).digest("hex");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A stable negative int4 (-1 .. -2^31+1) from text. */
function negativeId(text: string): number {
  return -(1 + (sha(text).readUInt32BE(0) % 2147483647));
}

/** The course's `moodle_id` before she connects: negative, stable, from the code alone. */
export function courseMoodleId(code: string): number {
  return negativeId(`ready-seed:course:${normCode(code)}`);
}

/** An assignment with no Moodle id in the file: negative, from course code + name. */
export function assignmentMoodleId(code: string, name: string): number {
  return negativeId(`ready-seed:assignment:${normCode(code)}:${name.trim()}`);
}

/** The student's identity in the file, when it names one. */
function identityOf(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const user = isRecord(raw.user) ? raw.user : {};
  for (const v of [raw.moodleUserId, raw.userid, raw.userId, user.id]) {
    if ((typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && v.trim() !== "")) return String(v).trim();
  }
  return null;
}

/** What makes a rerun find the same user (only this hash is stored). */
export function seedKeyFor(raw: unknown, accountDirReal: string): string {
  const identity = identityOf(raw);
  const source = isRecord(raw) && typeof raw.source === "string" ? raw.source.trim() : "";
  return shaHex(identity ? `ready-seed:v1:moodle:${source}:${identity}` : `ready-seed:v1:dir:${accountDirReal}`);
}

// ---------------------------------------------------------------------------
// loadSeed: read and validate (no database)
// ---------------------------------------------------------------------------

export type BundleCourse =
  | { kind: "exam"; courseCode: string; folder: string; plan: ImportPlan; source?: CourseBundle }
  | { kind: "studyOnly"; courseCode: string; folder: string; plan: StudyOnlyPlan; source?: StudyOnlyCourse };
// `source` (M3-58): the validated files the plan was made from. `loadSeed` sets it; an upload sends it.

/**
 * One per-course status file as `scripts/moodle/account-status.mjs` (M0-16) writes it:
 * `{ course: {id, shortname, fullname}, assignments: [{ id, name, status, graded, submittedAt,
 * error? }] }`. Read leniently; a file of another shape is simply not a status file.
 */
const StatusFileSchema = z.looseObject({
  course: z.looseObject({ shortname: z.string().nullish(), fullname: z.string().nullish() }),
  assignments: z.array(
    z.looseObject({
      id: moodleIdOrNull,
      name: z.string(),
      status: z.string().nullish(),
      graded: z.boolean().nullish(),
      submittedAt: When,
      error: z.unknown().optional(),
    }),
  ),
});
export type KnownStatus = { courseText: string; id: number | null; name: string; state: AssignmentState; submittedAt: Date | null };

/** Every hand-in status the status files of <account-dir> know (an errored or empty one is not known). */
async function loadStatusFiles(accountDir: string): Promise<KnownStatus[]> {
  const out: KnownStatus[] = [];
  const names = (await readdir(accountDir).catch(() => [] as string[])).filter((n) => n.endsWith(".json") && n !== "account.json").sort();
  for (const n of names) {
    const raw = await readFile(path.join(accountDir, n), "utf8")
      .then((t) => JSON.parse(t) as unknown)
      .catch(() => null);
    const parsed = StatusFileSchema.safeParse(raw);
    if (!parsed.success) continue;
    const courseText = `${parsed.data.course.shortname ?? ""} ${parsed.data.course.fullname ?? ""}`.toUpperCase();
    for (const a of parsed.data.assignments) {
      if (a.error || (a.status == null && !a.graded)) continue;
      out.push({ courseText, id: a.id != null ? Number(a.id) : null, name: normName(a.name), state: stateOf(a.status, a.graded), submittedAt: a.submittedAt ?? null });
    }
  }
  return out;
}
const normName = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export type SeedInput = {
  key: string;
  /** Hand-in statuses from M0-16's per-course files, when <account-dir> holds them. */
  statuses?: KnownStatus[];
  account: SeedAccount;
  bundlesAccount: BundlesAccount | null;
  /** Per course code (upper case): its AI rule from bundles account.json (either shape). */
  aiRules: Map<string, { aiAllowed?: boolean | "unknown"; scope?: string }>;
  bundles: BundleCourse[];
  /** Course folders that could not be read: folder and every reason. */
  bundleProblems: { folder: string; problems: string[] }[];
};

/** Every course folder of the bundles dir that has a seed.json, with its code (read loosely). */
async function bundleFolders(root: string): Promise<{ folder: string; code: string | null }[]> {
  const codeOf = async (dir: string, fallback: string) => {
    const raw = await readFile(path.join(dir, "seed.json"), "utf8")
      .then((t) => JSON.parse(t) as unknown)
      .catch(() => null);
    const r = isRecord(raw) ? raw : {};
    const exam = isRecord(r.exam) ? r.exam : {};
    const code = exam.courseCode ?? r.courseCode ?? fallback;
    return typeof code === "string" && code.trim() ? normCode(code) : null;
  };
  const out: { folder: string; code: string | null }[] = [];
  for (const e of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (await exists(path.join(root, e.name, "seed.json"))) out.push({ folder: e.name, code: await codeOf(path.join(root, e.name), e.name) });
  }
  // A root that holds course folders may also keep a copy of one course at the top; the folders win.
  if (!out.length && (await exists(path.join(root, "seed.json")))) return [{ folder: ".", code: await codeOf(root, path.basename(root)) }];
  return out;
}

export async function loadSeed(accountDir: string, bundlesDir: string): Promise<SeedInput> {
  const problems: string[] = [];
  const accountRaw = await readJsonFile(path.join(accountDir, "account.json"), "<account-dir>/account.json", problems);
  let account: SeedAccount | null = null;
  if (accountRaw !== undefined) {
    const parsed = SeedAccountSchema.safeParse(accountRaw);
    if (parsed.success) account = parsed.data;
    else problems.push(...issues("<account-dir>/account.json", parsed.error));
  }
  if (account) {
    const codes = account.courses.map((c) => normCode(c.code));
    for (const c of new Set(codes.filter((c, i) => codes.indexOf(c) !== i))) problems.push(`<account-dir>/account.json: course ${c} is listed twice.`);
  }

  if (!(await exists(bundlesDir))) problems.push(`<bundles-dir>: ${bundlesDir} cannot be read (missing?).`);
  let bundlesAccount: BundlesAccount | null = null;
  const aiRules: SeedInput["aiRules"] = new Map();
  const bundlesAccountFile = path.join(bundlesDir, "account.json");
  if (await exists(bundlesAccountFile)) {
    const raw = await readJsonFile(bundlesAccountFile, "<bundles-dir>/account.json", problems);
    if (raw !== undefined) {
      const parsed = BundlesAccountSchema.safeParse(raw);
      const rules = AccountSchema.safeParse(raw);
      if (!parsed.success) problems.push(...issues("<bundles-dir>/account.json", parsed.error));
      if (!rules.success) problems.push(...issues("<bundles-dir>/account.json", rules.error));
      if (parsed.success && rules.success) {
        bundlesAccount = parsed.data;
        for (const [code, rule] of Object.entries(rules.data.courses)) aiRules.set(normCode(code), { aiAllowed: rule.aiAllowed, scope: rule.scope });
      }
    }
  }
  if (problems.length || !account) throw new SeedInvalid(problems);

  const bundles: BundleCourse[] = [];
  const bundleProblems: SeedInput["bundleProblems"] = [];
  for (const { folder, code } of await bundleFolders(bundlesDir)) {
    if (!code) {
      bundleProblems.push({ folder, problems: ["seed.json cannot be read or names no course code."] });
      continue;
    }
    try {
      const bundle = await loadBundle(bundlesDir, { courses: [code] });
      for (const c of bundle.courses) bundles.push({ kind: "exam", courseCode: normCode(c.seed.exam.courseCode), folder, plan: planImport(c), source: c });
      for (const c of bundle.studyOnly) bundles.push({ kind: "studyOnly", courseCode: normCode(c.courseCode), folder, plan: planStudyOnly(c), source: c });
    } catch (err) {
      if (!(err instanceof BundleInvalid)) throw err;
      bundleProblems.push({ folder, problems: err.problems });
    }
  }

  return {
    key: seedKeyFor(accountRaw, await realpath(accountDir)),
    statuses: await loadStatusFiles(accountDir),
    account,
    bundlesAccount,
    aiRules,
    bundles,
    bundleProblems,
  };
}

// ---------------------------------------------------------------------------
// planSeed: pure
// ---------------------------------------------------------------------------

type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

export type PlannedAssignment = {
  moodleId: number;
  cmid: number | null;
  name: string;
  dueAt: Date | null;
  cutoffAt: Date | null;
  opensAt: Date | null;
  state: AssignmentState;
  submittedAt: Date | null;
  needsSubmitButton: boolean;
};

export type PlannedEvent = {
  moodleRef: string;
  source: "moodle" | "manual";
  kind: ReturnType<typeof kindFor>;
  title: string;
  startsAt: Date;
};

export type PlannedWeight = { moodleRef: string; name: string; weight: number; max: number; position: number };

export type PlannedCourse = {
  code: string;
  name: string;
  moodleId: number;
  assignments: PlannedAssignment[];
  events: PlannedEvent[];
  weights: PlannedWeight[];
  aiPolicy: ImportPlan["aiPolicy"];
};

export type PlannedExam = {
  courseCode: string;
  title: string;
  kind: "exam" | "quiz";
  at: Date;
  targetPct: number;
};

export type SeedPlan = {
  key: string;
  pulledAt: string | null;
  courses: PlannedCourse[];
  exams: PlannedExam[];
  bundles: BundleCourse[];
  /**
   * Moodle ids of past-due assignments left out because nobody knows whether she handed them in.
   * A rerun removes these from her account when an earlier run of the seed created them.
   */
  skippedAssignmentIds: number[];
  /** Things left out on purpose: an exam with no date, a folder that could not be read. */
  skipped: string[];
  notStored: string[];
  notes: string[];
};

function stateOf(status: string | null | undefined, graded: boolean | null | undefined): AssignmentState {
  if (graded) return "graded";
  if (status === "submitted") return "submitted";
  if (status === "draft") return "draft";
  return "open";
}

function weightNumber(v: number | string): number {
  return typeof v === "number" ? v : Number(v.replace("%", "").replace(",", ".").trim());
}

function gradeItemsOf(code: string, items: BundlesAccount["gradeWeights"][number]["items"]): PlannedWeight[] {
  const list: { name: string; weight: number; max: number | null }[] = Array.isArray(items)
    ? items.map((g) => {
        if (typeof g === "string") {
          const m = /^(.*?)[\s:=(-]*(\d+(?:[.,]\d+)?)\s*%\)?\s*$/.exec(g)!;
          return { name: m[1].trim(), weight: weightNumber(m[2]) / 100, max: null };
        }
        const raw = (g.weight ?? g.weightPct ?? g.percent ?? g.pct ?? g.share)!;
        const asPercent = typeof raw === "string" && raw.includes("%");
        return { name: (g.name ?? g.item ?? g.title ?? g.label)!.trim(), weight: weightNumber(raw) / (asPercent ? 100 : 1), max: g.max ?? g.maxPoints ?? null };
      })
    : Object.entries(items).map(([name, raw]) => ({
        name: name.trim(),
        weight: weightNumber(raw) / (typeof raw === "string" && raw.includes("%") ? 100 : 1),
        max: null,
      }));
  // Plain numbers that add up to more than 1.5 are percents.
  const sum = list.reduce((s, g) => s + g.weight, 0);
  const scale = sum > 1.5 ? 100 : 1;
  return list.map((g, i) => ({
    moodleRef: `seed:${shaHex(`grade:${normCode(code)}:${g.name}`).slice(0, 24)}`,
    name: g.name,
    weight: g.weight / scale,
    max: g.max ?? 100,
    position: i,
  }));
}

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function planSeed(input: SeedInput, now: Date = new Date()): SeedPlan {
  const skipped: string[] = [];
  // "Past" is judged at the moment the files were pulled; without that, at `now`.
  const pulled = toDate(input.account.pulledAt ?? null);
  const cutOff = pulled instanceof Date ? pulled : now;
  const statuses = input.statuses ?? [];
  const skippedAssignmentIds: number[] = [];
  const notStored: string[] = [];
  const notes: string[] = [];
  const problems: string[] = [];
  const { account, bundlesAccount } = input;

  const weightsOf = new Map<string, PlannedWeight[]>();
  const knownCodes = new Set(account.courses.map((c) => normCode(c.code)));
  for (const [i, gw] of (bundlesAccount?.gradeWeights ?? []).entries()) {
    const code = normCode(gw.courseCode);
    if (!knownCodes.has(code)) {
      skipped.push(`Grade weights for ${code}: no such course in <account-dir>/account.json; not stored.`);
      continue;
    }
    if (weightsOf.has(code)) {
      problems.push(`<bundles-dir>/account.json (at gradeWeights.${i}): course ${code} has grade weights twice.`);
      continue;
    }
    weightsOf.set(code, gradeItemsOf(code, gw.items));
    const left = (["passRule", "gradeBands", "note"] as const).filter((k) => gw[k] !== undefined && gw[k] !== null);
    if (left.length) notStored.push(`Grade weights of ${code}: ${left.join(", ")} not stored (no column for them yet).`);
  }

  const courseIds = new Map<number, string>();
  const assignmentIds = new Map<number, string>();
  const plannedCourses: PlannedCourse[] = account.courses.map((c, ci) => {
    const code = normCode(c.code);
    const moodleId = courseMoodleId(code);
    const clash = courseIds.get(moodleId);
    if (clash) problems.push(`<account-dir>/account.json (at courses.${ci}.code): ${code} and ${clash} get the same course number; rename one.`);
    courseIds.set(moodleId, code);

    const planned: PlannedAssignment[] = [];
    for (const [ai, a] of (c.assignments ?? []).entries()) {
      const id = a.id != null ? Number(a.id) : assignmentMoodleId(code, a.name);
      const owner = assignmentIds.get(id);
      if (owner) {
        problems.push(`<account-dir>/account.json (at courses.${ci}.assignments.${ai}): the same assignment id as ${owner}.`);
        continue;
      }
      assignmentIds.set(id, `courses.${ci}.assignments.${ai}`);
      const dueAt = a.dueAt ?? a.due ?? null;
      // Her hand-in status: from the entry itself, else from a status file (by id, else by
      // course and name), else unknown.
      const own = a.status != null || a.graded != null;
      const fromFile = own
        ? undefined
        : (statuses.find((s) => a.id != null && s.id === Number(a.id)) ??
          statuses.find((s) => s.courseText.includes(code) && s.name === normName(a.name)));
      if (!own && !fromFile && dueAt && dueAt.getTime() < cutOff.getTime()) {
        // Past and unknown: never shown as overdue work, never claimed as handed in.
        skippedAssignmentIds.push(id);
        continue;
      }
      planned.push({
        moodleId: id,
        cmid: a.cmid != null ? Number(a.cmid) : null,
        name: a.name.trim(),
        dueAt,
        cutoffAt: a.cutoffAt ?? a.cutoff ?? null,
        opensAt: a.opensAt ?? a.opens ?? null,
        state: fromFile ? fromFile.state : stateOf(a.status, a.graded),
        submittedAt: a.submittedAt ?? fromFile?.submittedAt ?? null,
        needsSubmitButton: a.requiresSubmitPress ?? false,
      });
    }

    const plannedEvents: PlannedEvent[] = [];
    const refs = new Set<string>();
    for (const e of c.calendarNext60Days ?? []) {
      const title = (e.name ?? e.title)!.trim();
      const startsAt = (e.timesort ?? e.timestart ?? e.startsAt ?? e.at ?? e.date)!;
      const mod = (e.modulename ?? e.module ?? "").toLowerCase();
      const moduleKind = mod === "assign" || mod === "quiz" ? mod : "other";
      const hasId = e.id !== null && e.id !== undefined && String(e.id).trim() !== "";
      const moodleRef = hasId ? `event:${String(e.id).trim()}` : `seed:${shaHex(`event:${code}:${title}:${startsAt.toISOString()}`).slice(0, 24)}`;
      if (refs.has(moodleRef)) continue;
      refs.add(moodleRef);
      plannedEvents.push({ moodleRef, source: hasId ? "moodle" : "manual", kind: kindFor(moduleKind, title), title, startsAt });
    }

    const rule = input.aiRules.get(code);
    return {
      code,
      // Named as the course sync names it: the full name without its leading "<code> - ".
      name: nameWithoutCode(c.name.trim(), c.code.trim()).trim(),
      moodleId,
      assignments: planned,
      events: plannedEvents,
      weights: weightsOf.get(code) ?? [],
      aiPolicy: rule ? aiRuleFor(rule.aiAllowed, rule.scope, notes) : null,
    };
  });
  if (account.courses.some((c) => c.starts || c.ends)) notStored.push("Course start and end dates (starts, ends): no column for them.");
  const grades = account.gradesFirstCourseOnly?.length ?? 0;
  if (grades) notStored.push(`gradesFirstCourseOnly: ${plural(grades, "grade")} not stored (grades come with the Moodle sync).`);
  if (account.notKnownYet !== undefined && account.notKnownYet !== null) notStored.push("notKnownYet: not stored.");

  // Exams from bundles account.json, matched to a course bundle's own seed exam.
  const seedExams = new Map<string, ImportPlan["exam"][]>();
  for (const b of input.bundles) if (b.kind === "exam") seedExams.set(b.courseCode, [...(seedExams.get(b.courseCode) ?? []), b.plan.exam]);
  const examList = bundlesAccount?.exams ?? [];
  const plannedExams: PlannedExam[] = [];
  for (const e of examList) {
    const code = normCode(e.courseCode);
    if (!e.at) {
      skipped.push(`Exam "${e.title.trim()}" (${code}): no date yet, not created.`);
      continue;
    }
    if (!knownCodes.has(code)) {
      skipped.push(`Exam "${e.title.trim()}" (${code}): no such course in <account-dir>/account.json; not created.`);
      continue;
    }
    const fromSeed = seedExams.get(code) ?? [];
    const datedHere = examList.filter((x) => normCode(x.courseCode) === code && x.at);
    const twin = fromSeed.find((s) => sameTitle(s.title, e.title)) ?? (fromSeed.length === 1 && datedHere.length === 1 ? fromSeed[0] : undefined);
    if (twin && !sameTitle(twin.title, e.title)) notes.push(`Exam of ${code}: account.json names it "${e.title.trim()}"; the bundle's title "${twin.title}" is kept so its cards attach.`);
    if (e.atIsPlaceholderTime) notes.push(`Exam "${(twin?.title ?? e.title).trim()}" (${code}): the time of day is a placeholder.`);
    const title = (twin?.title ?? e.title).trim();
    if (plannedExams.some((p) => p.courseCode === code && sameTitle(p.title, title))) {
      notes.push(`Exam "${title}" (${code}) is listed twice; the first one is used.`);
      continue;
    }
    plannedExams.push({ courseCode: code, title, kind: examKindOf(e.kind), at: new Date(e.at), targetPct: twin?.targetPct ?? EXAM_TARGET_PCT });
  }
  if (examList.some((e) => (e as Record<string, unknown>).source !== undefined)) notStored.push("Exam sources (exams[].source): not stored.");
  if (bundlesAccount?.unknown !== undefined && bundlesAccount.unknown !== null) notStored.push("unknown: not stored.");
  if (bundlesAccount?.noExam !== undefined && bundlesAccount.noExam !== null) notStored.push("noExam: not stored (a course with no exam needs no row).");

  for (const p of input.bundleProblems) skipped.push(`Bundle folder ${p.folder}: not imported.\n    ${p.problems.join("\n    ")}`);
  if (problems.length) throw new SeedInvalid(problems);
  if (skippedAssignmentIds.length) {
    skipped.push(
      `${plural(skippedAssignmentIds.length, "assignment")} due before the files were pulled, with no hand-in status known: not created ` +
        "(run scripts/moodle/account-status.mjs into <account-dir> to bring them in with their real status).",
    );
  }

  return {
    key: input.key,
    skippedAssignmentIds,
    pulledAt: account.pulledAt ?? null,
    courses: plannedCourses,
    exams: plannedExams,
    bundles: input.bundles,
    skipped,
    notStored,
    notes,
  };
}

// ---------------------------------------------------------------------------
// applySeed: one transaction
// ---------------------------------------------------------------------------

export type SeedCounts = {
  user: Count;
  courses: Count;
  assignments: Count;
  events: Count;
  gradeWeights: Count;
  exams: Count;
  aiPolicy: Count;
};

export type SeedResult = {
  dryRun: boolean;
  userId: string;
  counts: SeedCounts;
  /** One per bundle course folder that went in. */
  imports: (ImportResult | StudyOnlyResult)[];
  skipped: string[];
  notStored: string[];
  notes: string[];
};

const zero = (): Count => ({ created: 0, skipped: 0, updated: 0 });

class DryRunRollback extends Error {
  constructor(readonly result: SeedResult) {
    super("dry run: rolled back");
  }
}

/** The user an earlier run seeded from these files, or null. */
export async function findSeededUser(database: Db, key: string): Promise<{ id: string; displayName: string | null; settings: Record<string, unknown> } | null> {
  const rows = await database
    .select({ id: users.id, displayName: users.displayName, settings: users.settings })
    .from(users)
    .where(sql`${users.settings} -> 'seededFrom' ->> 'key' = ${key}`);
  if (rows.length > 1) throw new SeedRefused("More than one user was seeded from these files; nothing was written.");
  return rows[0] ?? null;
}

const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * One course folder into `userId`'s account: the step a direct run and an upload (M3-58) share.
 * Its own transaction, or a savepoint inside one.
 */
export async function applyBundle(database: Db, userId: string, b: BundleCourse, now: Date): Promise<ImportResult | StudyOnlyResult> {
  return b.kind === "exam" ? applyImport(database, userId, b.plan, { now }) : applyStudyOnly(database, userId, b.plan);
}

/** The account an upload writes into (M3-58): its row, locked until the transaction ends. */
async function accountForUpload(tx: Db, userId: string): Promise<NonNullable<Awaited<ReturnType<typeof findSeededUser>>>> {
  const [row] = await tx
    .select({ id: users.id, displayName: users.displayName, settings: users.settings })
    .from(users)
    .where(eq(users.id, userId))
    .for("update");
  if (!row) throw new SeedRefused("This account does not exist any more. Nothing was written.");
  return row;
}

/**
 * `into` (M3-58, see `applyAccountPart`): write into this existing account instead of the user
 * found or made from `plan.key`. Everything after the user is the same code for both.
 */
export async function applySeed(
  database: Db,
  plan: SeedPlan,
  options: { dryRun?: boolean; name?: string; now?: Date } = {},
  into?: { userId: string },
): Promise<SeedResult> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  try {
    return await database.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const counts: SeedCounts = {
        user: zero(),
        courses: zero(),
        assignments: zero(),
        events: zero(),
        gradeWeights: zero(),
        exams: zero(),
        aiPolicy: zero(),
      };
      const skipped = [...plan.skipped];
      const notes = [...plan.notes];

      // The user. The marker also lists the assignments the seed wrote, so a later run can take
      // back its own rows and nothing else.
      const seededIds = plan.courses.flatMap((c) => c.assignments.map((a) => a.moodleId)).sort((a, b) => a - b);
      const seededBefore = new Set<number>();
      const name = options.name?.trim() || null;
      const found = into ? await accountForUpload(tx, into.userId) : await findSeededUser(tx, plan.key);
      // An upload never names a key: the account keeps the one a direct run gave it, or has none.
      const keptKey = (found?.settings.seededFrom as { key?: unknown } | undefined)?.key;
      const key = into ? (typeof keptKey === "string" ? { key: keptKey } : {}) : { key: plan.key };
      const seededFrom = { ...key, pulledAt: plan.pulledAt, assignmentIds: seededIds };
      let userId: string;
      if (!found) {
        const [row] = await tx.insert(users).values({ displayName: name, settings: { seededFrom } }).returning({ id: users.id });
        userId = row.id;
        counts.user.created += 1;
      } else {
        userId = found.id;
        const [link] = await tx.select({ id: moodleConnections.id }).from(moodleConnections).where(eq(moodleConnections.userId, userId)).limit(1);
        if (link) throw new SeedRefused("This student has connected MyCourses since; the sync owns her account now. Nothing was written.");
        const set: Partial<typeof users.$inferInsert> = {};
        if (name && found.displayName !== name) set.displayName = name;
        const old = found.settings.seededFrom as { pulledAt?: unknown; assignmentIds?: unknown } | undefined;
        if (Array.isArray(old?.assignmentIds)) for (const id of old.assignmentIds) if (typeof id === "number") seededBefore.add(id);
        if (old?.pulledAt !== plan.pulledAt) set.settings = { ...found.settings, seededFrom };
        if (Object.keys(set).length) {
          await tx.update(users).set(set).where(eq(users.id, userId));
          counts.user.updated += 1;
        } else counts.user.skipped += 1;
      }

      // Courses, by their negative moodle_id (else by code), and their AI rule.
      const herCourses = await tx
        .select({ id: courses.id, moodleId: courses.moodleId, code: courses.code, name: courses.name, color: courses.color, aiAssignments: courses.aiAssignments, aiStudy: courses.aiStudy })
        .from(courses)
        .where(eq(courses.userId, userId));
      const used: CourseColor[] = herCourses.map((c) => c.color);
      const courseIdOf = new Map<string, string>();
      for (const c of plan.courses) {
        let row = herCourses.find((r) => r.moodleId === c.moodleId) ?? herCourses.find((r) => r.code !== null && normCode(r.code) === c.code);
        if (!row) {
          const color = nextColor(used);
          used.push(color);
          const [inserted] = await tx.insert(courses).values({ userId, moodleId: c.moodleId, code: c.code, name: c.name, color }).returning();
          row = inserted;
          counts.courses.created += 1;
        } else if (row.name !== c.name || row.code !== c.code) {
          await tx.update(courses).set({ name: c.name, code: c.code }).where(eq(courses.id, row.id));
          counts.courses.updated += 1;
        } else counts.courses.skipped += 1;
        courseIdOf.set(c.code, row.id);
        if (c.aiPolicy) {
          if (row.aiAssignments === c.aiPolicy.aiAssignments && row.aiStudy === c.aiPolicy.aiStudy) counts.aiPolicy.skipped += 1;
          else {
            await tx.update(courses).set(c.aiPolicy).where(eq(courses.id, row.id));
            counts.aiPolicy.updated += 1;
          }
        }
      }

      // Assignments, by (user, moodle_id).
      const allAssignments = plan.courses.flatMap((c) => c.assignments.map((a) => ({ courseId: courseIdOf.get(c.code)!, ...a })));
      const existingA = allAssignments.length
        ? await tx.select().from(assignments).where(and(eq(assignments.userId, userId), inArray(assignments.moodleId, allAssignments.map((a) => a.moodleId))))
        : [];
      const aOf = new Map(existingA.map((a) => [a.moodleId, a]));
      for (const a of allAssignments) {
        const row = aOf.get(a.moodleId);
        if (!row) {
          await tx.insert(assignments).values({ userId, ...a });
          counts.assignments.created += 1;
          continue;
        }
        const same =
          row.courseId === a.courseId &&
          row.cmid === a.cmid &&
          row.name === a.name &&
          sameTime(row.dueAt, a.dueAt) &&
          sameTime(row.cutoffAt, a.cutoffAt) &&
          sameTime(row.opensAt, a.opensAt) &&
          row.state === a.state &&
          sameTime(row.submittedAt, a.submittedAt) &&
          row.needsSubmitButton === a.needsSubmitButton;
        if (same) counts.assignments.skipped += 1;
        else {
          await tx.update(assignments).set(a).where(eq(assignments.id, row.id));
          counts.assignments.updated += 1;
        }
      }

      // Past-due assignments this run leaves out, that an earlier run of the seed created: remove
      // them. Only the seed's own rows: ids it derived itself (negative) or listed in its marker.
      const mine = plan.skippedAssignmentIds.filter((id) => id < 0 || seededBefore.has(id));
      if (mine.length) {
        const gone = await tx
          .delete(assignments)
          .where(and(eq(assignments.userId, userId), inArray(assignments.moodleId, mine)))
          .returning({ id: assignments.id });
        if (gone.length) notes.push(`Removed ${plural(gone.length, "past-due assignment")} an earlier run created (hand-in status unknown).`);
      }
      if (found) {
        const old = (found.settings.seededFrom as { assignmentIds?: unknown } | undefined)?.assignmentIds;
        if (JSON.stringify(old ?? null) !== JSON.stringify(seededIds)) {
          await tx.update(users).set({ settings: { ...found.settings, seededFrom } }).where(eq(users.id, userId));
        }
      }

      // Calendar entries, by moodle_ref.
      const allEvents = plan.courses.flatMap((c) => c.events.map((e) => ({ courseId: courseIdOf.get(c.code)!, ...e })));
      const existingE = allEvents.length
        ? await tx.select().from(events).where(and(eq(events.userId, userId), inArray(events.moodleRef, allEvents.map((e) => e.moodleRef))))
        : [];
      const eOf = new Map(existingE.map((e) => [e.moodleRef, e]));
      for (const e of allEvents) {
        const row = eOf.get(e.moodleRef);
        if (!row) {
          await tx.insert(events).values({ userId, ...e });
          counts.events.created += 1;
        } else if (row.courseId === e.courseId && row.title === e.title && row.kind === e.kind && sameTime(row.startsAt, e.startsAt)) {
          counts.events.skipped += 1;
        } else {
          await tx.update(events).set({ courseId: e.courseId, title: e.title, kind: e.kind, startsAt: e.startsAt }).where(eq(events.id, row.id));
          counts.events.updated += 1;
        }
      }

      // Grade weights, by moodle_ref; source 'manual' (from the syllabus).
      const allWeights = plan.courses.flatMap((c) => c.weights.map((w) => ({ courseId: courseIdOf.get(c.code)!, ...w })));
      const existingW = allWeights.length
        ? await tx.select().from(gradeItems).where(and(eq(gradeItems.userId, userId), inArray(gradeItems.moodleRef, allWeights.map((w) => w.moodleRef))))
        : [];
      const wOf = new Map(existingW.map((w) => [w.moodleRef, w]));
      for (const w of allWeights) {
        const row = wOf.get(w.moodleRef);
        const values = { courseId: w.courseId, name: w.name, weight: w.weight, weightSource: "manual" as const, max: w.max, position: w.position };
        if (!row) {
          await tx.insert(gradeItems).values({ userId, moodleRef: w.moodleRef, ...values });
          counts.gradeWeights.created += 1;
        } else if (
          row.courseId === w.courseId &&
          row.name === w.name &&
          Math.abs((row.weight ?? -1) - w.weight) < 1e-9 &&
          row.weightSource === "manual" &&
          row.max === w.max &&
          row.position === w.position
        ) {
          counts.gradeWeights.skipped += 1;
        } else {
          await tx.update(gradeItems).set(values).where(eq(gradeItems.id, row.id));
          counts.gradeWeights.updated += 1;
        }
      }

      // Exams, by course + title; account.json's date and kind win.
      for (const e of plan.exams) {
        const courseId = courseIdOf.get(e.courseCode)!;
        const [row] = await tx
          .select()
          .from(exams)
          .where(and(eq(exams.userId, userId), eq(exams.courseId, courseId), eq(exams.title, e.title)))
          .limit(1);
        if (!row) {
          await tx.insert(exams).values({ userId, courseId, title: e.title, kind: e.kind, at: e.at, targetPct: e.targetPct });
          counts.exams.created += 1;
        } else if (sameTime(row.at, e.at) && row.kind === e.kind) counts.exams.skipped += 1;
        else {
          await tx.update(exams).set({ at: e.at, kind: e.kind }).where(eq(exams.id, row.id));
          counts.exams.updated += 1;
        }
      }

      // The bundles: each course folder in its own savepoint, so one that fails is reported and skipped.
      const imports: SeedResult["imports"] = [];
      for (const b of plan.bundles) {
        try {
          imports.push(await applyBundle(tx, userId, b, now));
        } catch (err) {
          if (!(err instanceof ImportFailed)) throw err;
          skipped.push(`Bundle folder ${b.folder} (${b.courseCode}): not imported. ${err.message}`);
        }
      }
      if (plan.bundles.some((b) => b.kind === "exam")) {
        // The importer reports an exam whose date differs from the seed's; account.json's date was kept on purpose.
        notes.push("Where a bundle's seed gives another exam date than account.json, account.json's date is kept.");
      }

      const result: SeedResult = { dryRun, userId, counts, imports, skipped, notStored: plan.notStored, notes };
      if (dryRun) throw new DryRunRollback(result);
      return result;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.result;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The one-time link (GET /open?code=...)
// ---------------------------------------------------------------------------

export const OPEN_PURPOSE = "open";
export const OPEN_TTL_MS = 15 * 60 * 1000;
/** 32 random bytes as base64url, no padding. */
const OPEN_CODE = /^[A-Za-z0-9_-]{43}$/;

/**
 * A fresh one-time code for `userId`, valid 15 minutes. Only its sha256 is stored; the code is
 * returned once, to be printed, and never written anywhere. Earlier unused codes stop working.
 */
export async function mintOpenLink(database: Db, userId: string, now: Date = new Date()): Promise<{ code: string; expiresAt: Date }> {
  const code = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + OPEN_TTL_MS);
  await database.transaction(async (tx) => {
    await tx
      .update(confirmCodes)
      .set({ usedAt: now })
      .where(and(eq(confirmCodes.userId, userId), eq(confirmCodes.purpose, OPEN_PURPOSE), isNull(confirmCodes.usedAt)));
    await tx.insert(confirmCodes).values({ userId, purpose: OPEN_PURPOSE, payloadHash: hashToken(code), expiresAt });
  });
  return { code, expiresAt };
}

/** `${origin}/open?code=...` */
export function openUrl(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}/open?code=${encodeURIComponent(code)}`;
}

/**
 * Uses a code: marks it used (one UPDATE, so two requests with it cannot both win), then makes
 * a new device session for its user, as `ensureSessionFor` does (random token, only its hash
 * stored). Wrong, used, expired or another purpose: null, and nothing changes.
 */
export async function redeemOpenCode(
  database: Db,
  code: string | null | undefined,
  opts: { now?: Date; userAgent?: string | null } = {},
): Promise<{ userId: string; token: string } | null> {
  if (typeof code !== "string" || !OPEN_CODE.test(code)) return null;
  const now = opts.now ?? new Date();
  const expected = hashToken(code);
  return database.transaction(async (tx) => {
    const [row] = await tx
      .update(confirmCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(confirmCodes.purpose, OPEN_PURPOSE),
          eq(confirmCodes.payloadHash, expected),
          isNull(confirmCodes.usedAt),
          gt(confirmCodes.expiresAt, now),
        ),
      )
      .returning({ userId: confirmCodes.userId, payloadHash: confirmCodes.payloadHash });
    // The row was found by its hash; compare again in constant time all the same.
    if (!row || !timingSafeEqual(Buffer.from(row.payloadHash, "hex"), Buffer.from(expected, "hex"))) return null;
    const token = newToken();
    await tx.insert(sessions).values({ userId: row.userId, tokenHash: hashToken(token), userAgent: opts.userAgent ?? null });
    return { userId: row.userId, token };
  });
}

// ---------------------------------------------------------------------------
// Upload (M3-58): the same seed, sent to POST /api/seed one part at a time
// ---------------------------------------------------------------------------
//
// The tool has the files and no database address; the app has the database. So the tool sends
// what `loadSeed` read and validated (never a finished plan), and the app validates it again
// with the same schemas and runs `planSeed` / `planImport` and the apply code above itself.
// Dates, content hashes and page hashes are therefore always computed by the server, by the
// code a direct run uses, and a caller can never hand in a hash or a key of its own.
//
//   const input = await loadSeed(accountDir, bundlesDir);
//   const parts = seedPartsOf(input);                 // account first, then each bundle's batches
//   for (const p of parts) answers.push(await post(serialisePart(p)));   // POST /api/seed
//   const summary = combineAnswers(planSeed(input), answers);            // what a direct run prints
//
// The parts (JSON):
// - `{ part: "account", account, bundlesAccount, statuses, seeds }`: <account-dir>/account.json
//   and <bundles-dir>/account.json as validated, the hand-in statuses of the status files, and
//   each exam bundle's seed.json (so its exam is matched to account.json's as in a direct run).
// - `{ part: "bundle", kind: "exam", courseCode, batch: {n, of}, seed, map, account, pages,
//   decks: [{lecture, file, cards, indexes}], documents: [{file, text}] }`: one course folder.
//   `seed`, `map` and `account` (its AI rule) go in every batch, because concepts, their order
//   and the study start are planned from them. Batch 1 also carries every Markdown file of
//   `exam/`; pages and cards fill batches up to the size limit. `cards` are the deck's cards as
//   written, `indexes` their 1-based places in the deck file. Only cards the local plan keeps are
//   sent, so a card repeated in another batch can never be taken for an edit of the first.
// - `{ part: "bundle", kind: "studyOnly", courseCode, batch, seed, account, pages }`.
// Things that only shape the printed report (problem lines, what is not stored, folder names)
// stay on the tool's side: `combineAnswers` takes them from the local plan.
//
// Whose account: the caller's, always. `applyAccountPart` and `applyBundlePart` take the user id
// from the session; the parts have no place for one. The marker (`settings.seededFrom`) of an
// uploaded account has no `key` (a key is what lets a direct run find "its" user, and must
// never come from a request); it keeps `pulledAt` and the assignment ids the seed wrote, so
// the removal rule for past-due rows works as in a direct run.
//
// MyCourses: the account part is refused once the account has a Moodle connection (the sync
// owns courses, assignments, calendar and grades then, exactly as for a direct run, and the
// removal rule can therefore never meet a row a sync wrote). Bundle parts are study content
// and go into a connected account too, onto the course the sync made.

/** The most one request body may be. */
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
/** What the splitter fills a request to: under the limit, with room to spare. */
export const UPLOAD_PART_BYTES = 3_500_000;

const wholeNumber = (what: string) => z.number({ error: `${what} must be a whole number.` }).int({ error: `${what} must be a whole number.` });

/** A file name inside a course folder (only ever used in messages). */
const relFile = z
  .string({ error: "file must be text." })
  .trim()
  .min(1, { error: "file is empty." })
  .max(300, { error: "file is too long." })
  .refine((f) => !path.isAbsolute(f) && !f.split(/[\\/]/).includes(".."), { error: "file must be inside the course folder." });

const BatchSchema = z
  .object({ n: wholeNumber("batch.n").min(1), of: wholeNumber("batch.of").min(1) }, { error: "batch must be {n, of}." })
  .refine((b) => b.n <= b.of, { error: "batch.n is above batch.of." });

const AiRuleSchema = z
  .object({ aiAllowed: z.union([z.boolean(), z.literal("unknown")], { error: 'aiAllowed must be true, false or "unknown".' }).optional(), scope: z.string().optional() })
  .nullable()
  .default(null);

const PagesSchema = z
  .array(z.object({ lecture: wholeNumber("lecture"), file: relFile, page: PageSchema }), { error: "pages must be a list." })
  .default([]);

const KnownStatusSchema = z.object({
  courseText: z.string(),
  id: wholeNumber("id").nullable(),
  name: z.string(),
  state: z.enum(ASSIGNMENT_STATES, { error: `state must be one of ${ASSIGNMENT_STATES.join(", ")}.` }),
  submittedAt: When,
});

const AccountPartSchema = z.object({
  part: z.literal("account"),
  account: SeedAccountSchema,
  bundlesAccount: BundlesAccountSchema.nullable().default(null),
  statuses: z.array(KnownStatusSchema, { error: "statuses must be a list." }).default([]),
  seeds: z.array(z.object({ courseCode: nonEmpty("courseCode"), seed: SeedSchema }), { error: "seeds must be a list." }).default([]),
});
export type AccountPart = z.infer<typeof AccountPartSchema>;

const ExamBundlePartSchema = z.object({
  part: z.literal("bundle"),
  kind: z.literal("exam"),
  courseCode: nonEmpty("courseCode"),
  batch: BatchSchema,
  seed: SeedSchema,
  map: MapSchema.nullable().default(null),
  account: AiRuleSchema,
  pages: PagesSchema,
  decks: z
    .array(
      z
        .object({ lecture: wholeNumber("lecture"), file: relFile, cards: DeckFileSchema, indexes: z.array(wholeNumber("Each index").min(1), { error: "indexes must be a list." }) })
        .refine((d) => d.cards.length === d.indexes.length, { error: "cards and indexes must be the same length." }),
      { error: "decks must be a list." },
    )
    .default([]),
  documents: z.array(z.object({ file: relFile, text: z.string({ error: "text must be text." }) }), { error: "documents must be a list." }).default([]),
});
export type ExamBundlePart = z.infer<typeof ExamBundlePartSchema>;

const StudyBundlePartSchema = z.object({
  part: z.literal("bundle"),
  kind: z.literal("studyOnly"),
  courseCode: nonEmpty("courseCode"),
  batch: BatchSchema,
  seed: StudySeedSchema,
  account: AiRuleSchema,
  pages: PagesSchema,
});
export type StudyBundlePart = z.infer<typeof StudyBundlePartSchema>;

export type BundlePart = ExamBundlePart | StudyBundlePart;
export type SeedPart = AccountPart | BundlePart;

/** A request body: Dates become ISO text, which the same schemas read back to the same instants. */
export function serialisePart(part: SeedPart): string {
  return JSON.stringify(part);
}

const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** `<account-dir>` and `<bundles-dir>/account.json` as one part. Pure. */
export function accountPartOf(input: SeedInput): AccountPart {
  return {
    part: "account",
    account: input.account,
    bundlesAccount: input.bundlesAccount,
    statuses: input.statuses ?? [],
    seeds: input.bundles.flatMap((b) => (b.kind === "exam" && b.source ? [{ courseCode: b.courseCode, seed: b.source.seed }] : [])),
  };
}

/**
 * One course folder as requests of at most `maxBytes` each. Pure; `b.source` is what `loadSeed`
 * read. Applying the batches in order gives the rows one direct run gives. Throws `SeedInvalid`
 * when something cannot be sent at all (one page or card larger than a request).
 */
export function bundlePartsOf(b: BundleCourse, maxBytes: number = UPLOAD_PART_BYTES): BundlePart[] {
  const source = b.source;
  if (!source) throw new SeedInvalid([`Bundle folder ${b.folder} (${b.courseCode}): its files were not kept, so it cannot be sent.`]);
  const tooBig = (what: string) => new SeedInvalid([`Bundle folder ${b.folder} (${b.courseCode}): ${what} does not fit in one request (${maxBytes} bytes).`]);
  const rule = source.account ? { aiAllowed: source.account.aiAllowed, scope: source.account.scope } : null;
  const widest = { n: 9999, of: 9999 };

  if (b.kind === "studyOnly") {
    const base = { part: "bundle" as const, kind: "studyOnly" as const, courseCode: b.courseCode, seed: (source as StudyOnlyCourse).seed, account: rule };
    const room = maxBytes - jsonBytes({ ...base, batch: widest, pages: [] });
    if (room < 0) throw tooBig("its seed.json");
    const groups: BundlePage[][] = [[]];
    let used = 0;
    for (const page of source.pages) {
      const cost = jsonBytes(page) + 1;
      if (cost > room) throw tooBig(page.file);
      if (used + cost > room) {
        groups.push([]);
        used = 0;
      }
      groups[groups.length - 1].push(page);
      used += cost;
    }
    return groups.map((pages, i) => ({ ...base, batch: { n: i + 1, of: groups.length }, pages }));
  }

  const course = source as CourseBundle;
  const base = { part: "bundle" as const, kind: "exam" as const, courseCode: b.courseCode, seed: course.seed, map: course.map, account: rule };
  const documents = course.examDocs.flatMap((d) => (d.text !== undefined ? [{ file: d.file, text: d.text }] : []));
  const room = maxBytes - jsonBytes({ ...base, batch: widest, pages: [], decks: [], documents: [] });
  if (room < 0) throw tooBig("its seed.json and map");

  type Batch = { pages: BundlePage[]; decks: ExamBundlePart["decks"]; documents: ExamBundlePart["documents"] };
  const batches: Batch[] = [{ pages: [], decks: [], documents }];
  let used = documents.reduce((s, d) => s + jsonBytes(d) + 1, 0);
  if (used > room) throw tooBig("its seed.json, map and exam documents together");
  const next = () => {
    batches.push({ pages: [], decks: [], documents: [] });
    used = 0;
  };
  for (const page of course.pages) {
    const cost = jsonBytes(page) + 1;
    if (cost > room) throw tooBig(page.file);
    if (used + cost > room) next();
    batches[batches.length - 1].pages.push(page);
    used += cost;
  }
  // Only the cards the plan keeps (valid, and the first of any repeated id or content).
  for (const p of b.plan.cards) {
    const raw = course.decks.find((d) => d.lecture === p.lecture && d.file === p.file)?.cards[p.index - 1];
    if (raw === undefined) continue;
    const wrap = jsonBytes({ lecture: p.lecture, file: p.file, cards: [], indexes: [] }) + 1;
    const cost = jsonBytes(raw) + 1 + String(p.index).length + 1;
    if (cost + wrap > room) throw tooBig(`${p.file} card ${p.index}`);
    const fits = (batch: Batch) => used + cost + (batch.decks.some((d) => d.lecture === p.lecture && d.file === p.file) ? 0 : wrap) <= room;
    if (!fits(batches[batches.length - 1])) next();
    const batch = batches[batches.length - 1];
    let deck = batch.decks.find((d) => d.lecture === p.lecture && d.file === p.file);
    if (!deck) {
      deck = { lecture: p.lecture, file: p.file, cards: [], indexes: [] };
      batch.decks.push(deck);
      used += wrap;
    }
    deck.cards.push(raw);
    deck.indexes.push(p.index);
    used += cost;
  }
  return batches.map((batch, i) => ({ ...base, batch: { n: i + 1, of: batches.length }, ...batch }));
}

/** Every request of an upload, in the order to send them: the account, then each course folder. Pure. */
export function seedPartsOf(input: SeedInput, maxBytes: number = UPLOAD_PART_BYTES): SeedPart[] {
  const account = accountPartOf(input);
  if (Buffer.byteLength(serialisePart(account)) > maxBytes) {
    throw new SeedInvalid([`The account files are larger than one request may be (${maxBytes} bytes).`]);
  }
  return [account, ...input.bundles.flatMap((b) => bundlePartsOf(b, maxBytes))];
}

/** Top-level keys a part must not carry: whose account it is comes from the session alone. */
const NOT_FROM_THE_BODY = ["userId", "user_id", "user", "key", "seededFrom"];

/** Path-named problems of a request body. Quoted values are left out, so no file text is echoed. */
function partIssues(error: z.ZodError, prefix: string[] = []): string[] {
  return error.issues.map((i) => {
    const at = [...prefix, ...i.path.map(String)].join(".");
    return `${at ? `${at}: ` : ""}${i.message.replace(/"[^"]*"/g, '"…"')}`;
  });
}

/**
 * A request body (parsed JSON) as a part, validated with the schemas `loadSeed` and
 * `loadBundle` use. Throws `SeedInvalid` with one path-named line per problem.
 */
export function readSeedPart(body: unknown): SeedPart {
  if (!isRecord(body)) throw new SeedInvalid(['The body must be one part: {"part": "account", ...} or {"part": "bundle", ...}.']);
  const named = NOT_FROM_THE_BODY.filter((k) => k in body);
  if (named.length) throw new SeedInvalid([`${named.join(", ")}: a part cannot say whose account it is for; it goes into the signed-in one.`]);
  const schema =
    body.part === "account"
      ? AccountPartSchema
      : body.part === "bundle" && body.kind === "exam"
        ? ExamBundlePartSchema
        : body.part === "bundle" && body.kind === "studyOnly"
          ? StudyBundlePartSchema
          : null;
  if (!schema) throw new SeedInvalid(['part: must be "account", or "bundle" with kind "exam" or "studyOnly".']);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new SeedInvalid(partIssues(parsed.error));
  const part = parsed.data;
  const problems: string[] = [];
  if (part.part === "account") {
    const codes = part.account.courses.map((c) => normCode(c.code));
    codes.forEach((c, i) => {
      if (codes.indexOf(c) !== i) problems.push(`account.courses.${i}.code: this course is listed twice.`);
    });
    const rules = AccountSchema.safeParse(part.bundlesAccount ?? {});
    if (!rules.success) problems.push(...partIssues(rules.error, ["bundlesAccount"]));
  } else if (part.kind === "exam" && normCode(part.seed.exam.courseCode) !== normCode(part.courseCode)) {
    problems.push("courseCode: is not the course of seed.exam.courseCode.");
  }
  if (problems.length) throw new SeedInvalid(problems);
  return part;
}

/** What the server answers for one part. */
export type SeedAnswer =
  | { part: "account"; counts: SeedCounts; skipped: string[]; notStored: string[]; notes: string[] }
  | { part: "bundle"; kind: "exam"; courseCode: string; batch: { n: number; of: number }; imported: true; counts: ImportCounts; problems: ImportProblem[] }
  | { part: "bundle"; kind: "studyOnly"; courseCode: string; batch: { n: number; of: number }; imported: true; counts: StudyOnlyCounts }
  | { part: "bundle"; kind: "exam" | "studyOnly"; courseCode: string; batch: { n: number; of: number }; imported: false; reason: string };

/**
 * The account part into `userId`'s account: planned here by `planSeed`, applied by `applySeed`'s
 * own code. Throws `SeedInvalid` (the files do not fit) or `SeedRefused` (she has connected
 * MyCourses); nothing is written then.
 */
export async function applyAccountPart(database: Db, userId: string, part: AccountPart, options: { now?: Date } = {}): Promise<SeedAnswer> {
  const now = options.now ?? new Date();
  const rules = AccountSchema.safeParse(part.bundlesAccount ?? {});
  if (!rules.success) throw new SeedInvalid(partIssues(rules.error, ["bundlesAccount"]));
  const aiRules: SeedInput["aiRules"] = new Map();
  if (part.bundlesAccount) for (const [code, rule] of Object.entries(rules.data.courses)) aiRules.set(normCode(code), { aiAllowed: rule.aiAllowed, scope: rule.scope });
  // Each exam bundle's exam (title, target), planned from its seed alone, as `planSeed` needs it.
  const bundles: BundleCourse[] = part.seeds.map(({ seed }) => ({
    kind: "exam",
    courseCode: normCode(seed.exam.courseCode),
    folder: "",
    plan: planImport({ dir: "", seed, map: null, decks: [], pages: [], examDocs: [], examDocProblems: [], account: null }),
  }));
  const plan = planSeed({ key: "", statuses: part.statuses, account: part.account, bundlesAccount: part.bundlesAccount, aiRules, bundles, bundleProblems: [] }, now);
  const result = await applySeed(database, { ...plan, bundles: [] }, { now }, { userId });
  return { part: "account", counts: result.counts, skipped: result.skipped, notStored: result.notStored, notes: result.notes };
}

/**
 * One batch of one course folder into `userId`'s account: planned here by `planImport` /
 * `planStudyOnly`, applied by `applyBundle`. A later batch (`batch.n` above 1) repeats the seed
 * and the map, so of the things batch 1 already wrote it reports only what it changed itself.
 */
export async function applyBundlePart(database: Db, userId: string, part: BundlePart, options: { now?: Date } = {}): Promise<SeedAnswer> {
  const now = options.now ?? new Date();
  const head = { part: "bundle" as const, courseCode: normCode(part.courseCode), batch: part.batch };
  const account = part.account ? { ...part.account, other: [] } : null;
  const later = (counts: Record<string, Count>, own: string[]) => {
    if (part.batch.n > 1) for (const [name, c] of Object.entries(counts)) if (!own.includes(name)) c.skipped = 0;
  };
  try {
    if (part.kind === "studyOnly") {
      const plan = planStudyOnly({ dir: "", courseCode: head.courseCode, seed: part.seed, pages: part.pages, decks: [], deckProblems: [], examFiles: 0, map: null, account });
      const result = (await applyBundle(database, userId, { kind: "studyOnly", courseCode: head.courseCode, folder: "", plan }, now)) as StudyOnlyResult;
      later(result.counts, ["pages"]);
      return { ...head, kind: "studyOnly", imported: true, counts: result.counts };
    }
    const plan = planImport({
      dir: "",
      seed: part.seed,
      map: part.map,
      decks: part.decks.map((d) => ({ lecture: d.lecture, file: d.file, cards: d.cards })),
      pages: part.pages,
      examDocs: part.documents.map((d) => ({ file: d.file, kind: "text" as const, bytes: Buffer.byteLength(d.text), text: d.text })),
      examDocProblems: [],
      account,
    });
    // A card's place in its deck file, not in this batch.
    for (const p of plan.cards) p.index = part.decks.find((d) => d.lecture === p.lecture && d.file === p.file)?.indexes[p.index - 1] ?? p.index;
    const result = (await applyBundle(database, userId, { kind: "exam", courseCode: head.courseCode, folder: "", plan }, now)) as ImportResult;
    later(result.counts, ["pages", "cards"]);
    // What was found while writing; the plan's own lines are the tool's to print.
    return { ...head, kind: "exam", imported: true, counts: result.counts, problems: result.problems.slice(plan.problems.length) };
  } catch (err) {
    if (!(err instanceof ImportFailed)) throw err;
    return { ...head, kind: part.kind, imported: false, reason: err.message };
  }
}

/** What an upload gave, in the shape a direct run's `SeedResult` has (no ids: they stay on the server). */
export type UploadSummary = Omit<SeedResult, "userId" | "imports"> & {
  imports: (Omit<ImportResult, "courseId" | "examId"> | Omit<StudyOnlyResult, "courseId">)[];
};

/**
 * The answers of one upload as one summary, from the local plan (`planSeed(input)`) and what
 * the server said. Counts are the server's, added up over a course folder's batches; problem
 * lines, what is not stored and notes are the local plan's plus what the server found while
 * writing. Pure.
 */
export function combineAnswers(plan: SeedPlan, answers: SeedAnswer[]): UploadSummary {
  const account = answers.find((a) => a.part === "account");
  const counts: SeedCounts =
    account?.part === "account"
      ? account.counts
      : { user: zero(), courses: zero(), assignments: zero(), events: zero(), gradeWeights: zero(), exams: zero(), aiPolicy: zero() };
  const extra = (mine: string[], theirs: string[] | undefined) => [...mine, ...(theirs ?? []).filter((l) => !mine.includes(l))];
  const skipped = extra(plan.skipped, account?.part === "account" ? account.skipped : []);
  const notes = extra(plan.notes, account?.part === "account" ? account.notes : []);
  const add = <C extends Record<string, Count>>(into: C, more: Record<string, Count>): C => {
    for (const [name, c] of Object.entries(more)) {
      const mine = into[name];
      if (!mine) continue;
      mine.created += c.created;
      mine.skipped += c.skipped;
      mine.updated += c.updated;
    }
    return into;
  };

  const imports: UploadSummary["imports"] = [];
  for (const b of plan.bundles) {
    const mine = answers.filter((a) => a.part === "bundle" && a.kind === b.kind && normCode(a.courseCode) === b.courseCode);
    if (!mine.length) continue;
    const refused = mine.find((a) => a.part === "bundle" && !a.imported);
    if (refused?.part === "bundle" && !refused.imported) {
      skipped.push(`Bundle folder ${b.folder} (${b.courseCode}): not imported. ${refused.reason}`);
      continue;
    }
    if (b.kind === "studyOnly") {
      const sum: StudyOnlyCounts = { lectures: zero(), pages: zero(), aiPolicy: zero() };
      for (const a of mine) if (a.part === "bundle" && a.imported) add(sum, a.counts);
      imports.push({
        studyOnly: true,
        dryRun: false,
        courseCode: b.plan.courseCode,
        counts: sum,
        cardsNotImported: b.plan.cardsNotImported,
        summary: studyOnlySummary(sum.pages.created + sum.pages.updated, b.plan.cardsNotImported),
        problems: [...b.plan.problems],
        notStored: b.plan.notStored,
        notes: b.plan.notes,
      });
      continue;
    }
    const sum: ImportCounts = { exam: zero(), concepts: zero(), lectures: zero(), pages: zero(), lectureConcepts: zero(), cards: zero(), documents: zero(), aiPolicy: zero() };
    const problems = [...b.plan.problems];
    const seen = new Set<string>();
    for (const a of mine) {
      if (a.part !== "bundle" || !a.imported) continue;
      add(sum, a.counts);
      // A line every batch repeats (the exam's date differs) is one line.
      for (const p of a.kind === "exam" ? a.problems : []) {
        const id = JSON.stringify([p.file, p.lecture, p.index, p.reason]);
        if (!seen.has(id)) problems.push(p);
        seen.add(id);
      }
    }
    imports.push({ dryRun: false, courseCode: b.plan.exam.courseCode, counts: sum, problems, notStored: b.plan.notStored, notes: b.plan.notes });
  }
  if (plan.bundles.some((b) => b.kind === "exam")) notes.push("Where a bundle's seed gives another exam date than account.json, account.json's date is kept.");
  return { dryRun: false, counts, imports, skipped, notStored: plan.notStored, notes };
}
