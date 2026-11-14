// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeMoodle, type FakeMoodle } from "../../../../tests/fake-moodle/server";
import assignmentsSample from "../../../../tests/fixtures/moodle-sample/mod_assign_get_assignments.json";
import statusSample from "../../../../tests/fixtures/moodle-sample/mod_assign_get_submission_status.json";
import type { MoodleConn } from "../client";
import { getAssignments, getSubmissionStatus } from "./assignments";
import { UnexpectedAnswer } from "./site";

let moodle: FakeMoodle;
let conn: MoodleConn;

// A fresh fake per test, so an override never leaks into the next one.
beforeEach(async () => {
  moodle = await startFakeMoodle();
  conn = { siteUrl: moodle.url, token: moodle.token };
});
afterEach(async () => {
  await moodle.close();
});

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

type Json = Record<string, unknown>;

/** The sample answer with the first assignment of course 3101 changed. */
function withFirstAssignment(change: (a: Json) => void): unknown {
  const body = structuredClone(assignmentsSample) as unknown as { courses: { assignments: Json[] }[] };
  change(body.courses[0].assignments[0]);
  return body;
}

/** The sample status answer with lastattempt changed. */
function withLastAttempt(change: (last: Json, sub: Json, body: Json) => void): unknown {
  const body = structuredClone(statusSample) as unknown as Json & { lastattempt: Json & { submission: Json } };
  change(body.lastattempt, body.lastattempt.submission, body);
  return body;
}

const ALL = [3101, 3102, 3103, 3104];

describe("getAssignments", () => {
  it("asks for the given courses and returns one flat list", async () => {
    const list = await getAssignments(conn, ALL);
    expect(moodle.calls.at(-1)).toMatchObject({
      fn: "mod_assign_get_assignments",
      params: { "courseids[0]": "3101", "courseids[1]": "3102", "courseids[2]": "3103", "courseids[3]": "3104" },
    });
    expect(list.map((a) => [a.moodleId, a.courseMoodleId])).toEqual([
      [7101, 3101],
      [7301, 3103],
      [7401, 3104],
    ]);
  });

  it("does not ask Moodle for no courses (Moodle would answer all of them)", async () => {
    expect(await getAssignments(conn, [])).toEqual([]);
    expect(moodle.calls).toHaveLength(0);
  });

  it("reads the sample assignment in full, with dates as Date", async () => {
    const [a] = await getAssignments(conn, ALL);
    expect(a).toEqual({
      moodleId: 7101,
      cmid: 5101,
      courseMoodleId: 3101,
      name: "Assignment 3",
      introHtml: expect.stringContaining("exponential smoothing"),
      dueAt: new Date(1794866340 * 1000),
      cutoffAt: null,
      opensAt: new Date(1793520000 * 1000),
      acceptsFiles: true,
      acceptsText: false,
      needsSubmitButton: false,
      maxFiles: 1,
      maxBytes: 10485760,
      attachments: [
        {
          name: "assignment-3-brief.pdf",
          url: "https://moodle.example.edu/webservice/pluginfile.php/61101/mod_assign/introattachment/0/assignment-3-brief.pdf",
          mime: "application/pdf",
          size: 184320,
        },
        {
          name: "sales-series.pdf",
          url: "https://moodle.example.edu/webservice/pluginfile.php/61101/mod_assign/introattachment/0/sales-series.pdf",
          mime: "application/pdf",
          size: 96256,
        },
      ],
    });
    expect(a.dueAt).toBeInstanceOf(Date);
    expect(a.opensAt).toBeInstanceOf(Date);
  });

  it("detects the sample that needs a Submit press", async () => {
    const list = await getAssignments(conn, ALL);
    const byId = new Map(list.map((a) => [a.moodleId, a]));
    expect(byId.get(7301)?.needsSubmitButton).toBe(true);
    expect(byId.get(7101)?.needsSubmitButton).toBe(false);
    expect(byId.get(7401)?.needsSubmitButton).toBe(false);
  });

  it("turns a zero due date, cut-off and open date into null", async () => {
    moodle.override("mod_assign_get_assignments", {
      body: withFirstAssignment((a) => {
        a.duedate = 0;
        a.cutoffdate = 0;
        a.allowsubmissionsfromdate = 0;
      }),
    });
    const [a] = await getAssignments(conn, ALL);
    expect(a.dueAt).toBeNull();
    expect(a.cutoffAt).toBeNull();
    expect(a.opensAt).toBeNull();
  });

  it("reads a set cut-off date", async () => {
    moodle.override("mod_assign_get_assignments", { body: withFirstAssignment((a) => void (a.cutoffdate = 1795000000)) });
    const [a] = await getAssignments(conn, ALL);
    expect(a.cutoffAt).toEqual(new Date(1795000000 * 1000));
  });

  it("reads online text, and no file limits when files are off", async () => {
    moodle.override("mod_assign_get_assignments", {
      body: withFirstAssignment((a) => {
        for (const c of a.configs as Json[]) {
          if (c.subtype !== "assignsubmission" || c.name !== "enabled") continue;
          if (c.plugin === "file") c.value = "0";
          if (c.plugin === "onlinetext") c.value = "1";
        }
      }),
    });
    const [a] = await getAssignments(conn, ALL);
    expect(a).toMatchObject({ acceptsFiles: false, acceptsText: true, maxFiles: null, maxBytes: null });
  });

  it("treats a 0 size limit as no limit of its own, and ignores feedback-plugin configs", async () => {
    moodle.override("mod_assign_get_assignments", {
      body: withFirstAssignment((a) => {
        const configs = a.configs as Json[];
        for (const c of configs) if (c.name === "maxsubmissionsizebytes") c.value = "0";
        // A feedback file plugin row must not switch hand-in files on.
        a.configs = configs.filter((c) => !(c.plugin === "file" && c.subtype === "assignsubmission" && c.name === "enabled"));
      }),
    });
    const [a] = await getAssignments(conn, ALL);
    expect(a).toMatchObject({ acceptsFiles: false, maxBytes: null });

    moodle.override("mod_assign_get_assignments", {
      body: withFirstAssignment((a) => {
        for (const c of a.configs as Json[]) if (c.name === "maxsubmissionsizebytes") c.value = "0";
      }),
    });
    const [b] = await getAssignments(conn, ALL);
    expect(b).toMatchObject({ acceptsFiles: true, maxFiles: 1, maxBytes: null });
  });

  it("throws UnexpectedAnswer naming the path and none of the data", async () => {
    moodle.override("mod_assign_get_assignments", {
      body: withFirstAssignment((a) => {
        a.name = 12345;
        a.duedate = "Secret course data";
      }),
    });
    const err = await caught(getAssignments(conn, ALL));
    expect(err).toBeInstanceOf(UnexpectedAnswer);
    const e = err as UnexpectedAnswer;
    expect(e.fn).toBe("mod_assign_get_assignments");
    expect(e.path).toMatch(/^courses\[0\]\.assignments\[0\]\.(name|duedate)$/);
    expect(e.message).not.toContain("12345");
    expect(e.message).not.toContain("Secret course data");
    expect(e.message).not.toContain("Assignment 3");
  });
});

