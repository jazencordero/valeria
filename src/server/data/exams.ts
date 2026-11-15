/**
 * The Exams tab's data (M3-41): her upcoming exams and quizzes, soonest
 * first, each with what the tab card shows, plus her courses for the "Add an
 * exam" form.
 *
 * Reads our database only, by her user id:
 * - Upcoming means `at >= now`. Past exams are left out (no archive).
 * - Exams of a course she has hidden are left out, like its assignments.
 * - Order: `at`, then creation time, then id (the same as `listExams`).
 *
 * The phase, forecast, sparkline history, concept rungs and today's counts
 * are M3-18's `examView`, so the card and the exam page show the same
 * numbers. `examView` reads the signed-in user from the cookie itself and
 * refuses an exam that is not hers; the ids asked for here are already
 * filtered by `userId`, so on a page both name the same person. Tests pass
 * their own `view`.
 *
 * `making` is set while an exam has no concepts yet and its concepts job
 * (M3-14, queued by `queueConcepts`) is still queued or running: the card
 * then says the cards are being made instead of showing a 0% forecast. The
 * lecture count is the course's lectures, or, before those exist, the lecture
 * files with text the job reads. An exam with no job (a course with no
 * lecture files) or a failed one gets the plain card: nothing is being made.
 *
 * `starts` is set before an exam's study start (`exams.start_new_on`, M3-53):
 * the cards then say "Starts Tue 24 Nov. Nothing to do here until then."
 * instead of a forecast, a verdict or a plan.
 */
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { dateLine, dayMonth, daysBetween } from "@/lib/dates";
import { listCourses } from "@/server/courses/store";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { lectures } from "@/server/db/schema/learn";
import { exams } from "@/server/db/schema/study";
import { jobs } from "@/server/db/schema/system";
import { examView, type ExamView } from "@/server/study/actions";
import { CONCEPTS_KIND } from "@/server/study/exams";
import { gradeOfTarget } from "@/server/study/import-bundle";
import { newCardsAllowed } from "@/server/study/start-date";
import { StudyNotFound } from "@/server/study/store";
import { shortNameOf } from "./courses";

export type ExamsTabExam = {
  id: string;
  /** `/exams/<id>`. */
  href: string;
  kind: "exam" | "quiz";
  /** Phase name, for example "Strengthen". */
  phase: string;
  title: string;
  /** The course's short name, for example "Forecasting Methods". */
  course: string;
  /** "FRI 20 NOV · 09:00 · in 6 days". */
  when: string;
  /** Calendar days until the exam in Helsinki; 0 is today. */
  daysLeft: number;
  /** Forecast today, a whole percent. */
  forecast: number;
  spark: { history: number[]; forecast: number; daysLeft: number };
  /** The percent her target grade needs. */
  target: number;
  /** The grade she aims for, as her bundle gave it (`exams.grade_target`); null when it gave none. */
  grade: number | null;
  concepts: { id: string; name: string; rung: number }[];
  counts: { new: number; learning: number; due: number };
  /** Set while the cards are still being made from this many lectures. */
  making?: { lectures: number };
  /** Set before the exam's study start (`exams.start_new_on`): the day it opens, "Tue 24 Nov". */
  starts?: string;
};

export type ExamsTabCourse = { id: string; name: string };

export type ExamsTabView = {
  exams: ExamsTabExam[];
  /** Her visible courses by name, for the form's course picker. */
  courses: ExamsTabCourse[];
};

export type ExamViewLoader = (examId: string) => Promise<ExamView>;

/** "in 6 days", "tomorrow", "today". */
export function inDays(daysLeft: number): string {
  if (daysLeft <= 0) return "today";
  if (daysLeft === 1) return "tomorrow";
  return `in ${daysLeft} days`;
}

/** "FRI 20 NOV · 09:00 · in 6 days". */
export function examWhen(at: Date, now: Date): string {
  return `${dateLine(at)} · ${inDays(daysBetween(now, at))}`;
}

/** The grade 1..5 inside a stored `exams.grade_target` (a number, or an object carrying `grade`); else null. */
export function targetGradeOf(stored: unknown): number | null {
  const inner = typeof stored === "object" && stored !== null ? (stored as { grade?: unknown }).grade : stored;
  const grade = typeof inner === "number" ? gradeOfTarget(inner) : null;
  return grade !== null && Number.isInteger(grade) && grade >= 1 && grade <= 5 ? grade : null;
}

/**
 * Before an exam's study start (`exams.start_new_on`, a Helsinki day): that day as "Tue 24 Nov".
 * Null from that day on, or with no start day (`newCardsAllowed`).
 */
