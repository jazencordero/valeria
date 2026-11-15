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
 * - The chat workspace (M2-22) also gets the course's id and AI rule
 *   (`ai_assignments`, read by the page through `assignmentHelp`), the stored
 *   chat messages, oldest first (none when no chat exists yet; opening the
 *   page never creates one), and her one draft, if the chat wrote one.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { AiAssignments } from "@/lib/ai-policy";
import { cleanBrief, type CleanBrief } from "@/lib/html/clean";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { assignments, chats, drafts } from "@/server/db/schema/work";
import { shortNameOf } from "./courses";
import { listMessages, type ChatPart } from "@/server/chat/store";
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

/** One stored chat message, as plain data. */
export type AssignmentMessage = {
  id: string;
  role: "user" | "assistant";
  parts: ChatPart[];
};

/** Her draft for this assignment (M2-19). */
export type AssignmentDraft = {
  title: string;
  markdown: string;
};

export type AssignmentPage = {
  id: string;
  title: string;
  course: string;
  courseId: string;
  /** The course's `ai_assignments`. Read it through `assignmentHelp`, never directly. */
  aiAssignments: AiAssignments;
  /** The chat so far, oldest first. Empty for a new chat. */
  messages: AssignmentMessage[];
  /** Null until the chat has written one. */
  draft: AssignmentDraft | null;
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
  /**
   * Whether she has a Moodle connection. False for an account seeded from files (M3-57):
   * its assignments are read-only and the page offers "Connect <LMS> to hand in".
   */
  connected: boolean;
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
      courseId: courses.id,
      courseName: courses.name,
      aiAssignments: courses.aiAssignments,
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

  const [chat] = await database
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.assignmentId, row.id), eq(chats.userId, userId)))
    .limit(1);
  const messages = chat ? await listMessages(userId, chat.id, database) : [];

  const [draft] = await database
    .select({ title: drafts.title, contentMd: drafts.contentMd })
    .from(drafts)
    .where(and(eq(drafts.assignmentId, row.id), eq(drafts.userId, userId)))
    .limit(1);

  const [link] = await database
    .select({ id: moodleConnections.id })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, userId))
    .limit(1);

  const brief = row.introHtml ? cleanBrief(row.introHtml) : null;
  const handedInAt = row.submittedAt ?? (HANDED_IN.has(row.state) ? row.firstSeenAt : null);

  return {
    id: row.id,
    title: row.name,
    course: shortNameOf(row.courseName),
    courseId: row.courseId,
    aiAssignments: row.aiAssignments,
    messages: messages.map((m) => ({ id: m.id, role: m.role, parts: m.parts })),
    draft:
      draft && draft.contentMd.trim() !== ""
        ? { title: draft.title?.trim() || row.name, markdown: draft.contentMd }
        : null,
    dueAt: row.dueAt,
    handedInAt,
    brief: brief && brief.html.trim() !== "" ? brief : null,
    files: files.map((f) => ({
      id: f.id,
      name: f.name,
      mime: f.mime,
      course: shortNameOf(row.courseName),
      readable: f.textStatus !== "failed",
    })),
    acceptsFiles: row.acceptsFiles,
    maxBytes: row.maxBytes,
    maxFiles: row.maxFiles,
    lms: LMS_NAME,
    lmsUrl: await lmsAssignmentUrl(userId, { cmid: row.cmid, courseMoodleId: row.courseMoodleId }, database),
    connected: link !== undefined,
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
