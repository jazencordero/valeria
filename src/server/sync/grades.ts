/*
 * Copies her Moodle grade items into `grade_items`.
 *
 *   const { added, updated } = await syncGrades(userId);
 *   await syncGrades(userId, db, deps, { courses: [3101] }); // only these courses
 *
 * Run it after `syncCourses`: it reads the courses we already store.
 *
 * Moodle: one call per course (`getGradeItems`, ../moodle/read/grades), only for
 * her visible courses (`courses.hidden = false`), one after the other, through
 * the same client as every other read (its polite-guest limits apply). If her
 * key may not call the grade report (NotAllowed), that course is left as it is;
 * the others still sync. Any other Moodle error is thrown. Every course is read
 * before anything is written; all writes are one transaction.
 *
 * Rows: one per (user_id, moodle_ref), `moodle_ref = gradeitem:<Moodle id>`.
 * - `name`, `max`, `score`, `graded_at` are Moodle's. `short` is made from the
 *   name (`shortLabel`). `position` is the item's place in Moodle's report for
 *   that course (0, 1, 2...), counting the items we skip, so a hidden item that
 *   is shown later does not move the others.
 * - Weight: Moodle's `weightraw`, a fraction of the course total (0.2 = 20 %).
 *   - A weight she typed (`weight_source 'manual'`, M6-04) is never changed:
 *     neither the weight nor its source.
 *   - Otherwise, when Moodle gives a weight it is written with source 'moodle'.
 *   - When Moodle gives none, a weight Moodle gave before is kept (the report
 *     can simply stop showing the weight column), and an item that never had
 *     one keeps weight and source null, so the app asks her for one.
 * - An item Moodle no longer lists is kept as it is, never deleted, as
 *   ./courses and ./events do: her typed weight hangs off it, and a teacher who
 *   removes an item from the report has not undone her grade.
 * - An item Moodle hides from her (`hidden`: by the teacher, or until a date) is
 *   not added; Moodle does not show it to her, so neither do we. Once Moodle
 *   shows it, the next sync adds it. A row we already store whose item is now
 *   hidden is left as it is, like an item Moodle no longer lists.
 * - A new item with no range (`max` null) is not added: `max` is required and
 *   a guess would skew every percent. A stored row keeps its last `max`.
 * - `due_text` is not Moodle's; it is never written here.
 * `added` counts rows added, `updated` rows that existed and changed.
 *
 * Cut: an item she has not been graded on that Moodle does not list yet (a
 * future exam) does not exist until she adds it (M6-04). No lock: two syncs at
 * the same moment ask Moodle twice; the unique key keeps the rows single.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { gradeItems, WEIGHT_SOURCES } from "@/server/db/schema/grades";
import { moodleConnections } from "@/server/db/schema/moodle";
import { NotAllowed } from "@/server/moodle/client";
import { getConnection } from "@/server/moodle/connect";
import { getGradeItems, type GradeItemRow, type GradeKind } from "@/server/moodle/read/grades";
import { NotConnected } from "./courses";

export type WeightSource = (typeof WEIGHT_SOURCES)[number];

export type SyncGradesResult = { added: number; updated: number };

/** What the sync reads Moodle with. Tests pass their own `getGradeItems`. */
export type SyncGradesDeps = { getGradeItems: typeof getGradeItems };

export type SyncGradesOptions = {
  /** Only these courses (Moodle ids). Default: all her visible courses. */
  courses?: readonly number[];
};

// ---------------------------------------------------------------------------
// Short labels

// Whole words, lower case. Finnish "tentti" in any form, as in ./events.
const EXAM = /^(?:exam|exams|examination|examinations|koe|loppukoe)$|^tent[ti]|^\p{L}*tentt/u;
const MIDTERM = /^(?:midterm|midterms|välikoe|välitentti\p{L}*|välitenti\p{L}*)$/u;
const QUIZ = /^(?:quiz|quizzes)$/u;
const NUMBER = /^\d+(?:\.\d+)?$/u;

