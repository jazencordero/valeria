/**
 * One assignment page's data (M1-34): the header, the cleaned brief, the
 * files attached to it, and what the hand-in part needs.
 *
 * Reads our database only, plus one write: `markSeen` sets `seen_at` the
 * first time she opens the page (never again, never for anyone else).
 *
 * - Not hers (another user's id, an unknown id, a malformed id) -> null, so
 *   the page answers 404 the same way for all three.
 * - Handed in means `submitted_at` is set, or `state` is submitted or graded
 *   (same rule as the Assignments tab). A handed-in row without a time uses
 *   its first-seen time as its best time.
 * - The brief is cleaned here, on the server (`cleanBrief`); null when Moodle
 *   gave no intro or nothing is left after cleaning.
 * - Sources are the course files linked to this assignment, by name.
 *   `readable` is false only when reading the text failed.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { cleanBrief, type CleanBrief } from "@/lib/html/clean";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { assignments } from "@/server/db/schema/work";
import { LMS_NAME, lmsAssignmentUrl } from "@/server/handin/prepare";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDED_IN = new Set(["submitted", "graded"]);

export type AssignmentSource = {
  id: string;
  name: string;
  mime: string | null;
  course: string;
  readable: boolean;
};

export type AssignmentPage = {
  id: string;
  title: string;
  course: string;
  dueAt: Date | null;
  /** When it was handed in; null while open. */
  handedInAt: Date | null;
  brief: CleanBrief | null;
  files: AssignmentSource[];
  acceptsFiles: boolean;
  maxBytes: number | null;
  maxFiles: number | null;
  /** The school's LMS name for the copy. */
  lms: string;
  /** This assignment on the LMS (its own page, or its course page). */
  lmsUrl: string;
};

export async function getAssignmentPage(
  userId: string,
  assignmentId: string,
  database: Db = defaultDb,
): Promise<AssignmentPage | null> {
  if (!UUID.test(userId) || !UUID.test(assignmentId)) return null;

  const [row] = await database
    .select({
      id: assignments.id,
      name: assignments.name,
      introHtml: assignments.introHtml,
      dueAt: assignments.dueAt,
      state: assignments.state,
      submittedAt: assignments.submittedAt,
      firstSeenAt: assignments.firstSeenAt,
      acceptsFiles: assignments.acceptsFiles,
      maxBytes: assignments.maxBytes,
      maxFiles: assignments.maxFiles,
      cmid: assignments.cmid,
      courseName: courses.name,
      courseMoodleId: courses.moodleId,
    })
    .from(assignments)
    .innerJoin(courses, eq(courses.id, assignments.courseId))
    .where(and(eq(assignments.id, assignmentId), eq(assignments.userId, userId), eq(courses.userId, userId)))
    .limit(1);
  if (!row) return null;

  const files = await database
    .select({
      id: courseFiles.id,
      name: courseFiles.name,
      mime: courseFiles.mime,
      textStatus: courseFiles.textStatus,
    })
    .from(courseFiles)
    .where(and(eq(courseFiles.assignmentId, row.id), eq(courseFiles.userId, userId)))
    .orderBy(asc(courseFiles.name));

  const brief = row.introHtml ? cleanBrief(row.introHtml) : null;
  const handedInAt = row.submittedAt ?? (HANDED_IN.has(row.state) ? row.firstSeenAt : null);

  return {
    id: row.id,
    title: row.name,
    course: row.courseName,
    dueAt: row.dueAt,
    handedInAt,
    brief: brief && brief.html.trim() !== "" ? brief : null,
    files: files.map((f) => ({
      id: f.id,
      name: f.name,
      mime: f.mime,
      course: row.courseName,
      readable: f.textStatus !== "failed",
    })),
    acceptsFiles: row.acceptsFiles,
    maxBytes: row.maxBytes,
    maxFiles: row.maxFiles,
    lms: LMS_NAME,
    lmsUrl: await lmsAssignmentUrl(userId, { cmid: row.cmid, courseMoodleId: row.courseMoodleId }, database),
  };
}

/** Sets `seen_at` the first time she opens it. Only her row, only while it is still null. */
export async function markSeen(
  userId: string,
  assignmentId: string,
  now: Date = new Date(),
  database: Db = defaultDb,
): Promise<void> {
  if (!UUID.test(userId) || !UUID.test(assignmentId)) return;
  await database
    .update(assignments)
    .set({ seenAt: now })
    .where(and(eq(assignments.id, assignmentId), eq(assignments.userId, userId), isNull(assignments.seenAt)));
}
