// In-process fake Moodle, used by callMoodle and uploadFile when MOODLE_FAKE=1,
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

/** Answers like /webservice/upload.php and returns the draft itemid. */
export function fakeUpload(conn: MoodleConn, filename: string): number {
  guard(conn);
  void filename;
  return FAKE_DRAFT_ITEMID;
}
