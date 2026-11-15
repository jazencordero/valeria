/**
 * The Grades list and one course's grade page (M6-08), ready to draw.
 *
 *   const list = await getGradesList(userId);              // every visible course
 *   const page = await getCourseGrades(userId, courseId);  // null: 404
 *   await saveTargetFor(db, userId, courseId, 4);          // "Aiming for 4"
 *
 * Reads our database only: `courses` and `grade_items` (written by M6-02's
 * `syncGrades` and M6-04's weights form). Only her rows; another user's
 * course, a hidden one, an unknown or malformed id all give `null`.
 *
 * Choices:
 * - A score is a percent of the item's range: `score / max · 100` (Moodle's
 *   minimum is 0 for every item we store; `max` 0 or less gives no percent).
 * - Items are in report order (`position`), the chart's x order.
 * - Status per course, at her target: "early" when the course has no items or
 *   nothing is graded yet; "needs_weights" when a weight is missing (the page
 *   shows the weights card); otherwise the verdict: "on" (on track, or
 *   everything graded), "within", "out". What-ifs are not saved, so the list's
 *   trajectory is the one with none set.
 * - Overall: model.ts `overall`, the mean trajectory of the courses that have
 *   graded work and usable weights; `null` when none has.
 * - Short name: `shortNameOf`, as on the Courses tab. Courses by name, as in
 *   the side nav.
 * - Target: `courses.target`, a whole grade 1 to 5 (default 5).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { CourseColor } from "@/components/shell/side-nav";
import type { RowItem } from "@/components/grades/graded-list";
import {
  NEEDS_WEIGHTS,
  normaliseWeights,
  overall,
  soFar,
  trajectory,
  verdict,
  type GradeItem,
} from "@/lib/grades/model";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { gradeItems } from "@/server/db/schema/grades";
import { shortNameOf } from "./courses";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GradeStatus = "on" | "within" | "out" | "early" | "needs_weights";

/** A whole grade she can aim for. */
export type Target = 1 | 2 | 3 | 4 | 5;

/** One grade item as the course page draws it. */
export type GradePageItem = RowItem & {
  /** Chart axis label ("A1", "Exam"); the name when the sync made none. */
  short: string;
};

export type GradesListRow = {
  id: string;
  href: string;
  name: string;
  color: CourseColor;
  status: GradeStatus;
  target: Target;
  /** 0..5 on the trajectory, `null` while too early or without weights. */
  trajectory: number | null;
};

export type GradesList = {
  /** Mean trajectory over the courses that have graded work, `null` when none has. */
  overall: number | null;
  courses: GradesListRow[];
};

export type CourseGrades = {
  course: { id: string; name: string; code: string | null; color: CourseColor; target: Target };
  items: GradePageItem[];
  /** A weight is missing (or there are no items): the page shows the weights card. */
  needsWeights: boolean;
  /** Seeded by hand in points: the page shows the weights and nothing worked out from them. */
  weightsOnly: boolean;
};

export const gradesHref = (courseId: string) => `/grades/${courseId}`;

/** A stored target as a whole grade 1..5 (anything else reads as 5). */
export function targetOf(n: number): Target {
  return Number.isInteger(n) && n >= 1 && n <= 5 ? (n as Target) : 5;
}

/** Her score as a percent of the item's range, or null while not graded. */
export function percentOf(score: number | null, max: number): number | null {
  if (score == null || !(max > 0)) return null;
  return (score / max) * 100;
}

/** Where a course stands at `target`, for the list row. */
export function statusOf(items: readonly GradeItem[], target: number): GradeStatus {
  if (items.length === 0) return "early";
  if (normaliseWeights(items) === NEEDS_WEIGHTS) return "needs_weights";
  if (soFar(items) == null) return "early";
  const v = verdict(items, target);
  switch (v.kind) {
    case "on":
    case "all_graded":
      return "on";
    case "within":
      return "within";
    case "out":
      return "out";
    default:
      return "needs_weights";
  }
}

/** The list's trajectory for a course with this status, no what-ifs. */
function listTrajectory(items: readonly GradeItem[], status: GradeStatus): number | null {
  if (status === "early" || status === "needs_weights") return null;
  const t = trajectory(items);
  return t === NEEDS_WEIGHTS ? null : t;
}

type ItemRow = {
  id: string;
  courseId: string;
  name: string;
  short: string | null;
  weight: number | null;
  max: number;
  score: number | null;
  dueText: string | null;
  moodleRef: string;
};

