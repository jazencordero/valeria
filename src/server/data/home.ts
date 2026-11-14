/**
 * Home's data (M1-27): her first name, her Moodle connection's status, what to
 * do first, what comes after, and the newest hand-in.
 *
 * Reads our database only. The open list and the done list come from
 * `getAssignmentsView` (M1-28), so Home and the Assignments tab always agree on
 * order (`buildQueue`), status chips (Not started / Draft saved / NEW), hrefs
 * and which courses count (hidden ones are left out). Home adds:
 * - `first`: the head of the open list, plus its course code for the hero card.
 * - `then`: the rest of the open list.
 * - `lastDone`: the newest hand-in of the last 7 days (`DONE_WINDOW_MS`), plus
 *   its due time for "5 h 8 min early". Home shows it when nothing is open.
 * - `connection`: `null` when she has never connected (the page sends her to
 *   /connect), else its status ('expired' shows the sign-in banner).
 *
 * Later Home tickets (exams, week strip, grades) extend `HomeView` here.
 */
import { eq } from "drizzle-orm";
import { DONE_WINDOW_MS } from "@/lib/queue";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { MOODLE_STATUSES, moodleConnections } from "@/server/db/schema/moodle";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { getAssignmentsView, type DoneAssignment, type OpenAssignment } from "./assignments";

export type HomeConnection = { status: (typeof MOODLE_STATUSES)[number] };

export type HomeFirst = OpenAssignment & {
  /** Course code for the hero card, for example ISM-E1005. `null` when Moodle gave none. */
  code: string | null;
};

export type HomeDone = DoneAssignment & {
  /** When it was due, for "5 h 8 min early". `null` when there was no due date. */
  dueAt: Date | null;
};

export type HomeView = {
  /** First word of her display name, or `null` when we have none. */
  firstName: string | null;
  connection: HomeConnection | null;
  first: HomeFirst | null;
  then: OpenAssignment[];
  lastDone: HomeDone | null;
};

/** "Valeria Example" gives "Valeria"; empty or missing gives null. */
export function firstNameOf(displayName: string | null | undefined): string | null {
  const first = displayName?.trim().split(/\s+/)[0];
  return first ? first : null;
}

export async function getHomeView(
  userId: string,
  options: { now: Date },
  database: Db = defaultDb,
): Promise<HomeView> {
  const { now } = options;

  const [me] = await database
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const [link] = await database
    .select({ status: moodleConnections.status })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, userId))
    .limit(1);

  const view = await getAssignmentsView(userId, { now }, database);
  const [head, ...then] = view.open;

  let first: HomeFirst | null = null;
  if (head) {
    const [c] = await database
      .select({ code: courses.code })
      .from(courses)
      .where(eq(courses.id, head.courseId))
      .limit(1);
    first = { ...head, code: c?.code ?? null };
  }

  // `done` is newest first and not limited in time; Home keeps the last 7 days.
  const newest = view.done[0];
  let lastDone: HomeDone | null = null;
  if (newest && now.getTime() - newest.submittedAt.getTime() <= DONE_WINDOW_MS) {
    const [a] = await database
      .select({ dueAt: assignments.dueAt })
      .from(assignments)
      .where(eq(assignments.id, newest.id))
      .limit(1);
    lastDone = { ...newest, dueAt: a?.dueAt ?? null };
  }

  return {
    firstName: firstNameOf(me?.displayName),
    connection: link ? { status: link.status } : null,
    first,
    then,
    lastDone,
  };
}
