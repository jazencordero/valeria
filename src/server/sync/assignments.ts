/*
 * Copies her Moodle assignments, and the files attached to each brief, into
 * our `assignments` and `course_files` tables.
 *
 *   const { added, updated } = await syncAssignments(userId);
 *
 * Run it after `syncCourses`: it reads the courses we already store.
 *
 * Rules:
 * - Only her visible courses (`courses.hidden = false`) are asked for. An
 *   assignment in a course we do not store, or in a hidden one, is skipped.
 * - One row per (user_id, moodle_id). `first_seen_at` is set by the insert and
 *   never written again. A row is never deleted here, so her `submissions`,
 *   chat and draft rows stay; an assignment Moodle no longer returns is left
 *   as it is.
 * - State comes from Moodle's hand-in status (`getSubmissionStatus`):
 *
 *     Moodle says                                   state        submitted_at
 *     nothing handed in, or a reopened attempt      'open'       null
 *     a saved draft, Submit not pressed             'draft'      null
 *     handed in                                     'submitted'  Moodle's time
 *     a grade is out                                'graded'     Moodle's time, or
 *                                                                the one we had
 *
 *   Moodle is the source of truth, in both directions: if a teacher reverts a
 *   hand-in to draft, the row goes back to 'draft'.
 * - Status is asked only for assignments that are still open to change: every
 *   one we do not already store as 'graded'. A graded row keeps its state and
 *   time without a Moodle call.
 * - Each brief attachment is one `course_files` row, keyed by
 *   (user_id, moodle_ref) with `moodle_ref = assign:<moodle id>:intro:<file name>`
 *   and `assignment_id` set. `text_status` is 'none' on insert and is never
 *   written again, so text a later job pulled is kept.
 * - `added` and `updated` count assignment rows: new ones, and existing ones
 *   where a stored value changed. A run that finds nothing new writes nothing
 *   and returns {added: 0, updated: 0}. File changes are not counted.
 * - Moodle is read in full before anything is written: a failed read changes
 *   nothing. All writes are one transaction.
 *
 * - Take-over (M3-57): an assignment Moodle returns that we do not store by its id, while
 *   her course holds exactly one seeded assignment with no Moodle id (negative
 *   `moodle_id`, see src/server/study/seed-account.ts) of the same name (trimmed, any
 *   case), is that row: it gets the real `moodle_id` and Moodle's values, so no second row
 *   appears and its chat, draft and hand-ins stay attached. Seeded rows whose file gave a
 *   Moodle id already carry the real one and match as usual. Two seeded rows of one name:
 *   none is taken over; the new one is added beside them.
 *
 * Cut: no time estimate (`estimate_min` stays null until M2-12). A new attempt
 * opened after grading is not noticed. An attachment the teacher removes stays
 * in `course_files`. A replaced attachment (same name, new size) keeps its old
 * `text_status`.
 */
import { and, eq } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { ASSIGNMENT_STATES, assignments } from "@/server/db/schema/work";
import { getConnection } from "@/server/moodle/connect";
import {
  getAssignments,
  getSubmissionStatus,
  type Assignment,
  type SubmissionStatus,
} from "@/server/moodle/read/assignments";
import { NotConnected } from "./courses";

export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

export type SyncAssignmentsResult = { added: number; updated: number };

/** What the sync reads Moodle with. Tests pass their own. */
export type SyncAssignmentsDeps = {
  getAssignments: typeof getAssignments;
  getSubmissionStatus: typeof getSubmissionStatus;
};

/** How many hand-in statuses are asked for at the same time. */
const STATUS_AT_ONCE = 4;

/** Our state for what Moodle says about her hand-in. See the table in the file header. */
export function stateFor(status: Pick<SubmissionStatus, "state">): AssignmentState {
  return status.state === "none" ? "open" : status.state;
}

/** The `course_files.moodle_ref` of one brief attachment. */
export function attachmentRef(assignmentMoodleId: number, fileName: string): string {
  return `assign:${assignmentMoodleId}:intro:${fileName}`;
}