describe("getSubmissionStatus", () => {
  it("asks for the assignment and reads the sample as nothing handed in yet", async () => {
    const s = await getSubmissionStatus(conn, 7301);
    expect(moodle.calls.at(-1)).toMatchObject({ fn: "mod_assign_get_submission_status", params: { assignid: "7301" } });
    expect(s).toEqual({ state: "none", submittedAt: null, files: [], canEdit: true });
  });

  it("maps a draft with a file", async () => {
    moodle.override("mod_assign_get_submission_status", {
      body: withLastAttempt((_last, sub) => {
        sub.status = "draft";
        sub.plugins = [
          {
            type: "file",
            name: "File submissions",
            fileareas: [{ area: "submission_files", files: [{ filename: "memo.pdf", filesize: 2048, filepath: "/" }] }],
          },
          { type: "comments", name: "Submission comments" },
        ];
      }),
    });
    const s = await getSubmissionStatus(conn, 7301);
    expect(s).toEqual({ state: "draft", submittedAt: null, files: [{ name: "memo.pdf", size: 2048 }], canEdit: true });
  });

  it("maps submitted, with its time as a Date", async () => {
    moodle.override("mod_assign_get_submission_status", {
      body: withLastAttempt((last, sub) => {
        sub.status = "submitted";
        sub.timemodified = 1794900000;
        last.canedit = false;
      }),
    });
    const s = await getSubmissionStatus(conn, 7301);
    expect(s).toEqual({ state: "submitted", submittedAt: new Date(1794900000 * 1000), files: [], canEdit: false });
  });

  it("maps graded from gradingstatus, the graded flag, a released workflow and a feedback block", async () => {
    const cases: ((last: Json, body: Json) => void)[] = [
      (last) => void (last.gradingstatus = "graded"),
      (last) => void (last.graded = true),
      (last) => void (last.gradingstatus = "released"),
      (_last, body) => void (body.feedback = { grade: { grade: "87.00" }, gradefordisplay: "87.00 / 100.00" }),
    ];
    for (const change of cases) {
      moodle.override("mod_assign_get_submission_status", {
        body: withLastAttempt((last, sub, body) => {
          sub.status = "submitted";
          change(last, body);
        }),
      });
      const s = await getSubmissionStatus(conn, 7301);
      expect(s.state).toBe("graded");
      expect(s.submittedAt).toEqual(new Date(1794564000 * 1000));
    }
  });

  it("maps a reopened attempt to none, even though the old one was graded", async () => {
    moodle.override("mod_assign_get_submission_status", {
      body: withLastAttempt((last, sub) => {
        sub.status = "reopened";
        last.gradingstatus = "graded";
      }),
    });
    expect((await getSubmissionStatus(conn, 7301)).state).toBe("none");
  });

  it("maps no submission at all to none, and no last attempt to none that cannot be edited", async () => {
    moodle.override("mod_assign_get_submission_status", { body: withLastAttempt((last) => void delete last.submission) });
    expect(await getSubmissionStatus(conn, 7301)).toEqual({ state: "none", submittedAt: null, files: [], canEdit: true });

    moodle.override("mod_assign_get_submission_status", { body: { warnings: [] } });
    expect(await getSubmissionStatus(conn, 7301)).toEqual({ state: "none", submittedAt: null, files: [], canEdit: false });
  });

  it("throws UnexpectedAnswer for a status it does not know, without the data", async () => {
    moodle.override("mod_assign_get_submission_status", {
      body: withLastAttempt((_last, sub) => void (sub.status = "private-status-text")),
    });
    const err = await caught(getSubmissionStatus(conn, 7301));
    expect(err).toBeInstanceOf(UnexpectedAnswer);
    expect((err as UnexpectedAnswer).path).toBe("lastattempt.submission.status");
    expect((err as Error).message).not.toContain("private-status-text");
  });
});
