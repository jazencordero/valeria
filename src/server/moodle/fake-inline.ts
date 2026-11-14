// In-process fake Moodle, used by callMoodle and postMoodleForm when MOODLE_FAKE=1,
// so `npm run dev` and preview links work with no school login. It answers from
// the hand-written sample answers and accepts only the key `demo-key`.
// It is stateless: saving or submitting does not change later answers.
// Never in production.

import siteInfo from "../../../tests/fixtures/moodle-sample/core_webservice_get_site_info.json";
import usersCourses from "../../../tests/fixtures/moodle-sample/core_enrol_get_users_courses.json";
import assignments from "../../../tests/fixtures/moodle-sample/mod_assign_get_assignments.json";
import submissionStatus from "../../../tests/fixtures/moodle-sample/mod_assign_get_submission_status.json";
import saveSubmission from "../../../tests/fixtures/moodle-sample/mod_assign_save_submission.json";
import submitForGrading from "../../../tests/fixtures/moodle-sample/mod_assign_submit_for_grading.json";
import { KeyRejected, NotAllowed, type MoodleConn, type MoodleParams } from "./client";

export const DEMO_KEY = "demo-key";

/** The draft itemid every fake upload answers with. */
export const FAKE_DRAFT_ITEMID = 777001;

const ANSWERS: Record<string, unknown> = {
  core_webservice_get_site_info: siteInfo,
  core_enrol_get_users_courses: usersCourses,
  mod_assign_get_assignments: assignments,
  mod_assign_get_submission_status: submissionStatus,
  mod_assign_save_submission: saveSubmission,
  mod_assign_submit_for_grading: submitForGrading,
};

function guard(conn: MoodleConn): void {
  if (process.env.VERCEL_ENV === "production") {
    throw new Error("The fake Moodle is switched on in production. Unset MOODLE_FAKE.");
  }
  if (conn.token !== DEMO_KEY) {
    throw new KeyRejected("Invalid token - token not found", { errorcode: "invalidtoken", exception: "moodle_exception" });
  }
}

// `params` is accepted to match callMoodle; the sample answers do not depend on it.
export function fakeCall(conn: MoodleConn, fn: string, params: MoodleParams = {}): unknown {
  void params;
  guard(conn);
  if (!(fn in ANSWERS)) {
    throw new NotAllowed(fn, { errorcode: "invalidrecord", exception: "dml_missing_record_exception" });
  }
  // A fresh copy each time, so callers can never change the samples.
  return structuredClone(ANSWERS[fn]);
}

/** Answers form posts like /webservice/upload.php: the draft file it stored, with FAKE_DRAFT_ITEMID. */
export function fakeForm(conn: MoodleConn, path: string, form: FormData): unknown {
  guard(conn);
  if (path !== "/webservice/upload.php") {
    throw new NotAllowed(path, { errorcode: "invalidrecord", exception: "dml_missing_record_exception" });
  }
  const file = form.get("file_1");
  const filename = file && typeof file !== "string" ? file.name : "";
  return [{ component: "user", filearea: "draft", filename, filepath: "/", itemid: FAKE_DRAFT_ITEMID }];
}