function sameTime(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

export async function syncAssignments(
  userId: string,
  database: Db = defaultDb,
  deps: SyncAssignmentsDeps = { getAssignments, getSubmissionStatus },
): Promise<SyncAssignmentsResult> {
  const conn = await getConnection(userId, database);
  if (!conn) throw new NotConnected();

  const visible = await database
    .select({ id: courses.id, moodleId: courses.moodleId })
    .from(courses)
    .where(and(eq(courses.userId, userId), eq(courses.hidden, false)));
  const courseIdOf = new Map(visible.map((c) => [c.moodleId, c.id]));

  // Moodle is read before the transaction opens; a failed read changes nothing.
  const seen = new Map<number, Assignment>();
  for (const a of await deps.getAssignments(conn, [...courseIdOf.keys()])) {
    if (courseIdOf.has(a.courseMoodleId) && !seen.has(a.moodleId)) seen.set(a.moodleId, a);
  }

  const graded = new Set(
    (
      await database
        .select({ moodleId: assignments.moodleId })
        .from(assignments)
        .where(and(eq(assignments.userId, userId), eq(assignments.state, "graded")))
    ).map((row) => row.moodleId),
  );
  const toAsk = [...seen.keys()].filter((moodleId) => !graded.has(moodleId));
  const statusOf = new Map<number, SubmissionStatus>();
  for (let i = 0; i < toAsk.length; i += STATUS_AT_ONCE) {
    const batch = toAsk.slice(i, i + STATUS_AT_ONCE);
    const answers = await Promise.all(batch.map((moodleId) => deps.getSubmissionStatus(conn, moodleId)));
    batch.forEach((moodleId, n) => statusOf.set(moodleId, answers[n]));
  }

  return database.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const existing = await tx.select().from(assignments).where(eq(assignments.userId, userId));
    const rowOf = new Map(existing.map((row) => [row.moodleId, row]));
    const existingFiles = await tx.select().from(courseFiles).where(eq(courseFiles.userId, userId));
    const fileOf = new Map(existingFiles.map((row) => [row.moodleRef, row]));

    let added = 0;
    let updated = 0;
    for (const a of seen.values()) {
      const courseId = courseIdOf.get(a.courseMoodleId);
      if (!courseId) continue;
      let row = rowOf.get(a.moodleId);
      let tookOver = false;
      if (!row) {
        // M3-57: an assignment seeded from files before she connected, with no Moodle id
        // (negative moodle_id), becomes this one when it is the only one of that name in the course.
        const name = a.name.trim().toLowerCase();
        const seeded = existing.filter((r) => r.moodleId < 0 && r.courseId === courseId && r.name.trim().toLowerCase() === name);
        if (seeded.length === 1) {
          row = seeded[0];
          await tx.update(assignments).set({ moodleId: a.moodleId }).where(eq(assignments.id, row.id));
          row.moodleId = a.moodleId;
          tookOver = true;
        }
      }
      const status = statusOf.get(a.moodleId);

      const fromMoodle = {
        courseId,
        cmid: a.cmid,
        name: a.name,
        introHtml: a.introHtml,
        dueAt: a.dueAt,
        cutoffAt: a.cutoffAt,
        opensAt: a.opensAt,
        acceptsFiles: a.acceptsFiles,
        acceptsText: a.acceptsText,
        needsSubmitButton: a.needsSubmitButton,
        maxFiles: a.maxFiles,
        maxBytes: a.maxBytes,
      };
      // No status means it was not asked for (already graded, or it turned graded
      // while we were reading): the row keeps what it has.
      let state: AssignmentState = row?.state ?? "open";
      let submittedAt: Date | null = row?.submittedAt ?? null;
      if (status) {
        state = stateFor(status);
        // A grade can come with no hand-in time (graded offline); keep the one we had.
        submittedAt = state === "graded" ? (status.submittedAt ?? submittedAt) : status.submittedAt;
      }

      let assignmentId: string;
      if (!row) {
        const inserted = await tx
          .insert(assignments)
          .values({ userId, moodleId: a.moodleId, ...fromMoodle, state, submittedAt })
          .onConflictDoNothing({ target: [assignments.userId, assignments.moodleId] })
          .returning({ id: assignments.id });
        if (inserted.length > 0) {
          assignmentId = inserted[0].id;
          added += 1;
        } else {
          // A parallel sync added it first; it is not ours to count.
          const [theirs] = await tx
            .select({ id: assignments.id })
            .from(assignments)
            .where(and(eq(assignments.userId, userId), eq(assignments.moodleId, a.moodleId)))
            .limit(1);
          if (!theirs) continue;
          assignmentId = theirs.id;
        }
      } else {
        assignmentId = row.id;
        const same =
          row.courseId === fromMoodle.courseId &&
          row.cmid === fromMoodle.cmid &&
          row.name === fromMoodle.name &&
          row.introHtml === fromMoodle.introHtml &&
          sameTime(row.dueAt, fromMoodle.dueAt) &&
          sameTime(row.cutoffAt, fromMoodle.cutoffAt) &&
          sameTime(row.opensAt, fromMoodle.opensAt) &&
          row.acceptsFiles === fromMoodle.acceptsFiles &&
          row.acceptsText === fromMoodle.acceptsText &&
          row.needsSubmitButton === fromMoodle.needsSubmitButton &&
          row.maxFiles === fromMoodle.maxFiles &&
          row.maxBytes === fromMoodle.maxBytes &&
          row.state === state &&
          sameTime(row.submittedAt, submittedAt);
        if (!same) {
          // first_seen_at is not in the set: it stays as the insert wrote it.
          await tx
            .update(assignments)
            .set({ ...fromMoodle, state, submittedAt })
            .where(eq(assignments.id, row.id));
        }
        if (!same || tookOver) updated += 1;
      }

      const done = new Set<string>();
      for (const file of a.attachments) {
        const moodleRef = attachmentRef(a.moodleId, file.name);
        if (done.has(moodleRef)) continue;
        done.add(moodleRef);
        const fromFile = {
          courseId,
          assignmentId,
          name: file.name,
          mime: file.mime || null,
          size: file.size,
          url: file.url,
        };
        const have = fileOf.get(moodleRef);
        if (!have) {
          await tx
            .insert(courseFiles)
            .values({ userId, moodleRef, ...fromFile, textStatus: "none" })
            .onConflictDoNothing({ target: [courseFiles.userId, courseFiles.moodleRef] });
          continue;
        }
        const sameFile =
          have.courseId === fromFile.courseId &&
          have.assignmentId === fromFile.assignmentId &&
          have.name === fromFile.name &&
          have.mime === fromFile.mime &&
          have.size === fromFile.size &&
          have.url === fromFile.url;
        // text_status is not in the set: text a later job pulled is kept.
        if (!sameFile) await tx.update(courseFiles).set(fromFile).where(eq(courseFiles.id, have.id));
      }
    }

    return { added, updated };
  });
}