export function startsOn(startNewOn: string | null | undefined, now: Date): string | null {
  if (!startNewOn || newCardsAllowed({ startNewOn }, now)) return null;
  // Noon UTC is the same calendar day in Helsinki, summer or winter.
  return dayMonth(`${startNewOn.slice(0, 10)}T12:00:00Z`);
}

const examHref = (examId: string) => `/exams/${encodeURIComponent(examId)}`;

/** Lectures per course; for a course with none yet, its lecture files with extracted text. */
async function lectureCounts(userId: string, courseIds: string[], database: Db): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (courseIds.length === 0) return out;
  const lectureRows = await database
    .select({ courseId: lectures.courseId })
    .from(lectures)
    .where(and(eq(lectures.userId, userId), inArray(lectures.courseId, courseIds)));
  for (const l of lectureRows) out.set(l.courseId, (out.get(l.courseId) ?? 0) + 1);

  const without = courseIds.filter((id) => !out.has(id));
  if (without.length === 0) return out;
  const fileRows = await database
    .select({ courseId: courseFiles.courseId })
    .from(courseFiles)
    .where(
      and(
        eq(courseFiles.userId, userId),
        inArray(courseFiles.courseId, without),
        eq(courseFiles.textStatus, "done"),
        isNull(courseFiles.assignmentId),
      ),
    );
  for (const f of fileRows) out.set(f.courseId, (out.get(f.courseId) ?? 0) + 1);
  return out;
}

export async function getExamsView(
  userId: string,
  options: { now: Date; view?: ExamViewLoader },
  database: Db = defaultDb,
): Promise<ExamsTabView> {
  const { now, view = examView } = options;

  const [rows, courseList] = await Promise.all([
    database
      .select({
        id: exams.id,
        courseId: exams.courseId,
        title: exams.title,
        kind: exams.kind,
        at: exams.at,
        targetPct: exams.targetPct,
        gradeTarget: exams.gradeTarget,
        startNewOn: exams.startNewOn,
        course: courses.name,
      })
      .from(exams)
      .innerJoin(courses, eq(courses.id, exams.courseId))
      .where(and(eq(exams.userId, userId), eq(courses.userId, userId), eq(courses.hidden, false), gte(exams.at, now)))
      .orderBy(asc(exams.at), asc(exams.createdAt), asc(exams.id)),
    listCourses(userId, database, now),
  ]);
  const formCourses = courseList.map((c) => ({ id: c.id, name: shortNameOf(c.name) }));
  if (rows.length === 0) return { exams: [], courses: formCourses };

  // Exams whose cards are still being made: a live concepts job names them.
  const live = await database
    .select({ examId: sql<string | null>`${jobs.payload}->>'examId'` })
    .from(jobs)
    .where(and(eq(jobs.userId, userId), eq(jobs.kind, CONCEPTS_KIND), inArray(jobs.status, ["queued", "running"])));
  const beingMade = new Set(live.map((j) => j.examId));
  const lecturesIn = await lectureCounts(
    userId,
    [...new Set(rows.filter((r) => beingMade.has(r.id)).map((r) => r.courseId))],
    database,
  );

  const cards = await Promise.all(
    rows.map(async (row): Promise<ExamsTabExam | null> => {
      let v: ExamView;
      try {
        v = await view(row.id);
      } catch (err) {
        // Removed between the list and this read (another tab): leave it out.
        if (err instanceof StudyNotFound) return null;
        throw err;
      }
      const lectureCount = beingMade.has(row.id) ? (lecturesIn.get(row.courseId) ?? 0) : 0;
      const starts = startsOn(row.startNewOn, now);
      return {
        id: row.id,
        href: examHref(row.id),
        kind: row.kind,
        phase: v.phase.name,
        title: row.title,
        course: shortNameOf(row.course),
        when: examWhen(row.at, now),
        daysLeft: v.daysLeft,
        forecast: v.forecastShown,
        spark: { history: v.history, forecast: v.forecast, daysLeft: v.daysLeft },
        target: row.targetPct,
        grade: targetGradeOf(row.gradeTarget),
        concepts: v.concepts.map((c) => ({ id: c.id, name: c.name, rung: c.rung })),
        counts: v.counts,
        ...(v.concepts.length === 0 && lectureCount > 0 ? { making: { lectures: lectureCount } } : {}),
        ...(starts ? { starts } : {}),
      };
    }),
  );

  return { exams: cards.filter((c): c is ExamsTabExam => c !== null), courses: formCourses };
}
