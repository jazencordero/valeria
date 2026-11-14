// @vitest-environment node
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, newToken } from "@/server/auth/session";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { users } from "@/server/db/schema/users";
import { assignments, submissions } from "@/server/db/schema/work";
import { ALLOWED_SITES, connectWithKey } from "@/server/moodle/connect";
import { DEMO_KEY } from "@/server/moodle/fake-inline";
import {
  getAssignments,
  getSubmissionStatus,
  type Assignment,
  type SubmissionStatus,
} from "@/server/moodle/read/assignments";
import { attachmentRef, stateFor, syncAssignments, type SyncAssignmentsDeps } from "./assignments";
import { NotConnected, syncCourses } from "./courses";

// Made-up values for tests only. The fake Moodle accepts DEMO_KEY and nothing else.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const AALTO = ALLOWED_SITES[0];
// The machine can be busy; a fresh database per test takes a while.
const SLOW = 120_000;

let t: TestDb;
beforeEach(async () => {
  vi.stubEnv("MOODLE_FAKE", "1");
  vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
  t = await createTestDb();
}, SLOW);
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
});

/** A user with the fake Moodle connected and her four courses synced. */
async function connectedUser(): Promise<string> {
  const { user } = await ensureSessionFor(t.db, newToken());
  const result = await connectWithKey(user.id, AALTO, DEMO_KEY, t.db);
  if (!result.ok) throw new Error("the fake Moodle rejected the demo key");
  await syncCourses(result.userId, t.db);
  return result.userId;
}

type Change = {
  list?: (list: Assignment[]) => Assignment[];
  /** Moodle ids the fake should report with this status instead of its own. */
  status?: Record<number, Partial<SubmissionStatus>>;
};

/**
 * The fake Moodle is stateless and answers every status call the same way, so
 * tests change its answers on the way through. `asked` records what was asked.
 */
function fakeWith(change: Change = {}) {
  const asked = { courseIds: [] as number[][], statusFor: [] as number[] };
  const deps: SyncAssignmentsDeps = {
    getAssignments: async (conn, courseIds) => {
      asked.courseIds.push([...courseIds]);
      const list = await getAssignments(conn, courseIds);
      // The fake ignores which courses were asked for; a real Moodle does not.
      const mine = list.filter((a) => courseIds.includes(a.courseMoodleId));
      return change.list ? change.list(mine) : mine;
    },
    getSubmissionStatus: async (conn, assignId) => {
      asked.statusFor.push(assignId);
      return { ...(await getSubmissionStatus(conn, assignId)), ...change.status?.[assignId] };
    },
  };
  return { deps, asked };
}

async function rowsOf(userId: string) {
  return t.db.select().from(assignments).where(eq(assignments.userId, userId)).orderBy(asc(assignments.moodleId));
}

async function filesOf(userId: string) {
  return t.db.select().from(courseFiles).where(eq(courseFiles.userId, userId)).orderBy(asc(courseFiles.moodleRef));
}

const HANDED_IN = new Date("2026-11-10T12:00:00Z");

describe("stateFor", () => {
  it("maps Moodle's hand-in status to our state", () => {
    expect(stateFor({ state: "none" })).toBe("open");
    expect(stateFor({ state: "draft" })).toBe("draft");
    expect(stateFor({ state: "submitted" })).toBe("submitted");
    expect(stateFor({ state: "graded" })).toBe("graded");
  });
});