const capital = (word: string) => word.charAt(0).toLocaleUpperCase("fi") + word.slice(1);
const stripZeros = (n: string) => n.replace(/^0+(?=\d)/u, "");

/**
 * A short label for a grade item, for chart axes and tight lists. Pure; first
 * rule that fits:
 *
 *   "Midterm exam", "Mid-term", "Välitentti"      Midterm
 *   "Exam", "Final exam", "Tentti"                 Exam
 *   "Exam 2"                                       Exam 2
 *   "Quiz 4: ARIMA", "Week 3 quiz", a Moodle quiz  Q4, Q3 (the number after
 *                                                  "quiz", else the first one)
 *   ... a quiz with no number                      Quiz
 *   "Assignment 1", "Case memo 2", "Tehtävä 3"     A1, M2, T3 (initial of the
 *                                                  word before the first number)
 *   one word: "Essay", "Project"                   Essay, Proj (kept up to six
 *                                                  letters, else its first four)
 *   several words: "Service blueprint"             SB (initials, up to four)
 *
 * Only the part before a colon or dash counts ("Project: final report" is
 * Proj). An empty name has no label (null).
 */
export function shortLabel(name: string, kind: GradeKind | null = null): string | null {
  const head = name.split(/[:–—]|\s-\s/u)[0] ?? "";
  const words: string[] = head
    .replace(/(?<=\p{L})(?=\d)|(?<=\d)(?=\p{L})/gu, " ")
    .match(/[\p{L}]+|\d+(?:\.\d+)?/gu) ?? [];
  if (words.length === 0) return null;
  const lower = words.map((w) => w.toLocaleLowerCase("fi"));
  const firstNumber = words.find((w) => NUMBER.test(w));

  // "Mid-term" and "mid term" arrive as two words.
  const midterm = lower.some((w, i) => MIDTERM.test(w) || (w === "mid" && (lower[i + 1] === "term" || lower[i + 1] === "terms")));
  if (midterm) return "Midterm";

  const examAt = lower.findIndex((w) => EXAM.test(w));
  if (examAt >= 0) {
    const after = words[examAt + 1];
    return after && NUMBER.test(after) ? `Exam ${stripZeros(after)}` : "Exam";
  }

  const quizAt = lower.findIndex((w) => QUIZ.test(w));
  if (quizAt >= 0 || kind === "quiz") {
    const after = quizAt >= 0 ? words[quizAt + 1] : undefined;
    const n = after && NUMBER.test(after) ? after : firstNumber;
    return n ? `Q${stripZeros(n)}` : "Quiz";
  }

  if (firstNumber) {
    const at = words.indexOf(firstNumber);
    const before = words.slice(0, at).reverse().find((w) => !NUMBER.test(w));
    if (before) return `${before.charAt(0).toLocaleUpperCase("fi")}${stripZeros(firstNumber)}`;
  }

  const letters = words.filter((w) => !NUMBER.test(w));
  if (letters.length === 0) return stripZeros(words[0] ?? "");
  if (letters.length === 1) {
    const word = capital(letters[0]);
    return word.length <= 6 ? word : word.slice(0, 4);
  }
  return letters
    .slice(0, 4)
    .map((w) => w.charAt(0).toLocaleUpperCase("fi"))
    .join("");
}

// ---------------------------------------------------------------------------
// Sync

/** Her visible courses' Moodle ids, smallest first: the courses `syncGrades` reads. */
export async function coursesForGrades(userId: string, database: Db = defaultDb): Promise<number[]> {
  const rows = await database
    .select({ moodleId: courses.moodleId })
    .from(courses)
    .where(and(eq(courses.userId, userId), eq(courses.hidden, false)))
    .orderBy(asc(courses.moodleId));
  return rows.map((row) => row.moodleId);
}

