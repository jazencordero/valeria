/*
 * Hand-in, step 1 of 2: the review (ticket M1-32).
 *
 * `prepareHandin` checks the assignment is hers, open and takes files, hashes
 * the file she picked, and stores a one-time confirm code (`confirm_codes`,
 * purpose "handin", 10 minutes). It answers with the review the hand-in sheet
 * shows. Nothing is sent to Moodle here: only her tap on that review, in
 * `./confirm`, can hand in.
 *
 * The code's payload hash is sha-256 over our assignment id and the file's own
 * sha-256, so `./confirm` can tell "same file, same assignment" without us
 * keeping the bytes. The bytes are never stored or logged.
 *
 * Choices:
 * - "Open" means our state is `open` or `draft` (a draft saved in Moodle but
 *   not submitted), Moodle takes hand-ins already (`opens_at` passed) and the
 *   cut-off has not passed. A due date in the past is fine (late hand-in) as
 *   long as there is no cut-off or it is still ahead.
 * - One file, at most 4 MB (M1 cut), and never more than the assignment's
 *   own `max_bytes`.
 * - `needsStatement` is `needs_submit_button`: pressing Submit in Moodle is
 *   where she accepts the submission statement, which `submitForGrading`
 *   sends for her, so the sheet shows the "confirms this is your own work"
 *   line exactly then. (Moodle's own statement setting is not synced.)
 * - `earlyBy` is the `earlyBy` wording with "now" as the hand-in time; null
 *   when the assignment has no due date.
 *
 * Off switch (M1-43): when `handinEnabled()` is false (`HANDIN_ENABLED`, see
 * `@/server/flags`), `prepareHandin` answers `paused` first, before checking
 * the file or storing a code, and never calls Moodle. It returns the reason,
 * the LMS name and the link to the assignment there (`PausedRefusal`), not
 * the sentence: the sheet builds it with `handinPausedMessage(lms)` ("Hand-in
 * from Ready is paused. Hand this one in on <LMS name>."), so the copy lives
 * in one place. The one database read it does is her assignment, for the link
 * (`/mod/assign/view.php?id=<cmid>`, or the course page when the cmid is not
 * synced; null when the assignment is not hers).
 * `handinBlocked` also answers `paused`, and `./confirm` runs it before using
 * up the code, so a review made just before the switch went off cannot hand
 * in either: confirm refuses with zero Moodle calls (as `refused`, its
 * "no longer takes a hand-in here" message, since confirm.ts has no `paused`
 * reason of its own yet).
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { earlyBy } from "@/lib/dates";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { confirmCodes } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { handinEnabled } from "@/server/flags";
import { ALLOWED_SITES } from "@/server/moodle/connect";

/** `confirm_codes.purpose` for a hand-in (the same value her-tap checks). */
export const HANDIN_CODE_PURPOSE = "handin" as const;
/** How long a review may be confirmed. */
export const HANDIN_CODE_TTL_MS = 10 * 60 * 1000;
/** Our own size cap for one hand-in file (the hosting limit for a request body). */
export const MAX_HANDIN_BYTES = 4 * 1024 * 1024;

/** The file she is handing in. */
export type HandinFile = { name: string; bytes: Uint8Array };

export type HandinReview = {
  /** The one-time confirm code to send back with her tap. */
  code: string;
  fileName: string;
  /** File size in bytes. */
  bytes: number;
  /** `Course › Assignment`. */
  to: string;
  due: Date | null;
  /** `5 h 8 min early`, `late by 2 h`, `on time`; null without a due date. */
  earlyBy: string | null;
  needsStatement: boolean;
  /** When the code stops working. */
  expiresAt: Date;
};

export type PrepareRefusal =
  /** No such assignment of hers (another user's reads the same). */
  | "not_found"
  /** Handed in already, not open yet, or past the cut-off. */
  | "closed"
  /** The assignment does not take files. */
  | "no_files"
  /** Over 4 MB, or over the assignment's own limit. */
  | "too_big"
  /** No file, an empty file, or a file without a usable name. */
  | "no_file"
  /** Hand-in from Ready is switched off (`HANDIN_ENABLED`). */
  | "paused";

/**
 * The LMS name the paused sentence names. Until a school list exists (the
 * `lms` name per school), the one allowed site is MyCourses.
 */
export const LMS_NAME = "MyCourses";

/** What the sheet needs for "Hand-in from Ready is paused. Hand this one in on <lms>." and its link. */
export type PausedRefusal = {
  ok: false;
  reason: "paused";
  /** The LMS name for the sentence (`handinPausedMessage(lms)`). */
  lms: string;
  /** The assignment on the LMS, or null when it is not one of hers. */
  url: string | null;
};

export type PrepareResult =
  | { ok: true; review: HandinReview }
  | { ok: false; reason: Exclude<PrepareRefusal, "paused"> }
  | PausedRefusal;

export type HandinOptions = { now?: Date; db?: Db };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** sha-256 of the bytes, as hex. */
export function fileHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The confirm code's payload hash: sha-256 over our assignment id and the file hash. */
export function handinPayloadHash(assignmentId: string, fileSha256: string): string {
  return createHash("sha256").update(`handin\n${assignmentId}\n${fileSha256}`).digest("hex");
}

/**
 * The name Moodle will store: no folders, and without the characters Moodle
 * strips from file names (control characters and \ / : * ? " < > |). Null
 * when nothing usable is left.
 */
