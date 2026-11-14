/*
 * Hand-in, step 2 of 2: her tap (ticket M1-32).
 *
 * `confirmHandin` takes the code from the review and the file again, and only
 * then writes to her Moodle:
 *
 *   1. Re-hash the file; read her code. Not hers -> `refused`; used or past
 *      its 10 minutes -> `expired`; no assignment of hers matches the hash
 *      (another file, or another assignment) -> `changed`. Then the
 *      assignment must still be open and her key connected.
 *   2. Use up the code: `herTapFromConfirmCode` with `dbConsumeConfirmCode`,
 *      one UPDATE ... WHERE used_at IS NULL AND expires_at > now AND
 *      payload_hash = ... RETURNING. This happens before any Moodle call, and
 *      only one caller can win it, so a reused code, a double tap or two tabs
 *      racing make zero Moodle calls for every loser (they get `expired`).
 *   3. With the tap: `uploadDraftFile`, `saveSubmission`, and
 *      `submitForGrading` when `needs_submit_button`.
 *   4. Read `getSubmissionStatus` back. Success only when Moodle lists the
 *      file in her submission and says "submitted". Otherwise `not_shown`.
 *   5. Write a `submissions` row with the receipt and set the assignment's
 *      `state` to "submitted" and `submitted_at`, in one transaction.
 *
 * Failure reasons the screen shows: `expired`, `changed`, `refused` (with a
 * message: Moodle's own when Moodle refused), `moodle_down`, `not_shown`.
 *
 * Choices:
 * - A code is spent the moment it is used (step 2), whatever happens next.
 *   It is never handed back: a HerTap is one-shot, and a code that could be
 *   re-armed after a Moodle error would let a slow first request and a retry
 *   both write. So every failure means "start a new review": the screen calls
 *   `prepareHandin` again (cheap, no Moodle call) and she taps again. That is
 *   safe after any partial write: a new upload gets a new draft area and the
 *   save replaces the files of an unsubmitted draft; if the first attempt did
 *   in fact reach "submitted", Moodle refuses the second save and she sees
 *   `refused` with Moodle's message, never a double hand-in.
 * - Failures before step 2 (not hers, changed, closed, not connected) leave
 *   the code unused; it simply expires.
 * - Error mapping for steps 3: `MoodleDown` (timeout, network, 5xx, daily
 *   limit) and an answer we cannot read -> `moodle_down`; any other Moodle
 *   error or warning (bad key, function not allowed, "could not save") ->
 *   `refused` with Moodle's message.
 * - Step 4 failing for any reason (Moodle down while reading, odd answer) is
 *   `not_shown`, not `moodle_down`: the writes went through, so she must
 *   check MyCourses rather than be invited to hand in again.
 * - The file counts as listed when one file has our cleaned name and size,
 *   or when the submission holds exactly one file of our size (Moodle may
 *   tidy a name further). Moodle's state must be "submitted" (or "graded").
 * - On `not_shown` and every other failure nothing is written to our
 *   database: the assignment stays open, and the next sync tells the truth.
 * - If step 5 fails after Moodle confirmed the hand-in, she still gets her
 *   receipt (Moodle is the record; the next sync sets our state), and one
 *   line without file data is logged.
 * - Her key and the file bytes are never logged and never in the receipt.
 */
import { eq } from "drizzle-orm";
import { earlyBy } from "@/lib/dates";
import { db as defaultDb } from "@/server/db/client";
import { confirmCodes } from "@/server/db/schema/users";
import { assignments, submissions } from "@/server/db/schema/work";
import { MoodleDown, MoodleError, type MoodleConn } from "@/server/moodle/client";
import { getConnection } from "@/server/moodle/connect";
import { HANDIN_PURPOSE, HerTapInvalid, dbConsumeConfirmCode, herTapFromConfirmCode, type HerTapRefusal } from "@/server/moodle/her-tap";
import { getSubmissionStatus, type SubmissionStatus } from "@/server/moodle/read/assignments";
import { saveSubmission, submitForGrading, uploadDraftFile } from "@/server/moodle/write";
import {
  cleanFileName,
  fileHash,
  handinBlocked,
  handinPayloadHash,
  handinTo,
  herAssignments,
  type HandinAssignment,
  type HandinFile,
  type HandinOptions,
} from "./prepare";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HandinReceipt = {
  fileName: string;
  bytes: number;
  /** `Course › Assignment`. */
  to: string;
  /** When Moodle has it as handed in. */
  submittedAt: Date;
  /** `5 h 8 min early`; null without a due date. */
  earlyBy: string | null;
};

export type ConfirmFailure =
  | { ok: false; reason: "expired" | "changed" | "moodle_down" | "not_shown" }
  | { ok: false; reason: "refused"; message: string };

export type ConfirmResult = { ok: true; receipt: HandinReceipt } | ConfirmFailure;

/** What we keep in `submissions.receipt`. No key, no bytes. */
type StoredReceipt = {
  moodleAssignId: number;
  draftItemId: number;
  submitPressed: boolean;
  moodleState: SubmissionStatus["state"];
  moodleSubmittedAt: string | null;
  files: SubmissionStatus["files"];
  fileSha256: string;
  checkedAt: string;
};

const refused = (message: string): ConfirmFailure => ({ ok: false, reason: "refused", message });

