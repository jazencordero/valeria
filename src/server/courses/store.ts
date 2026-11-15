/**
 * Her courses and one course's lecture path, read from our database (M9-03).
 *
 *   const list = await listCourses(userId);
 *   const view = await courseView(userId, courseId);
 *   await markRead(userId, lectureId);
 *
 * Every function takes the signed-in `userId` and only reads or writes that
 * user's rows; another user's course or lecture looks exactly like one that
 * does not exist (`CourseNotFound`). The database handle comes after the ids
 * and defaults to the app's `db`; functions that depend on the time take
 * `now` last.
 *
 * Choices:
 * - Lecture state is `lectureState` (src/lib/courses/lectures.ts) with the
 *   lecture row id as its ref and the rows with `read_at` as the read set:
 *   done (read), cur (first posted unread), up (later posted unread), soon
 *   (`opens_at` still ahead). Read wins over soon.
 * - Card count per lecture: distinct cards she can study (`status 'active'`)
 *   linked to the lecture through its concepts (lecture_concepts ->
 *   card_concepts). A card on two of the lecture's concepts counts once; a
 *   card on concepts of two lectures counts for both.
 * - When a lecture was posted: `opens_at` when it has one, else the file's
 *   modified time (Moodle's `timemodified`), else when we first saw it.
 * - Deadline flags: one per assignment of the course, `after` = the highest
 *   lecture number posted at or before the due date. Due before every
 *   lecture: after the first lecture. No due date ("date to come"): after the
 *   last lecture. A course with no lectures gives `after: 0`, which the path
 *   draws nowhere. Flags are ordered by `after`, then due date (undated last);
 *   the path (M9-06 `pathGeom`) shows the first flag per lecture.
 * - Finish: the course's last exam or quiz by date. With none, the last dated
 *   deadline, which then is the finish and not also a flag. Neither: null.
 * - Progress (`listCourses`): lectures read / lectures posted (`opens_at` null
 *   or passed), 0 when nothing is posted, never above 1. Hidden courses are
 *   left out; courses are ordered by name.
 * - `markRead` sets `read_at` to `now` once; marking a read lecture again
 *   keeps the first time.
 *
 * Cut: she cannot reorder, rename or hide lectures yet.
 */
