/**
 * Exams she adds or corrects herself (ticket M3-13).
 *
 * `listExams`, `addExam`, `updateExam` and `removeExam` take the signed-in
 * `userId` and only ever read or write that user's rows. Like the other
 * server modules, the database handle is the last argument and defaults to
 * the app's `db`.
 *
 * Errors are thrown, never returned, so every function either does its job
 * or throws one of two typed errors:
 * - `ExamNotFound`: the exam or course does not exist or belongs to someone
 *   else. The two cases look the same from outside, so nothing leaks about
 *   other users' ids (same rule as `StudyNotFound` in ./store.ts).
 * - `ExamInvalid`: the input failed validation; `fields` says which field
 *   and why, in words the form can show.
 *
 * Choices:
 * - The target grade 1..5 is stored as `target_pct` with the grade scale's
 *   own steps (src/lib/grades/scale.ts: grade g starts at 40 + 10 g percent),
 *   so 1 → 50, 2 → 60, 3 → 70, 4 → 80, 5 → 90. `targetGradeForPct` reads it
 *   back with `gradeStep`, clamped to 1..5.
 * - The schema has no "source" column, so an exam she added cannot be marked
 *   as hers apart from Moodle's. Hers are written with `event_id` left null;
 *   telling them apart properly needs a schema change (not in this ticket).
 * - Times are Helsinki wall-clock times. The form sends a date
 *   (`YYYY-MM-DD`) and a time (`HH:MM`); `helsinkiToInstant` turns them into
 *   an instant and `instantToHelsinki` turns an instant back into the two
 *   strings for editing. src/lib/dates.ts keeps its own `fromLocal` private,
 *   so the same Intl-based method is repeated here (no offsets hard-coded).
 * - `listExams` orders by `at`, then creation time, then id, so the order is
 *   stable when two exams share a time.
 */
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { gradeStep } from "@/lib/grades/scale";
import { TIME_ZONE } from "@/lib/dates";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { EXAM_KINDS, exams } from "@/server/db/schema/study";

export type Exam = typeof exams.$inferSelect;
export type ExamKind = (typeof EXAM_KINDS)[number];
export type TargetGrade = 1 | 2 | 3 | 4 | 5;

export const TARGET_GRADES: readonly TargetGrade[] = [1, 2, 3, 4, 5];
export const DEFAULT_TARGET_GRADE: TargetGrade = 4;
export const TITLE_MAX = 120;

export class ExamNotFound extends Error {
  constructor(what: "exam" | "course", id: string) {
    super(`No ${what} ${id} for this user.`);
    this.name = "ExamNotFound";
  }
}

/** The fields of the exam form. Error messages are keyed by these. */
export type ExamField = "courseId" | "title" | "kind" | "date" | "time" | "targetGrade" | "at" | "targetPct";
export type ExamFieldErrors = Partial<Record<ExamField, string>>;

export class ExamInvalid extends Error {
  constructor(public readonly fields: ExamFieldErrors) {
    super(`Invalid exam: ${Object.keys(fields).join(", ")}`);
    this.name = "ExamInvalid";
  }
}

// ---------------------------------------------------------------------------
// Target grade

/** Target grade 1..5 as the percentage stored in `target_pct` (50..90). */
export function targetPctForGrade(grade: TargetGrade): number {
  return 40 + 10 * grade;
}

/** The whole target grade for a stored `target_pct`, kept inside 1..5. */
export function targetGradeForPct(pct: number): TargetGrade {
  return Math.min(5, Math.max(1, gradeStep(pct))) as TargetGrade;
}

// ---------------------------------------------------------------------------
// Helsinki wall-clock time

const partsFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

const MINUTE_MS = 60_000;

function localParts(at: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const out: Record<string, number> = {};
  for (const p of partsFormat.formatToParts(at)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return { year: out.year, month: out.month, day: out.day, hour: out.hour === 24 ? 0 : out.hour, minute: out.minute };
}

function offsetAt(ms: number): number {
  const p = localParts(new Date(ms));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The instant a Helsinki date (`YYYY-MM-DD`) and time (`HH:MM`) happen, or
 * null when either string is not a real date or time. A time that does not
 * exist (inside the spring daylight-saving jump) lands just after the jump.
 */
export function helsinkiToInstant(date: string, time: string): Date | null {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) return null;
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [hour, minute] = [Number(t[1]), Number(t[2])];
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null; // 2026-02-30 and the like
  }
  let ms = guess - offsetAt(guess);
  // The offset can differ on either side of a DST change; settle on the one at the answer.
  const second = offsetAt(ms);
  if (guess - second !== ms) ms = guess - second;
  return new Date(ms);
}

