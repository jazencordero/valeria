// @vitest-environment node
// getAssignments and getSubmissionStatus against MyCourses' real answers
// (shape-only copies, tests/fixtures/moodle/).
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeMoodle, type FakeMoodle } from "../../../../tests/fake-moodle/server";
import realStatus from "../../../../tests/fixtures/moodle/mod_assign_get_submission_status.json";
import type { MoodleConn } from "../client";
import { getAssignments, getSubmissionStatus } from "./assignments";

const REAL = fileURLToPath(new URL("../../../../tests/fixtures/moodle/", import.meta.url));
const COURSE_IDS = [50865, 52232, 51297, 49911, 51760, 51761];

let moodle: FakeMoodle;
let conn: MoodleConn;

beforeEach(async () => {
  moodle = await startFakeMoodle({ dir: REAL });
  conn = { siteUrl: moodle.url, token: moodle.token };
});
afterEach(async () => {
  await moodle.close();
});

describe("getAssignments on the real MyCourses answer", () => {
  it("reads all 24 assignments across her 6 courses, despite Moodle's warning", async () => {
    // The answer carries one warning ("No access rights in module context"); it is not an error.
    const list = await getAssignments(conn, COURSE_IDS);
    expect(list).toHaveLength(24);
    expect(new Set(list.map((a) => a.courseMoodleId))).toEqual(new Set(COURSE_IDS));
    const perCourse = Object.fromEntries(COURSE_IDS.map((id) => [id, list.filter((a) => a.courseMoodleId === id).length]));
    expect(perCourse).toEqual({ 50865: 2, 52232: 3, 51297: 3, 49911: 1, 51760: 2, 51761: 13 });
  });

  it("finds every assignment takes files, no online text, and needs no Submit press", async () => {
    const list = await getAssignments(conn, COURSE_IDS);
    for (const a of list) {
      expect(a.acceptsFiles).toBe(true);
      expect(a.acceptsText).toBe(false);
      expect(a.needsSubmitButton).toBe(false);
    }
  });

  it("reads max files from the configs (1 to 20) and the 400 MB size limit", async () => {
    const list = await getAssignments(conn, COURSE_IDS);
    expect(new Set(list.map((a) => a.maxFiles))).toEqual(new Set([1, 2, 4, 20]));
    expect(list.filter((a) => a.maxFiles === 1)).toHaveLength(19);
    for (const a of list) expect(a.maxBytes).toBe(419_430_400);
    expect(list.find((a) => a.moodleId === 170501)?.maxFiles).toBe(20);
  });

  it("parses Unix-second dates into Dates and 0 into null", async () => {
    const list = await getAssignments(conn, COURSE_IDS);
    for (const a of list) {
      expect(a.dueAt).toBeInstanceOf(Date);
      expect(Number.isNaN(a.dueAt?.getTime())).toBe(false);
    }
    const first = list.find((a) => a.moodleId === 167583)!;
    expect(first.dueAt?.toISOString()).toBe("2026-10-18T17:00:00.000Z");
    expect(first.cutoffAt).toBeNull();
    expect(first.opensAt).toBeNull();

    const withAll = list.find((a) => a.moodleId === 166076)!;
    expect(withAll.dueAt).toEqual(new Date(1789592340 * 1000));
    expect(withAll.cutoffAt).toEqual(new Date(1789678740 * 1000));
    expect(withAll.opensAt).toEqual(new Date(1788426000 * 1000));
  });

  it("reads the brief's attachments, without a token in the URL", async () => {
    const list = await getAssignments(conn, COURSE_IDS);
    const first = list.find((a) => a.moodleId === 167583)!;
    expect(first.cmid).toBe(1528227);
    expect(first.attachments).toEqual([
      {
        name: "Project Topic G.pdf",
        url: expect.stringMatching(/^https:\/\/mycourses\.aalto\.fi\/webservice\/pluginfile\.php\/.+\/mod_assign\/introattachment\/0\/Project%20Topic%20G\.pdf$/),
        mime: "application/pdf",
        size: 111862,
      },
    ]);
    expect(list.find((a) => a.moodleId === 166077)?.attachments).toHaveLength(7);
    expect(list.reduce((n, a) => n + a.attachments.length, 0)).toBe(24);
    for (const a of list) for (const f of a.attachments) expect(f.url).not.toMatch(/token=/);
  });
});

describe("getSubmissionStatus on the real MyCourses answer", () => {
  it("reads a graded hand-in with its file and time", async () => {
    const status = await getSubmissionStatus(conn, 167583);
    expect(status).toEqual({
      state: "graded",
      submittedAt: new Date(1792330215 * 1000),
      files: [{ name: "Topic B Report_Topic BA .pdf", size: 414770 }],
      canEdit: true,
    });
  });

  it("reads a group assignment from the group's hand-in, not her own empty one", async () => {
    // Same real answer, as Moodle sends it for a group assignment (5 of her 24 are one):
    // her own submission stays "new" and the group's hand-in is in `teamsubmission`.
    const body = structuredClone(realStatus) as unknown as { lastattempt: Record<string, unknown> };
    const own = body.lastattempt.submission as Record<string, unknown>;
    body.lastattempt.teamsubmission = { ...own, userid: 0, groupid: 12345 };
    body.lastattempt.submission = { ...own, status: "new", plugins: [] };
    body.lastattempt.graded = false;
    body.lastattempt.gradingstatus = "notgraded";
    delete (body as Record<string, unknown>).feedback;
    moodle.override("mod_assign_get_submission_status", { body });

    const status = await getSubmissionStatus(conn, 171491);
    expect(status.state).toBe("submitted");
    expect(status.submittedAt).toEqual(new Date(1792330215 * 1000));
    expect(status.files).toEqual([{ name: "Topic B Report_Topic BA .pdf", size: 414770 }]);
  });

  it("falls back to her own submission when Moodle sends no group hand-in", async () => {
    const body = structuredClone(realStatus) as unknown as { lastattempt: Record<string, unknown> };
    body.lastattempt.teamsubmission = null;
    moodle.override("mod_assign_get_submission_status", { body });
    expect((await getSubmissionStatus(conn, 167583)).state).toBe("graded");
  });
});
