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
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { earlyBy } from "@/lib/dates";
import { db as defaultDb, type Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { confirmCodes } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";

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
  | "no_file";

export type PrepareResult = { ok: true; review: HandinReview } | { ok: false; reason: PrepareRefusal };

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
  name: string;
  courseName: string;
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
  name: assignments.name,
  courseName: courses.name,
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

/** Why this assignment cannot take this file now, or null when it can. */
export function handinBlocked(
  a: HandinAssignment,
  file: { bytes: number },
  now: Date,
): Exclude<PrepareRefusal, "not_found" | "no_file"> | null {
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

export async function prepareHandin(
  userId: string,
  assignmentId: string,
  file: HandinFile,
  options: HandinOptions = {},
): Promise<PrepareResult> {
  const now = options.now ?? new Date();
  const database = options.db ?? defaultDb;
  if (!UUID.test(userId) || !UUID.test(assignmentId)) return { ok: false, reason: "not_found" };

  const [a] = await herAssignments(userId, database, assignmentId);
  if (!a) return { ok: false, reason: "not_found" };

  const fileName = file && file.bytes instanceof Uint8Array ? cleanFileName(file.name) : null;
  if (!fileName || file.bytes.byteLength === 0) return { ok: false, reason: "no_file" };
  const size = file.bytes.byteLength;

  const blocked = handinBlocked(a, { bytes: size }, now);
  if (blocked) return { ok: false, reason: blocked };

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