export function cleanFileName(name: string): string | null {
  const base = String(name).split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\x00-\x1f\x7f"*:<>?|]/g, "").trim().slice(0, 200);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : null;
}

/** The assignment fields both steps need, for one of her assignments. */
export type HandinAssignment = {
  id: string;
  moodleId: number;
  cmid: number | null;
  name: string;
  courseName: string;
  courseMoodleId: number;
  dueAt: Date | null;
  cutoffAt: Date | null;
  opensAt: Date | null;
  acceptsFiles: boolean;
  needsSubmitButton: boolean;
  maxBytes: number | null;
  state: "open" | "draft" | "submitted" | "graded";
};

const handinColumns = {
  id: assignments.id,
  moodleId: assignments.moodleId,
  cmid: assignments.cmid,
  name: assignments.name,
  courseName: courses.name,
  courseMoodleId: courses.moodleId,
  dueAt: assignments.dueAt,
  cutoffAt: assignments.cutoffAt,
  opensAt: assignments.opensAt,
  acceptsFiles: assignments.acceptsFiles,
  needsSubmitButton: assignments.needsSubmitButton,
  maxBytes: assignments.maxBytes,
  state: assignments.state,
};

/** Her assignments (all of them, or the one with this id), with their course name. */
export async function herAssignments(userId: string, database: Db, assignmentId?: string): Promise<HandinAssignment[]> {
  return database
    .select(handinColumns)
    .from(assignments)
    .innerJoin(courses, eq(courses.id, assignments.courseId))
    .where(
      and(
        eq(assignments.userId, userId),
        eq(courses.userId, userId),
        assignmentId ? eq(assignments.id, assignmentId) : undefined,
      ),
    );
}

/** Why this assignment cannot take this file now, or null when it can. `paused` first, while the switch is off. */
export function handinBlocked(
  a: HandinAssignment,
  file: { bytes: number },
  now: Date,
  enabled: boolean = handinEnabled(),
): Exclude<PrepareRefusal, "not_found" | "no_file"> | null {
  if (!enabled) return "paused";
  if (a.state !== "open" && a.state !== "draft") return "closed";
  if (a.opensAt && a.opensAt.getTime() > now.getTime()) return "closed";
  if (a.cutoffAt && a.cutoffAt.getTime() <= now.getTime()) return "closed";
  if (!a.acceptsFiles) return "no_files";
  if (file.bytes > MAX_HANDIN_BYTES || (a.maxBytes !== null && file.bytes > a.maxBytes)) return "too_big";
  return null;
}

/** `Course › Assignment` */
export function handinTo(a: Pick<HandinAssignment, "courseName" | "name">): string {
  return `${a.courseName} › ${a.name}`;
}

/** The assignment on her LMS: its own page when the cmid is synced, else its course page. */
export async function lmsAssignmentUrl(
  userId: string,
  a: Pick<HandinAssignment, "cmid" | "courseMoodleId">,
  database: Db,
): Promise<string> {
  const [conn] = await database
    .select({ siteUrl: moodleConnections.siteUrl })
    .from(moodleConnections)
    .where(eq(moodleConnections.userId, userId))
    .limit(1);
  const site = (conn?.siteUrl ?? ALLOWED_SITES[0]).replace(/\/+$/, "");
  return a.cmid !== null ? `${site}/mod/assign/view.php?id=${a.cmid}` : `${site}/course/view.php?id=${a.courseMoodleId}`;
}

async function paused(userId: string, assignmentId: string, database: Db): Promise<PausedRefusal> {
  const [a] = UUID.test(userId) && UUID.test(assignmentId) ? await herAssignments(userId, database, assignmentId) : [];
  return { ok: false, reason: "paused", lms: LMS_NAME, url: a ? await lmsAssignmentUrl(userId, a, database) : null };
}

export async function prepareHandin(
  userId: string,
  assignmentId: string,
  file: HandinFile,
  options: HandinOptions = {},
): Promise<PrepareResult> {
  const now = options.now ?? new Date();
  const database = options.db ?? defaultDb;
  // The off switch comes before every other check, and never reaches Moodle.
  if (!handinEnabled()) return paused(userId, assignmentId, database);
  if (!UUID.test(userId) || !UUID.test(assignmentId)) return { ok: false, reason: "not_found" };

  const [a] = await herAssignments(userId, database, assignmentId);
  if (!a) return { ok: false, reason: "not_found" };

  const fileName = file && file.bytes instanceof Uint8Array ? cleanFileName(file.name) : null;
  if (!fileName || file.bytes.byteLength === 0) return { ok: false, reason: "no_file" };
  const size = file.bytes.byteLength;

  // The switch was checked above; `paused` cannot come back here.
  const blocked = handinBlocked(a, { bytes: size }, now, true);
  if (blocked && blocked !== "paused") return { ok: false, reason: blocked };

  const expiresAt = new Date(now.getTime() + HANDIN_CODE_TTL_MS);
  const [row] = await database
    .insert(confirmCodes)
    .values({
      userId,
      purpose: HANDIN_CODE_PURPOSE,
      payloadHash: handinPayloadHash(a.id, fileHash(file.bytes)),
      expiresAt,
    })
    .returning({ id: confirmCodes.id });

  return {
    ok: true,
    review: {
      code: row.id,
      fileName,
      bytes: size,
      to: handinTo(a),
      due: a.dueAt,
      earlyBy: a.dueAt ? earlyBy(now, a.dueAt) : null,
      needsStatement: a.needsSubmitButton,
      expiresAt,
    },
  };
}