describe("syncAssignments", () => {
  it("lands 3 assignments and their attachments, then a second run changes nothing", async () => {
    const userId = await connectedUser();

    expect(await syncAssignments(userId, t.db)).toEqual({ added: 3, updated: 0 });
    const first = await rowsOf(userId);
    expect(first.map((row) => row.moodleId)).toEqual([7101, 7301, 7401]);
    expect(first.every((row) => row.state === "open" && row.submittedAt === null)).toBe(true);
    expect(first.every((row) => row.estimateMin === null)).toBe(true);

    const files = await filesOf(userId);
    expect(files.map((f) => f.moodleRef)).toEqual([
      "assign:7101:intro:assignment-3-brief.pdf",
      "assign:7101:intro:sales-series.pdf",
      "assign:7301:intro:case-memo-2.pdf",
      "assign:7401:intro:service-blueprint-brief.pdf",
    ]);
    expect(files.every((f) => f.textStatus === "none")).toBe(true);
    const idOf = new Map(first.map((row) => [row.moodleId, row]));
    expect(files.map((f) => f.assignmentId)).toEqual([
      idOf.get(7101)?.id,
      idOf.get(7101)?.id,
      idOf.get(7301)?.id,
      idOf.get(7401)?.id,
    ]);
    expect(files.map((f) => f.courseId)).toEqual([
      idOf.get(7101)?.courseId,
      idOf.get(7101)?.courseId,
      idOf.get(7301)?.courseId,
      idOf.get(7401)?.courseId,
    ]);

    expect(await syncAssignments(userId, t.db)).toEqual({ added: 0, updated: 0 });
    expect(await rowsOf(userId)).toEqual(first);
    expect(await filesOf(userId)).toEqual(files);
  }, SLOW);

  it("stores what Moodle said about an assignment and its file", async () => {
    const userId = await connectedUser();
    const before = Date.now();
    await syncAssignments(userId, t.db);

    const [course] = await t.db.select().from(courses).where(eq(courses.moodleId, 3101));
    const [row] = await rowsOf(userId);
    expect(row).toMatchObject({
      userId,
      courseId: course.id,
      moodleId: 7101,
      cmid: 5101,
      name: "Assignment 3",
      dueAt: new Date(1794866340 * 1000),
      cutoffAt: null,
      opensAt: new Date(1793520000 * 1000),
      acceptsFiles: true,
      acceptsText: false,
      needsSubmitButton: false,
      maxFiles: 1,
      maxBytes: 10485760,
      state: "open",
      submittedAt: null,
      seenAt: null,
    });
    expect(row.introHtml).toContain("exponential smoothing");
    expect(row.firstSeenAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);

    const [file] = await filesOf(userId);
    expect(file).toMatchObject({
      userId,
      courseId: course.id,
      assignmentId: row.id,
      moodleRef: attachmentRef(7101, "assignment-3-brief.pdf"),
      name: "assignment-3-brief.pdf",
      mime: "application/pdf",
      size: 184320,
      url: "https://moodle.example.edu/webservice/pluginfile.php/61101/mod_assign/introattachment/0/assignment-3-brief.pdf",
      section: null,
      modifiedAt: null,
      textStatus: "none",
    });
  }, SLOW);

  it("marks one as submitted when the fake reports it submitted, and only that one", async () => {
    const userId = await connectedUser();
    await syncAssignments(userId, t.db);
    const before = await rowsOf(userId);

    const { deps } = fakeWith({ status: { 7301: { state: "submitted", submittedAt: HANDED_IN, canEdit: false } } });
    expect(await syncAssignments(userId, t.db, deps)).toEqual({ added: 0, updated: 1 });

    const after = await rowsOf(userId);
    expect(after[1]).toEqual({ ...before[1], state: "submitted", submittedAt: HANDED_IN });
    expect([after[0], after[2]]).toEqual([before[0], before[2]]);

    // Same answer again: nothing to report.
    expect(await syncAssignments(userId, t.db, deps)).toEqual({ added: 0, updated: 0 });
    expect(await rowsOf(userId)).toEqual(after);
  }, SLOW);

  it("follows Moodle through draft, graded and back to open", async () => {
    const userId = await connectedUser();

    const first = fakeWith({
      status: {
        7101: { state: "draft" },
        7301: { state: "submitted", submittedAt: HANDED_IN },
        7401: { state: "graded", submittedAt: HANDED_IN },
      },
    });
    expect(await syncAssignments(userId, t.db, first.deps)).toEqual({ added: 3, updated: 0 });
    expect((await rowsOf(userId)).map((row) => [row.state, row.submittedAt])).toEqual([
      ["draft", null],
      ["submitted", HANDED_IN],
      ["graded", HANDED_IN],
    ]);

    // The teacher reverts 7301 to draft; 7101's draft is gone again.
    const second = fakeWith({ status: { 7301: { state: "draft" } } });
    expect(await syncAssignments(userId, t.db, second.deps)).toEqual({ added: 0, updated: 2 });
    expect((await rowsOf(userId)).map((row) => [row.state, row.submittedAt])).toEqual([
      ["open", null],
      ["draft", null],
      ["graded", HANDED_IN],
    ]);
    // A graded one is settled: Moodle is not asked about it again.
    expect(second.asked.statusFor.sort()).toEqual([7101, 7301]);
  }, SLOW);

  it("keeps the hand-in time we had when a grade arrives without one", async () => {
    const userId = await connectedUser();
    await syncAssignments(
      userId,
      t.db,
      fakeWith({ status: { 7301: { state: "submitted", submittedAt: HANDED_IN } } }).deps,
    );
    const graded = fakeWith({ status: { 7301: { state: "graded", submittedAt: null } } });
    expect(await syncAssignments(userId, t.db, graded.deps)).toEqual({ added: 0, updated: 1 });
    expect((await rowsOf(userId))[1]).toMatchObject({ state: "graded", submittedAt: HANDED_IN });
  }, SLOW);

  it("skips hidden courses", async () => {
    const userId = await connectedUser();
    await t.db.update(courses).set({ hidden: true }).where(eq(courses.moodleId, 3103));

    const { deps, asked } = fakeWith();
    expect(await syncAssignments(userId, t.db, deps)).toEqual({ added: 2, updated: 0 });
    expect(asked.courseIds).toHaveLength(1);
    expect([...asked.courseIds[0]].sort()).toEqual([3101, 3102, 3104]);
    expect(asked.statusFor.sort()).toEqual([7101, 7401]);
    expect((await rowsOf(userId)).map((row) => row.moodleId)).toEqual([7101, 7401]);
    expect((await filesOf(userId)).map((f) => f.name)).not.toContain("case-memo-2.pdf");

    // Even if Moodle answers with an assignment from the hidden course, it is skipped.
    const leaky: SyncAssignmentsDeps = {
      getAssignments: (conn) => getAssignments(conn, [3101, 3102, 3103, 3104]),
      getSubmissionStatus,
    };
    expect(await syncAssignments(userId, t.db, leaky)).toEqual({ added: 0, updated: 0 });
    expect(await rowsOf(userId)).toHaveLength(2);
  }, SLOW);

  it("keeps first_seen_at and counts a changed assignment as updated", async () => {
    const userId = await connectedUser();
    await syncAssignments(userId, t.db);
    const before = await rowsOf(userId);
    const newDue = new Date("2026-12-01T21:59:00Z");

    const moved = fakeWith({
      list: (list) => list.map((a) => (a.moodleId === 7401 ? { ...a, name: "Service blueprint v2", dueAt: newDue } : a)),
    });
    expect(await syncAssignments(userId, t.db, moved.deps)).toEqual({ added: 0, updated: 1 });

    const after = await rowsOf(userId);
    expect(after[2]).toEqual({ ...before[2], name: "Service blueprint v2", dueAt: newDue });
    expect(after[2].firstSeenAt).toEqual(before[2].firstSeenAt);
    expect([after[0], after[1]]).toEqual([before[0], before[1]]);
  }, SLOW);

  it("keeps the submissions row of an assignment she handed in through us", async () => {
    const userId = await connectedUser();
    await syncAssignments(userId, t.db);
    const target = (await rowsOf(userId))[0];
    const [handIn] = await t.db
      .insert(submissions)
      .values({
        userId,
        assignmentId: target.id,
        fileName: "made-up-answer.pdf",
        bytes: 2048,
        state: "submitted",
        submittedAt: HANDED_IN,
        receipt: { ok: true },
      })
      .returning();

    const said = fakeWith({ status: { 7101: { state: "submitted", submittedAt: HANDED_IN } } });
    expect(await syncAssignments(userId, t.db, said.deps)).toEqual({ added: 0, updated: 1 });
    // And once more with the stateless fake's own answer, which changes the state back.
    await syncAssignments(userId, t.db);

    expect(await t.db.select().from(submissions)).toEqual([handIn]);
    // Same assignment row as before: the id the submission points at did not move.
    expect((await rowsOf(userId))[0].id).toBe(target.id);
  }, SLOW);

  it("upserts files without duplicates and never resets pulled text", async () => {
    const userId = await connectedUser();
    await syncAssignments(userId, t.db);
    const before = await filesOf(userId);
    // A later job pulled the text of one file and queued another.
    await t.db.update(courseFiles).set({ textStatus: "done" }).where(eq(courseFiles.id, before[0].id));
    await t.db.update(courseFiles).set({ textStatus: "queued" }).where(eq(courseFiles.id, before[1].id));

    // Unchanged files: nothing is written.
    await syncAssignments(userId, t.db);
    const same = await filesOf(userId);
    expect(same).toHaveLength(4);
    expect(same.map((f) => f.textStatus)).toEqual(["done", "queued", "none", "none"]);

    // The teacher replaces one file (new size and link) and adds another.
    const changed = fakeWith({
      list: (list) =>
        list.map((a) =>
          a.moodleId === 7101
            ? {
                ...a,
                attachments: [
                  { ...a.attachments[0], size: 200_000, url: `${a.attachments[0].url}?rev=2` },
                  a.attachments[1],
                  { name: "made-up-extra.csv", url: "https://moodle.example.edu/made-up-extra.csv", mime: "", size: 10 },
                ],
              }
            : a,
        ),
    });
    // Counts are about assignments; a file change alone is not one.
    expect(await syncAssignments(userId, t.db, changed.deps)).toEqual({ added: 0, updated: 0 });

    const after = await filesOf(userId);
    expect(after).toHaveLength(5);
    expect(after[0]).toEqual({ ...before[0], size: 200_000, url: `${before[0].url}?rev=2`, textStatus: "done" });
    // Sorted by ref, the new file sits between the two old ones.
    expect(after[2]).toEqual({ ...before[1], textStatus: "queued" });
    expect(after[1]).toMatchObject({
      moodleRef: "assign:7101:intro:made-up-extra.csv",
      assignmentId: before[0].assignmentId,
      mime: null,
      textStatus: "none",
    });
  }, SLOW);

  it("leaves another user's rows untouched", async () => {
    const userId = await connectedUser();
    const [other] = await t.db.insert(users).values({}).returning();
    const [theirCourse] = await t.db
      .insert(courses)
      .values({ userId: other.id, moodleId: 3101, name: "Their own title", color: "sky" })
      .returning();
    // Same Moodle ids and file ref as hers.
    const [theirs] = await t.db
      .insert(assignments)
      .values({ userId: other.id, courseId: theirCourse.id, moodleId: 7101, name: "Their own assignment", state: "draft" })
      .returning();
    await t.db.insert(courseFiles).values({
      userId: other.id,
      courseId: theirCourse.id,
      assignmentId: theirs.id,
      moodleRef: attachmentRef(7101, "assignment-3-brief.pdf"),
      name: "their-file.pdf",
      url: "https://moodle.example.edu/their-file.pdf",
      textStatus: "done",
    });
    const before = { rows: await rowsOf(other.id), files: await filesOf(other.id) };

    expect(await syncAssignments(userId, t.db)).toEqual({ added: 3, updated: 0 });
    await syncAssignments(
      userId,
      t.db,
      fakeWith({ status: { 7101: { state: "submitted", submittedAt: HANDED_IN } } }).deps,
    );

    expect({ rows: await rowsOf(other.id), files: await filesOf(other.id) }).toEqual(before);
    expect(await rowsOf(userId)).toHaveLength(3);
    expect(await filesOf(userId)).toHaveLength(4);
  }, SLOW);

  it("leaves an assignment Moodle no longer returns as it is", async () => {
    const userId = await connectedUser();
    await syncAssignments(userId, t.db);
    const before = await rowsOf(userId);

    const without = fakeWith({ list: (list) => list.filter((a) => a.moodleId !== 7301) });
    expect(await syncAssignments(userId, t.db, without.deps)).toEqual({ added: 0, updated: 0 });
    expect(await rowsOf(userId)).toEqual(before);
    expect(await filesOf(userId)).toHaveLength(4);
  }, SLOW);

  it("refuses a user with no Moodle connection and writes nothing", async () => {
    const { user } = await ensureSessionFor(t.db, newToken());
    await expect(syncAssignments(user.id, t.db)).rejects.toBeInstanceOf(NotConnected);
    expect(await t.db.select().from(assignments)).toHaveLength(0);
    expect(await t.db.select().from(courseFiles)).toHaveLength(0);
  }, SLOW);

  it("writes nothing when Moodle cannot be read", async () => {
    const userId = await connectedUser();

    // The list fails on a first run: no rows at all.
    const noList: SyncAssignmentsDeps = {
      getAssignments: async () => {
        throw new Error("Moodle is down");
      },
      getSubmissionStatus,
    };
    await expect(syncAssignments(userId, t.db, noList)).rejects.toThrow("Moodle is down");
    expect(await rowsOf(userId)).toHaveLength(0);
    expect(await filesOf(userId)).toHaveLength(0);

    // One status call fails half way: the others are not written either.
    const noStatus: SyncAssignmentsDeps = {
      getAssignments,
      getSubmissionStatus: async (conn, assignId) => {
        if (assignId === 7401) throw new Error("Moodle went away");
        return { ...(await getSubmissionStatus(conn, assignId)), state: "submitted", submittedAt: HANDED_IN };
      },
    };
    await expect(syncAssignments(userId, t.db, noStatus)).rejects.toThrow("Moodle went away");
    expect(await rowsOf(userId)).toHaveLength(0);
    expect(await filesOf(userId)).toHaveLength(0);

    // And on a later run, existing rows stay exactly as they were.
    await syncAssignments(userId, t.db);
    const before = { rows: await rowsOf(userId), files: await filesOf(userId) };
    await expect(syncAssignments(userId, t.db, noStatus)).rejects.toThrow("Moodle went away");
    expect({ rows: await rowsOf(userId), files: await filesOf(userId) }).toEqual(before);
  }, SLOW);
});
