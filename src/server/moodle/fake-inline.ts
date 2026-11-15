// In-process fake Moodle, used by callMoodle and postMoodleForm when MOODLE_FAKE=1,
// so `npm run dev` and preview links work with no school login. It answers from
// the hand-written sample answers and accepts only the key `demo-key`.
// Never in production.
//
// It remembers a hand-in (ticket M1-48), per fake user and assignment:
// - an upload to /webservice/upload.php puts the file (name, size) in a draft
//   area and answers its item id. With `itemid` 0 it opens a new area (the
//   first one a user gets is FAKE_DRAFT_ITEMID, then +1); with the id of one
//   of that user's areas it adds the file to it.
// - mod_assign_save_submission copies the files of `plugindata.files_filemanager`
//   into her submission (replacing what was there) and marks it "draft", or
//   straight away "submitted" when the assignment has no separate Submit
//   button. An unknown item id, or a save after "submitted", answers a warning
//   like Moodle does.
// - mod_assign_submit_for_grading marks a saved submission "submitted"; with
//   nothing saved, or already submitted, it answers a warning.
// - mod_assign_get_submission_status answers the sample, with her remembered
//   submission (status, files with names and sizes, timemodified, canedit) in
//   `lastattempt.submission`, in exactly the shape read/assignments.ts parses.
//   With nothing remembered it answers the sample unchanged ("new", no files).
//
// The separate-Submit setting is the sample assignments' `submissiondrafts`
// (what `needs_submit_button` is synced from): 1 = she must still press
// Submit. An assignment that is not in the samples counts as 0, so saving
// hands it in.
//
// The user key: `fakeUserKey(conn)`, which is `conn.userId` (our users.id,
// which getConnection always sets) and falls back to the token when a caller
// has no user id. Every fake user shares the token `demo-key`, so the token
// alone could not tell two users apart. `resetFake(userKey)` forgets
// everything of that user; the demo reset (M1-37) calls it with her users.id.
//
// State is memory only, on `globalThis`, so route handlers and pages share it
// in dev (and survive module reloads); a server restart forgets it.
//
// QR sign-in (M5-08): `fakeQrLogin` stands in for Moodle's
// `tool_mobile_get_tokens_for_qr_login` when `connectWithQr` (./qr.ts) runs
// with MOODLE_FAKE=1 and no fake server to send the exchange to. It swaps the
// key in tests/fixtures/files/sample-qr.png (`FAKE_QR_KEY`, for the sample
// site info's user `FAKE_QR_USERID`) for `demo-key`, so uploading the sample
// QR connects her. Unlike Moodle's, this key can be used again: preview
// testers upload the same picture many times. Any other key or user id is
// `invalidkey`, as Moodle answers for an unknown key.

import siteInfo from "../../../tests/fixtures/moodle-sample/core_webservice_get_site_info.json";
import usersCourses from "../../../tests/fixtures/moodle-sample/core_enrol_get_users_courses.json";
import assignments from "../../../tests/fixtures/moodle-sample/mod_assign_get_assignments.json";
import submissionStatus from "../../../tests/fixtures/moodle-sample/mod_assign_get_submission_status.json";
import saveSubmission from "../../../tests/fixtures/moodle-sample/mod_assign_save_submission.json";
import submitForGrading from "../../../tests/fixtures/moodle-sample/mod_assign_submit_for_grading.json";
import { KeyRejected, MoodleError, NotAllowed, type MoodleConn, type MoodleParams } from "./client";

export const DEMO_KEY = "demo-key";

/** The QR login key in tests/fixtures/files/sample-qr.png. Made up; reusable. */
export const FAKE_QR_KEY = "demoqrkey123";
/** The Moodle user id the sample QR is for: the sample site info's `userid`. */
export const FAKE_QR_USERID = 4242;

/** The draft itemid of a user's first fake upload; later uploads count up from it. */
export const FAKE_DRAFT_ITEMID = 777001;

