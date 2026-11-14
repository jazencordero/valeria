// The only code that changes anything on her Moodle: upload a file to her
// draft area, save it as her submission, submit it for grading. This is the
// only file in src/ that may name those endpoints (tests/arch/write-boundary.test.ts
// checks), and every function needs a HerTap, which only her confirmed tap makes.
//
// Calls go through ./client, so they keep its throttle, retries, daily limit,
// User-Agent, typed errors and MOODLE_FAKE routing.

import { MoodleError, callMoodle, postMoodleForm, type CallOptions, type MoodleConn } from "./client";
import { stepHerTap, type HerTap } from "./her-tap";

const UPLOAD_PATH = "/webservice/upload.php";
const SAVE_FN = "mod_assign_save_submission";
const SUBMIT_FN = "mod_assign_submit_for_grading";

export type DraftFile = {
  name: string;
  bytes: Uint8Array | ArrayBuffer | Blob;
};

/** Upload one file to her draft area. Returns the draft `itemId` to pass to `saveSubmission`. */
export async function uploadDraftFile(
  conn: MoodleConn,
  tap: HerTap,
  file: DraftFile,
  options: CallOptions = {},
): Promise<number> {
  stepHerTap(tap, "upload", conn.userId);
  const form = new FormData();
  form.append("token", conn.token);
  form.append("filearea", "draft");
  form.append("itemid", "0");
  const blob = file.bytes instanceof Blob ? file.bytes : new Blob([file.bytes as BlobPart]);
  form.append("file_1", blob, file.name);
  const answer = await postMoodleForm(conn, UPLOAD_PATH, form, options);
  const first = Array.isArray(answer) ? (answer[0] as { itemid?: unknown } | undefined) : undefined;
  const itemId = Number(first?.itemid);
  if (!first || !Number.isSafeInteger(itemId) || itemId <= 0) {
    throw new MoodleError("Upload answer had no itemid", { errorcode: "invalidresponse" });
  }
  return itemId;
}

/** Save the uploaded draft files as her submission for `assignId`. */
export async function saveSubmission(
  conn: MoodleConn,
  tap: HerTap,
  assignId: number,
  itemId: number,
  options: CallOptions = {},
): Promise<void> {
  stepHerTap(tap, "save", conn.userId, assignId);
  const warnings = await callMoodle(
    conn,
    SAVE_FN,
    { assignmentid: assignId, plugindata: { files_filemanager: itemId } },
    options,
  );
  throwOnWarnings(warnings, SAVE_FN);
}

/** Submit her saved submission for grading, accepting the submission statement. */
export async function submitForGrading(
  conn: MoodleConn,
  tap: HerTap,
  assignId: number,
  options: CallOptions = {},
): Promise<void> {
  stepHerTap(tap, "submit", conn.userId, assignId);
  const warnings = await callMoodle(conn, SUBMIT_FN, { assignmentid: assignId, acceptsubmissionstatement: 1 }, options);
  throwOnWarnings(warnings, SUBMIT_FN);
}

type Warning = { warningcode?: string; message?: string; item?: string };

// Both functions answer with a list of warnings; any warning means Moodle did not do it.
function throwOnWarnings(answer: unknown, fn: string): void {
  if (!Array.isArray(answer)) {
    throw new MoodleError(`${fn} answered with something that is not a warning list`, { errorcode: "invalidresponse" });
  }
  const first = answer[0] as Warning | undefined;
  if (first) {
    throw new MoodleError(first.message || first.warningcode || `${fn} was refused`, {
      errorcode: first.warningcode ?? "warning",
    });
  }
}