import { and, asc, countDistinct, desc, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { COURSE_COLORS, courseFiles, courses } from "@/server/db/schema/courses";
import { lectureConcepts, lectures } from "@/server/db/schema/learn";
import { cardConcepts, cards, EXAM_KINDS, exams } from "@/server/db/schema/study";
import { ASSIGNMENT_STATES, assignments } from "@/server/db/schema/work";
import { lectureState, type Lecture, type LectureStatus } from "@/lib/courses/lectures";
import type { PathFlag } from "@/lib/courses/path";

export class CourseNotFound extends Error {
  constructor(what: "course" | "lecture", id: string) {
    super(`No ${what} ${id} for this user.`);
    this.name = "CourseNotFound";
  }
}

export type CourseColor = (typeof COURSE_COLORS)[number];

export type CourseLecture = {
  id: string;
  n: number;
  title: string;
  fileId: string | null;
  opensAt: Date | null;
  readAt: Date | null;
  /** When it was posted (see the header). */
  postedAt: Date;
  state: LectureStatus;
  /** Active cards linked through its concepts. */
  cards: number;
};

export type DeadlineFlag = PathFlag & {
  kind: "deadline";
  assignmentId: string;
  title: string;
  dueAt: Date | null;
  state: (typeof ASSIGNMENT_STATES)[number];
};

export type CourseFinish =
  | { kind: "exam"; examId: string; title: string; examKind: (typeof EXAM_KINDS)[number]; at: Date; wholeDay: boolean }
  | { kind: "deadline"; assignmentId: string; title: string; at: Date; state: (typeof ASSIGNMENT_STATES)[number] };

export type CourseHead = {
  id: string;
  name: string;
  code: string | null;
  shortName: string | null;
  color: CourseColor;
};

export type CourseView = {
  course: CourseHead;
  lectures: CourseLecture[];
  flags: DeadlineFlag[];
  finish: CourseFinish | null;
};

export type CourseSummary = CourseHead & {
  /** Lectures listed for the course. */
  lectures: number;
  /** Lectures that are open now. */
  posted: number;
  /** Lectures she has marked read. */
  read: number;
  /** read / posted, 0 to 1. */
  progress: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function head(c: typeof courses.$inferSelect): CourseHead {
  return { id: c.id, name: c.name, code: c.code, shortName: c.shortName, color: c.color };
}

function isPosted(opensAt: Date | null, now: Date): boolean {
  return opensAt === null || opensAt.getTime() <= now.getTime();
}

/** Where a deadline sits: after the last lecture posted by its due date (see the header). */
function flagAfter(dueAt: Date | null, ordered: readonly CourseLecture[]): number {
  if (ordered.length === 0) return 0;
  if (dueAt === null) return ordered[ordered.length - 1].n;
  let after: number | null = null;
  for (const l of ordered) {
    if (l.postedAt.getTime() <= dueAt.getTime() && (after === null || l.n > after)) after = l.n;
  }
  return after ?? ordered[0].n;
}

export async function courseView(
  userId: string,
  courseId: string,
  database: Db = defaultDb,
  now: Date = new Date(),
): Promise<CourseView> {
  if (!UUID.test(courseId)) throw new CourseNotFound("course", courseId);
  const [course] = await database
    .select()
    .from(courses)
    .where(and(eq(courses.id, courseId), eq(courses.userId, userId)));
  if (!course) throw new CourseNotFound("course", courseId);

  const rows = await database
    .select({ lecture: lectures, fileModifiedAt: courseFiles.modifiedAt })
    .from(lectures)
    .leftJoin(courseFiles, eq(courseFiles.id, lectures.fileId))
    .where(and(eq(lectures.userId, userId), eq(lectures.courseId, courseId)))
    .orderBy(asc(lectures.n));

  const ids = rows.map((r) => r.lecture.id);
  const counts = ids.length
    ? await database
        .select({ lectureId: lectureConcepts.lectureId, n: countDistinct(cards.id) })
        .from(lectureConcepts)
        .innerJoin(cardConcepts, eq(cardConcepts.conceptId, lectureConcepts.conceptId))
        .innerJoin(cards, eq(cards.id, cardConcepts.cardId))
        .where(and(inArray(lectureConcepts.lectureId, ids), eq(cards.userId, userId), eq(cards.status, "active")))
        .groupBy(lectureConcepts.lectureId)
    : [];
  const cardsOf = new Map(counts.map((c) => [c.lectureId, Number(c.n)]));

  const asLectures: Lecture[] = rows.map(({ lecture: l }) => ({
    n: l.n,
    title: l.title,
    fileRef: l.id,
    url: null,
    section: "",
    postedAt: null,
    opensAt: l.opensAt ? l.opensAt.toISOString() : null,
  }));
  const readSet = new Set(rows.filter((r) => r.lecture.readAt !== null).map((r) => r.lecture.id));
  const states = lectureState(asLectures, readSet, now);

  const list: CourseLecture[] = rows.map(({ lecture: l, fileModifiedAt }, i) => ({
    id: l.id,
    n: l.n,
    title: l.title,
    fileId: l.fileId,
    opensAt: l.opensAt,
    readAt: l.readAt,
    postedAt: l.opensAt ?? fileModifiedAt ?? l.createdAt,
    state: states[i].state,
    cards: cardsOf.get(l.id) ?? 0,
  }));

  const work = await database
    .select()
    .from(assignments)
    .where(and(eq(assignments.userId, userId), eq(assignments.courseId, courseId)));
  const [exam] = await database
    .select()
    .from(exams)
    .where(and(eq(exams.userId, userId), eq(exams.courseId, courseId)))
    .orderBy(desc(exams.at), asc(exams.id))
    .limit(1);

  let finish: CourseFinish | null = null;
  let finishAssignment: string | null = null;
  if (exam) {
    finish = { kind: "exam", examId: exam.id, title: exam.title, examKind: exam.kind, at: exam.at, wholeDay: exam.timeIsPlaceholder };
  } else {
    const last = work
      .filter((a): a is typeof a & { dueAt: Date } => a.dueAt !== null)
      .sort((a, b) => b.dueAt.getTime() - a.dueAt.getTime() || a.id.localeCompare(b.id))[0];
    if (last) {
      finish = { kind: "deadline", assignmentId: last.id, title: last.name, at: last.dueAt, state: last.state };
      finishAssignment = last.id;
    }
  }

  const flags: DeadlineFlag[] = work
    .filter((a) => a.id !== finishAssignment)
    .map((a) => ({
      after: flagAfter(a.dueAt, list),
      kind: "deadline" as const,
      assignmentId: a.id,
      title: a.name,
      dueAt: a.dueAt,
      state: a.state,
    }))
    .sort((a, b) => {
      if (a.after !== b.after) return a.after - b.after;
      const ta = a.dueAt?.getTime() ?? Infinity;
      const tb = b.dueAt?.getTime() ?? Infinity;
      return ta - tb || a.assignmentId.localeCompare(b.assignmentId);
    });

  return { course: head(course), lectures: list, flags, finish };
}

/** Marks one of her lectures read. Throws `CourseNotFound` when it is not hers. */
export async function markRead(
  userId: string,
  lectureId: string,
  database: Db = defaultDb,
  now: Date = new Date(),
): Promise<{ id: string; readAt: Date }> {
  if (!UUID.test(lectureId)) throw new CourseNotFound("lecture", lectureId);
  const [set] = await database
    .update(lectures)
    .set({ readAt: now })
    .where(and(eq(lectures.id, lectureId), eq(lectures.userId, userId), isNull(lectures.readAt)))
    .returning({ id: lectures.id, readAt: lectures.readAt });
  if (set?.readAt) return { id: set.id, readAt: set.readAt };

  const [already] = await database
    .select({ id: lectures.id, readAt: lectures.readAt })
    .from(lectures)
    .where(and(eq(lectures.id, lectureId), eq(lectures.userId, userId)));
  if (!already?.readAt) throw new CourseNotFound("lecture", lectureId);
  return { id: already.id, readAt: already.readAt };
}

/** Her visible courses by name, each with lecture progress (see the header). */
export async function listCourses(
  userId: string,
  database: Db = defaultDb,
  now: Date = new Date(),
): Promise<CourseSummary[]> {
  const list = await database
    .select()
    .from(courses)
    .where(and(eq(courses.userId, userId), eq(courses.hidden, false)))
    .orderBy(asc(courses.name), asc(courses.id));
  if (list.length === 0) return [];

  const rows = await database
    .select({ courseId: lectures.courseId, opensAt: lectures.opensAt, readAt: lectures.readAt })
    .from(lectures)
    .where(
      and(
        eq(lectures.userId, userId),
        inArray(
          lectures.courseId,
          list.map((c) => c.id),
        ),
      ),
    );

  return list.map((c) => {
    const mine = rows.filter((r) => r.courseId === c.id);
    const posted = mine.filter((r) => isPosted(r.opensAt, now)).length;
    const read = mine.filter((r) => r.readAt !== null).length;
    const progress = posted === 0 ? 0 : Math.min(1, read / posted);
    return { ...head(c), lectures: mine.length, posted, read, progress };
  });
}
