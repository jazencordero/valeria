// Reads her assignments (mod_assign_get_assignments) and where her hand-in
// stands for one of them (mod_assign_get_submission_status).
// Cut: no group assignments, no rubrics, no feedback files.

import { z } from "zod";
import { callMoodle, type MoodleConn } from "../client";
import { parseAnswer } from "./site";

const FN_ASSIGNMENTS = "mod_assign_get_assignments";
const FN_STATUS = "mod_assign_get_submission_status";

// Moodle sends times as Unix seconds and 0 for "not set".
const seconds = z.number().int().nonnegative();

function toDate(s: number | undefined): Date | null {
  return s ? new Date(s * 1000) : null;
}

// ---------------------------------------------------------------------------
// Assignments

const Config = z.object({
  plugin: z.string(),
  subtype: z.string(),
  name: z.string(),
  // Moodle stores every config value as text ("1", "10485760", ".pdf").
  value: z.union([z.string(), z.number()]),
});

const Attachment = z.object({
  filename: z.string(),
  fileurl: z.string(),
  filesize: z.number().int().nonnegative(),
  mimetype: z.string().optional(),
});

const AssignmentsAnswer = z.object({
  courses: z.array(
    z.object({
      id: z.number().int(),
      assignments: z.array(
        z.object({
          id: z.number().int(),
          cmid: z.number().int(),
          course: z.number().int(),
          name: z.string(),
          intro: z.string().optional(),
          duedate: seconds,
          cutoffdate: seconds.optional(),
          allowsubmissionsfromdate: seconds.optional(),
          submissiondrafts: z.number().int(),
          configs: z.array(Config),
          introattachments: z.array(Attachment).optional(),
        }),
      ),
    }),
  ),
});

export type AssignmentAttachment = {
  name: string;
  /** Moodle's file URL without the token. Add it only at download time, with `fileUrl` from ../client. */
  url: string;
  mime: string;
  size: number;
};

export type Assignment = {
  moodleId: number;
  cmid: number;
  courseMoodleId: number;
  name: string;
  introHtml: string;
  dueAt: Date | null;
  /** After this Moodle takes no hand-in at all. */
  cutoffAt: Date | null;
  /** Moodle takes hand-ins from this time on. */
  opensAt: Date | null;
  acceptsFiles: boolean;
  acceptsText: boolean;
  /** Uploading only saves a draft; she must still press Submit (Moodle's "submissiondrafts"). */
  needsSubmitButton: boolean;
  /** Most files she may hand in; null when files are not accepted or Moodle sets no number. */
  maxFiles: number | null;
  /** Largest hand-in file in bytes; null when files are not accepted or the assignment sets no own limit. */
  maxBytes: number | null;
  attachments: AssignmentAttachment[];
};

type Configs = z.output<typeof Config>[];

function config(configs: Configs, plugin: string, name: string): string | null {
  const c = configs.find((x) => x.subtype === "assignsubmission" && x.plugin === plugin && x.name === name);
  return c === undefined ? null : String(c.value).trim();
}

// A plugin with no "enabled" row is off: Moodle writes the row when a teacher sets it up.
function enabled(configs: Configs, plugin: string): boolean {
  return config(configs, plugin, "enabled") === "1";
}