const ANSWERS: Record<string, unknown> = {
  core_webservice_get_site_info: siteInfo,
  core_enrol_get_users_courses: usersCourses,
  mod_assign_get_assignments: assignments,
  mod_assign_get_submission_status: submissionStatus,
  mod_assign_save_submission: saveSubmission,
  mod_assign_submit_for_grading: submitForGrading,
};

// ---------------------------------------------------------------------------
// Remembered state.

type FakeFile = { name: string; size: number };
type FakeSubmission = { status: "draft" | "submitted"; files: FakeFile[]; timemodified: number };
type FakeUser = {
  nextItemId: number;
  drafts: Map<number, FakeFile[]>;
  submissions: Map<number, FakeSubmission>;
};

const STATE_KEY = Symbol.for("ready.fakeMoodle.state");
type Holder = { [STATE_KEY]?: Map<string, FakeUser> };

function users(): Map<string, FakeUser> {
  const g = globalThis as Holder;
  return (g[STATE_KEY] ??= new Map());
}

function userState(key: string): FakeUser {
  const all = users();
  let u = all.get(key);
  if (!u) {
    u = { nextItemId: FAKE_DRAFT_ITEMID, drafts: new Map(), submissions: new Map() };
    all.set(key, u);
  }
  return u;
}

/** Whose fake state a call reads and writes: our users.id, or the token when the call has none. */
export function fakeUserKey(conn: MoodleConn): string {
  return conn.userId ? `user:${conn.userId}` : `token:${conn.token}`;
}

/**
 * Forget everything the fake remembers for this user: draft files, saved and
 * submitted hand-ins. `userKey` is our users.id (what getConnection puts in
 * `conn.userId`), or a whole `fakeUserKey(conn)`.
 */
export function resetFake(userKey: string): void {
  const all = users();
  all.delete(userKey);
  all.delete(`user:${userKey}`);
}

// ---------------------------------------------------------------------------

function notInProduction(): void {
  if (process.env.VERCEL_ENV === "production") {
    throw new Error("The fake Moodle is switched on in production. Unset MOODLE_FAKE.");
  }
}

function guard(conn: MoodleConn): void {
  notInProduction();
  if (conn.token !== DEMO_KEY) {
    throw new KeyRejected("Invalid token - token not found", { errorcode: "invalidtoken", exception: "moodle_exception" });
  }
}

type SampleAssignment = { id: number; submissiondrafts: number };