type Incoming = {
  moodleRef: string;
  courseId: string;
  name: string;
  short: string | null;
  max: number | null;
  score: number | null;
  gradedAt: Date | null;
  position: number;
  weight: number | null;
};

const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

export async function syncGrades(
  userId: string,
  database: Db = defaultDb,
  deps: SyncGradesDeps = { getGradeItems },
  options: SyncGradesOptions = {},
): Promise<SyncGradesResult> {
  const conn = await getConnection(userId, database);
  const [link] = await database
    .select({ moodleUserId: moodleConnections.moodleUserId })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, userId))
    .limit(1);
  if (!conn || !link) throw new NotConnected();

  const only = options.courses ? new Set(options.courses) : null;
  const visible = (
    await database
      .select({ id: courses.id, moodleId: courses.moodleId })
      .from(courses)
      .where(and(eq(courses.userId, userId), eq(courses.hidden, false)))
      .orderBy(asc(courses.moodleId))
  ).filter((c) => !only || only.has(c.moodleId));

  // Moodle is read before the transaction opens; a failed read changes nothing.
  const incoming = new Map<string, Incoming>();
  for (const course of visible) {
    let items: GradeItemRow[];
    try {
      items = await deps.getGradeItems(conn, course.moodleId, link.moodleUserId);
    } catch (err) {
      if (err instanceof NotAllowed) continue;
      throw err;
    }
    items.forEach((item, position) => {
      if (item.hidden || incoming.has(item.moodleRef)) return;
      incoming.set(item.moodleRef, {
        moodleRef: item.moodleRef,
        courseId: course.id,
        name: item.name,
        short: shortLabel(item.name, item.kind),
        max: item.max,
        score: item.score,
        gradedAt: item.gradedAt,
        position,
        weight: item.weight,
      });
    });
  }
  if (incoming.size === 0) return { added: 0, updated: 0 };

  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const existing = await tx
      .select()
      .from(gradeItems)
      .where(and(eq(gradeItems.userId, userId), inArray(gradeItems.moodleRef, [...incoming.keys()])));
    const rowOf = new Map(existing.map((row) => [row.moodleRef, row]));

    let added = 0;
    let updated = 0;
    for (const item of incoming.values()) {
      const row = rowOf.get(item.moodleRef);
      if (!row) {
        if (item.max === null) continue;
        const inserted = await tx
          .insert(gradeItems)
          .values({
            userId,
            courseId: item.courseId,
            moodleRef: item.moodleRef,
            name: item.name,
            short: item.short,
            max: item.max,
            score: item.score,
            gradedAt: item.gradedAt,
            position: item.position,
            weight: item.weight,
            weightSource: item.weight === null ? null : "moodle",
          })
          .onConflictDoNothing({ target: [gradeItems.userId, gradeItems.moodleRef] })
          .returning({ id: gradeItems.id });
        // No row back means a parallel sync added it first; it is not ours to count.
        if (inserted.length > 0) added += 1;
        continue;
      }

      const takesMoodleWeight = row.weightSource !== "manual" && item.weight !== null;
      const next = {
        courseId: item.courseId,
        name: item.name,
        short: item.short,
        max: item.max ?? row.max,
        score: item.score,
        gradedAt: item.gradedAt,
        position: item.position,
        weight: takesMoodleWeight ? item.weight : row.weight,
        weightSource: takesMoodleWeight ? ("moodle" as const) : row.weightSource,
      };
      const same =
        row.courseId === next.courseId &&
        row.name === next.name &&
        row.short === next.short &&
        row.max === next.max &&
        row.score === next.score &&
        sameTime(row.gradedAt, next.gradedAt) &&
        row.position === next.position &&
        row.weight === next.weight &&
        row.weightSource === next.weightSource;
      if (same) continue;
      await tx
        .update(gradeItems)
        .set(next)
        .where(and(eq(gradeItems.userId, userId), eq(gradeItems.id, row.id)));
      updated += 1;
    }
    return { added, updated };
  });
}