// A positive whole number, or null. 0 means "no limit of its own" in Moodle: for
// maxsubmissionsizebytes the course or site upload limit applies instead, which this
// answer does not tell us, so callers keep their own cap (M1 takes files up to 4 MB).
function positiveInt(v: string | null): number | null {
  if (v === null || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

/**
 * Every assignment in these courses, as one flat list. An empty list returns
 * [] without asking Moodle, because Moodle reads no course ids as "all her courses".
 */
export async function getAssignments(conn: MoodleConn, courseIds: number[]): Promise<Assignment[]> {
  if (courseIds.length === 0) return [];
  const raw = await callMoodle(conn, FN_ASSIGNMENTS, { courseids: courseIds });
  const answer = parseAnswer(FN_ASSIGNMENTS, AssignmentsAnswer, raw);
  return answer.courses.flatMap((course) =>
    course.assignments.map((a) => {
      const acceptsFiles = enabled(a.configs, "file");
      return {
        moodleId: a.id,
        cmid: a.cmid,
        courseMoodleId: a.course,
        name: a.name,
        introHtml: a.intro ?? "",
        dueAt: toDate(a.duedate),
        cutoffAt: toDate(a.cutoffdate),
        opensAt: toDate(a.allowsubmissionsfromdate),
        acceptsFiles,
        acceptsText: enabled(a.configs, "onlinetext"),
        needsSubmitButton: a.submissiondrafts === 1,
        maxFiles: acceptsFiles ? positiveInt(config(a.configs, "file", "maxfilesubmissions")) : null,
        maxBytes: acceptsFiles ? positiveInt(config(a.configs, "file", "maxsubmissionsizebytes")) : null,
        attachments: (a.introattachments ?? []).map((f) => ({
          name: f.filename,
          url: f.fileurl,
          mime: f.mimetype || "application/octet-stream",
          size: f.filesize,
        })),
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Hand-in status

const SubmissionFile = z.object({
  filename: z.string(),
  filesize: z.number().int().nonnegative(),
});

const StatusAnswer = z.object({
  // Missing when she cannot submit to this assignment at all.
  lastattempt: z
    .object({
      // Missing when nothing was ever started. Group hand-ins come as `teamsubmission` (cut).
      submission: z
        .object({
          status: z.enum(["new", "draft", "submitted", "reopened"]),
          timemodified: seconds,
          plugins: z
            .array(
              z.object({
                type: z.string(),
                fileareas: z
                  .array(z.object({ area: z.string(), files: z.array(SubmissionFile).optional() }))
                  .optional(),
              }),
            )
            .optional(),
        })
        .optional(),
      graded: z.boolean().optional(),
      gradingstatus: z.string().optional(),
      canedit: z.boolean(),
    })
    .optional(),
  // Present only once a grade is released to her. Only its presence is read (no feedback files).
  feedback: z.object({}).optional(),
});

export type SubmissionState = "none" | "draft" | "submitted" | "graded";

export type SubmissionStatus = {
  state: SubmissionState;
  /** When she handed it in; null unless Moodle has it as submitted. */
  submittedAt: Date | null;
  /** Files in her current attempt. */
  files: { name: string; size: number }[];
  /** Whether Moodle still lets her change the hand-in. */
  canEdit: boolean;
};

// How Moodle's answer maps to our state:
// - no lastattempt or no submission, or status "new"       -> none
// - status "reopened" (a new attempt after grading, empty) -> none, even if the old one was graded
// - a grade is out (lastattempt.graded, gradingstatus "graded" or, with marking
//   workflow, "released", or a feedback block)             -> graded
// - status "draft"                                         -> draft (saved, Submit not pressed)
// - status "submitted"                                     -> submitted
// submittedAt is the submission's timemodified when its status is "submitted":
// Moodle keeps no separate hand-in time, and a submitted hand-in can no longer change.
export async function getSubmissionStatus(conn: MoodleConn, assignId: number): Promise<SubmissionStatus> {
  const raw = await callMoodle(conn, FN_STATUS, { assignid: assignId });
  const a = parseAnswer(FN_STATUS, StatusAnswer, raw);
  const last = a.lastattempt;
  const sub = last?.submission;
  const canEdit = last?.canedit ?? false;
  if (!sub) {
    return { state: a.feedback ? "graded" : "none", submittedAt: null, files: [], canEdit };
  }

  const files = (sub.plugins ?? [])
    .filter((p) => p.type === "file")
    .flatMap((p) => p.fileareas ?? [])
    .filter((area) => area.area === "submission_files")
    .flatMap((area) => area.files ?? [])
    .map((f) => ({ name: f.filename, size: f.filesize }));

  const isGraded =
    last?.graded === true || last?.gradingstatus === "graded" || last?.gradingstatus === "released" || !!a.feedback;

  let state: SubmissionState;
  if (sub.status === "reopened") state = "none";
  else if (isGraded) state = "graded";
  else if (sub.status === "submitted") state = "submitted";
  else if (sub.status === "draft") state = "draft";
  else state = "none";

  return {
    state,
    submittedAt: sub.status === "submitted" ? toDate(sub.timemodified) : null,
    files,
    canEdit,
  };
}