/** Whether she must still press Submit after saving (the sample's `submissiondrafts`). */
function needsSubmitButton(assignId: number): boolean {
  for (const c of assignments.courses) {
    const a = (c.assignments as SampleAssignment[]).find((x) => x.id === assignId);
    if (a) return a.submissiondrafts === 1;
  }
  return false;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function intParam(v: unknown): number {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : 0;
}

function warning(assignId: number, warningcode: string, message: string) {
  return [{ item: "assignment", itemid: assignId, warningcode, message }];
}

function save(conn: MoodleConn, params: MoodleParams): unknown {
  const assignId = intParam(params.assignmentid);
  const u = userState(fakeUserKey(conn));
  const prior = u.submissions.get(assignId);
  if (prior?.status === "submitted") {
    return warning(assignId, "couldnotsavesubmission", "This submission has already been submitted for grading.");
  }
  const plugindata = (params.plugindata ?? {}) as { files_filemanager?: unknown };
  let files: FakeFile[] = [];
  if (plugindata.files_filemanager !== undefined) {
    const draft = u.drafts.get(intParam(plugindata.files_filemanager));
    if (!draft) return warning(assignId, "couldnotsavesubmission", "Could not save submission");
    files = draft.map((f) => ({ ...f }));
  }
  u.submissions.set(assignId, {
    status: needsSubmitButton(assignId) ? "draft" : "submitted",
    files,
    timemodified: nowSeconds(),
  });
  return structuredClone(saveSubmission);
}

function submit(conn: MoodleConn, params: MoodleParams): unknown {
  const assignId = intParam(params.assignmentid);
  const sub = userState(fakeUserKey(conn)).submissions.get(assignId);
  if (!sub || sub.status === "submitted") {
    return warning(assignId, "couldnotsubmitforgrading", "Could not submit assignment for grading");
  }
  sub.status = "submitted";
  sub.timemodified = nowSeconds();
  return structuredClone(submitForGrading);
}

type SampleStatus = typeof submissionStatus;

function status(conn: MoodleConn, params: MoodleParams): unknown {
  const answer = structuredClone(submissionStatus) as SampleStatus;
  const assignId = intParam(params.assignid);
  const sub = users().get(fakeUserKey(conn))?.submissions.get(assignId);
  if (!sub) return answer;
  const last = answer.lastattempt;
  last.submission = {
    ...last.submission,
    assignment: assignId,
    status: sub.status,
    timemodified: sub.timemodified,
    plugins: [
      {
        type: "file",
        name: "File submissions",
        fileareas: [
          {
            area: "submission_files",
            files: sub.files.map((f) => ({
              filename: f.name,
              filepath: "/",
              filesize: f.size,
              fileurl: `https://moodle.example.edu/webservice/pluginfile.php/1/assignsubmission_file/submission_files/${assignId}/${encodeURIComponent(f.name)}`,
              timemodified: sub.timemodified,
              mimetype: f.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
              isexternalfile: false,
            })),
          },
        ],
      },
      { type: "comments", name: "Submission comments" },
    ] as SampleStatus["lastattempt"]["submission"]["plugins"],
  };
  last.canedit = sub.status !== "submitted";
  last.caneditowner = last.canedit;
  last.cansubmit = sub.status === "draft";
  return answer;
}

export function fakeCall(conn: MoodleConn, fn: string, params: MoodleParams = {}): unknown {
  guard(conn);
  if (fn === "mod_assign_save_submission") return save(conn, params);
  if (fn === "mod_assign_submit_for_grading") return submit(conn, params);
  if (fn === "mod_assign_get_submission_status") return status(conn, params);
  if (!(fn in ANSWERS)) {
    throw new NotAllowed(fn, { errorcode: "invalidrecord", exception: "dml_missing_record_exception" });
  }
  // A fresh copy each time, so callers can never change the samples.
  return structuredClone(ANSWERS[fn]);
}

/** Answers form posts like /webservice/upload.php: remembers the draft file and answers its item id. */
export function fakeForm(conn: MoodleConn, path: string, form: FormData): unknown {
  guard(conn);
  if (path !== "/webservice/upload.php") {
    throw new NotAllowed(path, { errorcode: "invalidrecord", exception: "dml_missing_record_exception" });
  }
  const file = form.get("file_1");
  const filename = file && typeof file !== "string" ? file.name : "";
  const size = file && typeof file !== "string" ? file.size : 0;

  const u = userState(fakeUserKey(conn));
  const asked = intParam(form.get("itemid"));
  let itemid = asked;
  if (!u.drafts.has(asked)) {
    itemid = u.nextItemId++;
    u.drafts.set(itemid, []);
  }
  const area = u.drafts.get(itemid)!;
  const at = area.findIndex((f) => f.name === filename);
  if (at >= 0) area.splice(at, 1);
  area.push({ name: filename, size });
  return [{ component: "user", filearea: "draft", filename, filepath: "/", itemid }];
}

/**
 * The fake's QR login: swaps `FAKE_QR_KEY` for `FAKE_QR_USERID` into the token
 * `demo-key`. Any other key or user id throws `MoodleError` with Moodle's
 * `invalidkey`, which `connectWithQr` shows as a spent code.
 */
export function fakeQrLogin(key: string, userid: number): string {
  notInProduction();
  if (key !== FAKE_QR_KEY || userid !== FAKE_QR_USERID) {
    throw new MoodleError("Invalid key", { errorcode: "invalidkey", exception: "moodle_exception" });
  }
  return DEMO_KEY;
}