const REFUSED_NOT_FOUND = "We could not find this review. Start the hand-in again.";
const REFUSED_CLOSED = "This assignment no longer takes a hand-in here.";
const REFUSED_NOT_CONNECTED = "Your key is not connected any more. Connect again, then hand in.";

function fromTapRefusal(reason: HerTapRefusal): ConfirmFailure {
  if (reason === "used" || reason === "expired") return { ok: false, reason: "expired" };
  if (reason === "changed") return { ok: false, reason: "changed" };
  return refused(REFUSED_NOT_FOUND);
}

function fromMoodleError(err: unknown): ConfirmFailure {
  if (err instanceof HerTapInvalid) throw err; // a bug in this file, never a user-facing state
  if (err instanceof MoodleDown) return { ok: false, reason: "moodle_down" };
  if (err instanceof MoodleError) {
    if (err.errorcode === "invalidresponse") return { ok: false, reason: "moodle_down" };
    return refused(err.message || "The hand-in was refused.");
  }
  throw err;
}

function listed(status: SubmissionStatus, fileName: string, size: number): boolean {
  if (status.state !== "submitted" && status.state !== "graded") return false;
  if (status.files.some((f) => f.name === fileName && f.size === size)) return true;
  return status.files.length === 1 && status.files[0].size === size;
}

export async function confirmHandin(
  userId: string,
  code: string,
  file: HandinFile,
  options: HandinOptions = {},
): Promise<ConfirmResult> {
  const now = options.now ?? new Date();
  const database = options.db ?? defaultDb;
  if (!UUID.test(userId) || typeof code !== "string" || !UUID.test(code)) return refused(REFUSED_NOT_FOUND);

  // 1. Checks that need no Moodle call and do not touch the code.
  const fileName = file && file.bytes instanceof Uint8Array ? cleanFileName(file.name) : null;
  if (!fileName || file.bytes.byteLength === 0) return { ok: false, reason: "changed" };
  const size = file.bytes.byteLength;
  const sha = fileHash(file.bytes);

  const [row] = await database
    .select({
      userId: confirmCodes.userId,
      purpose: confirmCodes.purpose,
      payloadHash: confirmCodes.payloadHash,
      expiresAt: confirmCodes.expiresAt,
      usedAt: confirmCodes.usedAt,
    })
    .from(confirmCodes)
    .where(eq(confirmCodes.id, code))
    .limit(1);
  if (!row || row.userId !== userId || row.purpose !== HANDIN_PURPOSE) return refused(REFUSED_NOT_FOUND);
  if (row.usedAt || row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };

  const mine = await herAssignments(userId, database);
  const payloadHash = (a: HandinAssignment) => handinPayloadHash(a.id, sha);
  const a = mine.find((x) => payloadHash(x) === row.payloadHash);
  if (!a) return { ok: false, reason: "changed" };
  if (handinBlocked(a, { bytes: size }, now)) return refused(REFUSED_CLOSED);

  const conn: MoodleConn | null = await getConnection(userId, database);
  if (!conn) return refused(REFUSED_NOT_CONNECTED);

  // 2. Use up the code, atomically, before anything reaches Moodle.
  const made = await herTapFromConfirmCode(
    { userId, assignId: a.moodleId, code, payloadHash: payloadHash(a) },
    dbConsumeConfirmCode(database),
    now,
  );
  if (!made.ok) return fromTapRefusal(made.reason);
  const tap = made.tap;

  // 3. The writes.
  let draftItemId: number;
  try {
    draftItemId = await uploadDraftFile(conn, tap, { name: fileName, bytes: file.bytes });
    await saveSubmission(conn, tap, a.moodleId, draftItemId);
    if (a.needsSubmitButton) await submitForGrading(conn, tap, a.moodleId);
  } catch (err) {
    return fromMoodleError(err);
  }

  // 4. Believe Moodle, not our requests.
  let status: SubmissionStatus;
  try {
    status = await getSubmissionStatus(conn, a.moodleId);
  } catch {
    return { ok: false, reason: "not_shown" };
  }
  if (!listed(status, fileName, size)) return { ok: false, reason: "not_shown" };

  // 5. Our record.
  const submittedAt = status.submittedAt ?? now;
  const stored: StoredReceipt = {
    moodleAssignId: a.moodleId,
    draftItemId,
    submitPressed: a.needsSubmitButton,
    moodleState: status.state,
    moodleSubmittedAt: status.submittedAt ? status.submittedAt.toISOString() : null,
    files: status.files,
    fileSha256: sha,
    checkedAt: now.toISOString(),
  };
  try {
    await database.transaction(async (tx) => {
      await tx.insert(submissions).values({
        userId,
        assignmentId: a.id,
        fileName,
        bytes: size,
        state: "submitted",
        submittedAt,
        receipt: stored,
      });
      await tx.update(assignments).set({ state: "submitted", submittedAt }).where(eq(assignments.id, a.id));
    });
  } catch {
    console.error("handin: Moodle has the hand-in but our record failed; the next sync sets the state", {
      assignmentId: a.id,
    });
  }

  return {
    ok: true,
    receipt: {
      fileName,
      bytes: size,
      to: handinTo(a),
      submittedAt,
      earlyBy: a.dueAt ? earlyBy(submittedAt, a.dueAt) : null,
    },
  };
}