/**
 * Stopgap (truth audit, 2026-11-15): a course whose grade parts were seeded by hand in points
 * (a part with its own maximum, from a syllabus). Its grade bands are in points and may carry a
 * pass rule, neither of which is stored yet, so anything worked out from the percent scale
 * ("you need about 90%", a verdict, a trajectory) could be false. Such a course shows its
 * weights and what is known, nothing derived, until points mode is wired in.
 */
function weightsOnlyOf(rows: readonly ItemRow[]): boolean {
  return rows.some((r) => r.moodleRef.startsWith("seed:") && r.max !== 100);
}

function toPageItem(r: ItemRow): GradePageItem {
  return {
    id: r.id,
    name: r.name,
    short: r.short?.trim() || r.name,
    weight: r.weight,
    score: percentOf(r.score, r.max),
    ...(r.dueText ? { when: r.dueText } : {}),
  };
}

async function itemsOf(userId: string, courseIds: string[], database: Db): Promise<ItemRow[]> {
  if (courseIds.length === 0) return [];
  return database
    .select({
      id: gradeItems.id,
      courseId: gradeItems.courseId,
      name: gradeItems.name,
      short: gradeItems.short,
      weight: gradeItems.weight,
      max: gradeItems.max,
      score: gradeItems.score,
      dueText: gradeItems.dueText,
      moodleRef: gradeItems.moodleRef,
    })
    .from(gradeItems)
    .where(and(eq(gradeItems.userId, userId), inArray(gradeItems.courseId, courseIds)))
    .orderBy(asc(gradeItems.position), asc(gradeItems.id));
}

/** One row per visible course, and the overall number. */
export async function getGradesList(userId: string, database: Db = defaultDb): Promise<GradesList> {
  const list = await database
    .select({ id: courses.id, name: courses.name, color: courses.color, target: courses.target })
    .from(courses)
    .where(and(eq(courses.userId, userId), eq(courses.hidden, false)))
    .orderBy(asc(courses.name), asc(courses.id));
  const rows = await itemsOf(
    userId,
    list.map((c) => c.id),
    database,
  );

  const perCourse = list.map((c) => {
    const mine = rows.filter((r) => r.courseId === c.id);
    return { course: c, items: mine.map(toPageItem), weightsOnly: weightsOnlyOf(mine) };
  });
  return {
    // A weights-only course has no trajectory, so it does not count in the overall number.
    overall: overall(perCourse.filter((p) => !p.weightsOnly).map((p) => ({ items: p.items }))),
    courses: perCourse.map(({ course, items, weightsOnly }) => {
      const target = targetOf(course.target);
      const status = weightsOnly ? "early" : statusOf(items, target);
      return {
        id: course.id,
        href: gradesHref(course.id),
        name: shortNameOf(course.name),
        color: course.color,
        status,
        target,
        trajectory: listTrajectory(items, status),
      };
    }),
  };
}

/** One course's grade page, or null when it is not hers (or hidden, or the id is malformed). */
export async function getCourseGrades(
  userId: string,
  courseId: string,
  database: Db = defaultDb,
): Promise<CourseGrades | null> {
  if (!UUID.test(courseId)) return null;
  const [c] = await database
    .select({
      id: courses.id,
      name: courses.name,
      code: courses.code,
      color: courses.color,
      target: courses.target,
      hidden: courses.hidden,
    })
    .from(courses)
    .where(and(eq(courses.id, courseId), eq(courses.userId, userId)))
    .limit(1);
  if (!c || c.hidden) return null;

  const rows = await itemsOf(userId, [c.id], database);
  const items = rows.map(toPageItem);
  return {
    course: { id: c.id, name: shortNameOf(c.name), code: c.code, color: c.color, target: targetOf(c.target) },
    items,
    needsWeights: normaliseWeights(items) === NEEDS_WEIGHTS,
    weightsOnly: weightsOnlyOf(rows),
  };
}

export type SaveTargetResult = { ok: true } | { ok: false; message: string };

/**
 * Saves the grade she aims for in one course. Never throws for a bad value or
 * a course that is not hers; returns why instead.
 */
export async function saveTargetFor(
  database: Db,
  userId: string,
  courseId: string,
  target: number,
): Promise<SaveTargetResult> {
  if (!Number.isInteger(target) || target < 1 || target > 5) {
    return { ok: false, message: "Pick a grade from 1 to 5." };
  }
  if (!UUID.test(courseId)) return { ok: false, message: "That course is not in your list any more." };
  const saved = await database
    .update(courses)
    .set({ target })
    .where(and(eq(courses.id, courseId), eq(courses.userId, userId)))
    .returning({ id: courses.id });
  if (saved.length === 0) return { ok: false, message: "That course is not in your list any more." };
  return { ok: true };
}