/** An instant as the Helsinki date and time strings the form's inputs take. */
export function instantToHelsinki(at: Date): { date: string; time: string } {
  const p = localParts(at);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return { date: `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

// ---------------------------------------------------------------------------
// Validation

const EARLIEST = Date.UTC(2000, 0, 1);
const LATEST = Date.UTC(2100, 0, 1);

const courseId = z.uuid({ error: "Pick a course." });
const title = z
  .string({ error: "Give it a name." })
  .trim()
  .min(1, { error: "Give it a name." })
  .max(TITLE_MAX, { error: `Keep the name under ${TITLE_MAX} characters.` });
const kind = z.enum(EXAM_KINDS, { error: "Pick exam or quiz." });
const at = z
  .date({ error: "Pick a date and time." })
  .refine((d) => d.getTime() >= EARLIEST && d.getTime() < LATEST, { error: "Pick a date between 2000 and 2099." });
const targetPct = z.int({ error: "Pick a target grade." }).min(0).max(100);

const addSchema = z.object({ courseId, title, kind, at, targetPct: targetPct.optional() });
const patchSchema = z
  .object({ courseId, title, kind, at, targetPct })
  .partial()
  .refine((p) => Object.values(p).some((v) => v !== undefined), { error: "Nothing to change." });

export type AddExamInput = { courseId: string; title: string; kind: ExamKind; at: Date; targetPct?: number };
export type ExamPatch = Partial<AddExamInput>;

function fieldErrors(error: z.ZodError): ExamFieldErrors {
  const out: ExamFieldErrors = {};
  for (const issue of error.issues) {
    const key = (issue.path[0] ?? "title") as ExamField;
    out[key] ??= issue.message;
  }
  return out;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ExamInvalid(fieldErrors(result.error));
  return result.data;
}

/** What the form posts, as strings. */
export type ExamFormFields = {
  courseId: string;
  title: string;
  kind: string;
  date: string;
  time: string;
  targetGrade: string;
};

export type ParsedExamForm = { ok: true; input: Required<AddExamInput> } | { ok: false; errors: ExamFieldErrors };

const formSchema = z.object({
  courseId,
  title,
  kind,
  date: z.string().regex(DATE_RE, { error: "Pick a date." }),
  time: z.string().regex(TIME_RE, { error: "Pick a time." }),
  targetGrade: z.enum(["1", "2", "3", "4", "5"], { error: "Pick a target grade from 1 to 5." }),
});

/** Checks the form's strings and turns them into store input (Helsinki time, target as a percentage). */
export function parseExamForm(fields: Partial<ExamFormFields>): ParsedExamForm {
  const result = formSchema.safeParse(fields);
  if (!result.success) return { ok: false, errors: fieldErrors(result.error) };
  const v = result.data;
  const when = helsinkiToInstant(v.date, v.time);
  if (!when) return { ok: false, errors: { date: "That date does not exist." } };
  const checked = at.safeParse(when);
  if (!checked.success) return { ok: false, errors: { date: checked.error.issues[0].message } };
  return {
    ok: true,
    input: {
      courseId: v.courseId,
      title: v.title,
      kind: v.kind,
      at: when,
      targetPct: targetPctForGrade(Number(v.targetGrade) as TargetGrade),
    },
  };
}

// ---------------------------------------------------------------------------
// Ownership

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

async function assertCourse(database: Db, userId: string, id: string): Promise<void> {
  if (!isUuid(id)) throw new ExamNotFound("course", id);
  const [found] = await database
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.id, id), eq(courses.userId, userId)));
  if (!found) throw new ExamNotFound("course", id);
}

async function assertExam(database: Db, userId: string, id: string): Promise<void> {
  if (!isUuid(id)) throw new ExamNotFound("exam", id);
  const [found] = await database
    .select({ id: exams.id })
    .from(exams)
    .where(and(eq(exams.id, id), eq(exams.userId, userId)));
  if (!found) throw new ExamNotFound("exam", id);
}

// ---------------------------------------------------------------------------
// Store

/** Her exams and quizzes, soonest first. */
export async function listExams(userId: string, database: Db = defaultDb): Promise<Exam[]> {
  return database
    .select()
    .from(exams)
    .where(eq(exams.userId, userId))
    .orderBy(asc(exams.at), asc(exams.createdAt), asc(exams.id));
}

/** Adds an exam to one of her courses. `targetPct` defaults to the schema's 80 (grade 4). */
export async function addExam(userId: string, input: AddExamInput, database: Db = defaultDb): Promise<Exam> {
  const v = parse(addSchema, input);
  await assertCourse(database, userId, v.courseId);
  const [row] = await database
    .insert(exams)
    .values({ userId, courseId: v.courseId, title: v.title, kind: v.kind, at: v.at, targetPct: v.targetPct })
    .returning();
  return row;
}

/** Changes the given fields of one of her exams; moving it to another course needs that course to be hers. */
export async function updateExam(
  userId: string,
  examId: string,
  patch: ExamPatch,
  database: Db = defaultDb,
): Promise<Exam> {
  const v = parse(patchSchema, patch);
  await assertExam(database, userId, examId);
  if (v.courseId !== undefined) await assertCourse(database, userId, v.courseId);
  const [row] = await database
    .update(exams)
    .set(v)
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)))
    .returning();
  if (!row) throw new ExamNotFound("exam", examId);
  return row;
}

/** Deletes one of her exams; its concepts, cards and sessions go with it (on delete cascade). */
export async function removeExam(userId: string, examId: string, database: Db = defaultDb): Promise<void> {
  if (!isUuid(examId)) throw new ExamNotFound("exam", examId);
  const gone = await database
    .delete(exams)
    .where(and(eq(exams.id, examId), eq(exams.userId, userId)))
    .returning({ id: exams.id });
  if (gone.length === 0) throw new ExamNotFound("exam", examId);
}
