/**
 * The Assignments tab's data: her visible courses for the filter, the open
 * assignments in the order to do them, and what she has handed in.
 *
 * Reads our database only. Order comes from `buildQueue` (src/lib/queue.ts):
 * earliest due first, overdue first of all, no due date last.
 *
 * - Hidden courses and their assignments are left out entirely.
 * - `course` narrows both lists to one course. An id that is not one of her
 *   visible courses is ignored (the list shows All).
 * - Done is every handed-in assignment, newest hand-in first. Unlike Home, it
 *   is not limited to the last 7 days: this tab is the full list.
 * - Handed in means `submitted_at` is set, or `state` is submitted or graded.
 *   A submitted row without a time uses its first-seen time as its best time.
 * - New uses `isNew`. "Part of the very first sync" is taken as first seen
 *   within FIRST_SYNC_WINDOW_MS of her Moodle connection; with no connection
 *   nothing counts as New.
 */
import { and, asc, eq } from "drizzle-orm";
import { buildQueue, isNew, type QueueAssignment } from "@/lib/queue";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { assignments, drafts } from "@/server/db/schema/work";

/** The first sync runs straight after connecting; anything first seen this close to it came with it. */
export const FIRST_SYNC_WINDOW_MS = 10 * 60 * 1000;

/** Same values as the queue row's status. */
export type OpenStatus = "not_started" | "draft_saved" | "new";

export type FilterCourse = { id: string; name: string };

export type OpenAssignment = {
  id: string;
  title: string;
  courseId: string;
  course: string;
  /** `null` when the course set no due date. */
  dueAt: Date | null;
  estimateMin: number | null;
  status: OpenStatus;
  /** The assignment page (M1-34). */
  href: string;
};

export type DoneAssignment = {
  id: string;
  title: string;
  courseId: string;
  course: string;
  submittedAt: Date;
};

export type AssignmentsView = {
  /** Her visible courses, by name, for the filter chips. */
  courses: FilterCourse[];
  /** The chosen course id, or `null` for All. */
  course: string | null;
  open: OpenAssignment[];
  done: DoneAssignment[];
};

const HANDED_IN = new Set(["submitted", "graded"]);

export function assignmentHref(id: string): string {
  return `/assignments/${id}`;
}

export async function getAssignmentsView(
  userId: string,
  options: { course?: string | null; now: Date },
  database: Db = defaultDb,
): Promise<AssignmentsView> {
  const { now } = options;

  const visible = await database
    .select({ id: courses.id, name: courses.name })
    .from(courses)
    .where(and(eq(courses.userId, userId), eq(courses.hidden, false)))
    .orderBy(asc(courses.name));
  const course = visible.some((c) => c.id === options.course) ? (options.course as string) : null;

  const [connection] = await database
    .select({ connectedAt: moodleConnections.connectedAt })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, userId));

  const rows = await database
    .select({
      id: assignments.id,
      name: assignments.name,
      courseId: assignments.courseId,
      courseName: courses.name,
      dueAt: assignments.dueAt,
      estimateMin: assignments.estimateMin,
      state: assignments.state,
      submittedAt: assignments.submittedAt,
      firstSeenAt: assignments.firstSeenAt,
      seenAt: assignments.seenAt,
      draft: drafts.contentMd,
    })
    .from(assignments)
    .innerJoin(courses, eq(courses.id, assignments.courseId))
    .leftJoin(drafts, eq(drafts.assignmentId, assignments.id))
    .where(
      and(
        eq(assignments.userId, userId),
        eq(courses.userId, userId),
        eq(courses.hidden, false),
        course ? eq(assignments.courseId, course) : undefined,
      ),
    );

  type Row = (typeof rows)[number] & QueueAssignment;
  const items: Row[] = rows.map((r) => ({
    ...r,
    due_at: r.dueAt,
    submitted_at: r.submittedAt ?? (HANDED_IN.has(r.state) ? r.firstSeenAt : null),
    first_seen_at: r.firstSeenAt,
    seen_at: r.seenAt,
    from_first_sync:
      !connection || r.firstSeenAt.getTime() - connection.connectedAt.getTime() <= FIRST_SYNC_WINDOW_MS,
  }));

  const queue = buildQueue(items, now);
  const openRows = queue.first ? [queue.first, ...queue.then] : [];

  const open: OpenAssignment[] = openRows.map((a) => ({
    id: a.id,
    title: a.name,
    courseId: a.courseId,
    course: a.courseName,
    dueAt: a.dueAt,
    estimateMin: a.estimateMin,
    status: isNew(a, now)
      ? "new"
      : a.state === "draft" || (a.draft ?? "").trim() !== ""
        ? "draft_saved"
        : "not_started",
    href: assignmentHref(a.id),
  }));

  const done: DoneAssignment[] = items
    .filter((a): a is Row & { submitted_at: Date } => a.submitted_at !== null)
    .sort((a, b) => b.submitted_at.getTime() - a.submitted_at.getTime() || (a.id < b.id ? -1 : 1))
    .map((a) => ({
      id: a.id,
      title: a.name,
      courseId: a.courseId,
      course: a.courseName,
      submittedAt: a.submitted_at,
    }));

  return { courses: visible, course, open, done };
}
