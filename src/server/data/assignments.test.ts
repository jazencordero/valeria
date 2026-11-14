// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { users } from "@/server/db/schema/users";
import { assignments, drafts } from "@/server/db/schema/work";
import { getAssignmentsView } from "./assignments";

const NOW = new Date("2026-11-14T15:48:00+02:00");
const CONNECTED = new Date("2026-11-10T10:00:00+02:00");
const HOUR = 60 * 60 * 1000;

let t: TestDb;
let moodleId = 1;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

async function user(connected = true) {
  const [u] = await t.db.insert(users).values({}).returning();
  if (connected) {
    await t.db.insert(moodleConnections).values({
      userId: u.id,
      siteUrl: "https://moodle.example",
      moodleUserId: moodleId++,
      tokenSealed: "sealed",
      connectedAt: CONNECTED,
    });
  }
  return u;
}

async function course(userId: string, name: string, hidden = false) {
  const [c] = await t.db
    .insert(courses)
    .values({ userId, moodleId: moodleId++, name, hidden })
    .returning();
  return c;
}

async function assignment(
  userId: string,
  courseId: string,
  name: string,
  extra: Partial<typeof assignments.$inferInsert> = {},
) {
  const [a] = await t.db
    .insert(assignments)
    .values({ userId, courseId, moodleId: moodleId++, name, firstSeenAt: CONNECTED, ...extra })
    .returning();
  return a;
}

describe("getAssignmentsView", () => {
  it("lists open assignments earliest due first, no due date last", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods");
    const sca = await course(u.id, "Supply Chain Analytics");
    await assignment(u.id, sca.id, "No date");
    await assignment(u.id, sca.id, "Case memo 2", { dueAt: new Date("2026-11-17T23:59:00+02:00") });
    await assignment(u.id, fm.id, "Assignment 3", { dueAt: new Date("2026-11-14T21:00:00+02:00") });
    await assignment(u.id, fm.id, "Overdue", { dueAt: new Date("2026-11-13T12:00:00+02:00") });

    const view = await getAssignmentsView(u.id, { now: NOW }, t.db);

    expect(view.open.map((a) => a.title)).toEqual(["Overdue", "Assignment 3", "Case memo 2", "No date"]);
    expect(view.open[1]).toMatchObject({ course: "Forecasting Methods", courseId: fm.id });
    expect(view.open[1].href).toBe(`/assignments/${view.open[1].id}`);
    expect(view.course).toBeNull();
    expect(view.courses.map((c) => c.name)).toEqual(["Forecasting Methods", "Supply Chain Analytics"]);
  });

  it("filters both lists to one course", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods");
    const sca = await course(u.id, "Supply Chain Analytics");
    await assignment(u.id, fm.id, "Assignment 3", { dueAt: new Date("2026-11-14T21:00:00+02:00") });
    await assignment(u.id, fm.id, "Assignment 2", { submittedAt: new Date("2026-11-01T10:00:00+02:00") });
    await assignment(u.id, sca.id, "Case memo 2", { dueAt: new Date("2026-11-17T23:59:00+02:00") });
    await assignment(u.id, sca.id, "Case memo 1", { submittedAt: new Date("2026-11-02T10:00:00+02:00") });

    const view = await getAssignmentsView(u.id, { course: sca.id, now: NOW }, t.db);

    expect(view.course).toBe(sca.id);
    expect(view.open.map((a) => a.title)).toEqual(["Case memo 2"]);
    expect(view.done.map((a) => a.title)).toEqual(["Case memo 1"]);
    expect(view.courses).toHaveLength(2);
  });

  it("gives empty lists for a course with none", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods");
    const sit = await course(u.id, "Strategic IT Management");
    await assignment(u.id, fm.id, "Assignment 3", { dueAt: new Date("2026-11-14T21:00:00+02:00") });

    const view = await getAssignmentsView(u.id, { course: sit.id, now: NOW }, t.db);

    expect(view.course).toBe(sit.id);
    expect(view.open).toEqual([]);
    expect(view.done).toEqual([]);
  });

  it("ignores a course id that is not one of her visible courses", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods");
    await assignment(u.id, fm.id, "Assignment 3", { dueAt: new Date("2026-11-14T21:00:00+02:00") });

    for (const bad of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
      const view = await getAssignmentsView(u.id, { course: bad, now: NOW }, t.db);
      expect(view.course).toBeNull();
      expect(view.open).toHaveLength(1);
    }
  });

  it("lists every handed-in assignment, newest first, and keeps them out of the open list", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods");
    await assignment(u.id, fm.id, "Open one", { dueAt: new Date("2026-11-20T12:00:00+02:00") });
    await assignment(u.id, fm.id, "Week ago", { submittedAt: new Date("2026-11-07T10:00:00+02:00") });
    await assignment(u.id, fm.id, "Long ago", { submittedAt: new Date("2026-09-20T10:00:00+03:00") });
    await assignment(u.id, fm.id, "Today", { submittedAt: new Date("2026-11-14T15:52:00+02:00"), state: "submitted" });
    // Moodle says submitted but gave no time: still done, at its first-seen time.
    await assignment(u.id, fm.id, "Graded", { state: "graded", firstSeenAt: new Date("2026-10-01T10:00:00+03:00") });

    const view = await getAssignmentsView(u.id, { now: NOW }, t.db);

    expect(view.open.map((a) => a.title)).toEqual(["Open one"]);
    expect(view.done.map((a) => a.title)).toEqual(["Today", "Week ago", "Graded", "Long ago"]);
    expect(view.done[0].submittedAt.toISOString()).toBe("2026-11-14T13:52:00.000Z");
  });

  it("gives an empty done list when nothing is handed in", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods");
    await assignment(u.id, fm.id, "Assignment 3", { dueAt: new Date("2026-11-14T21:00:00+02:00") });

    const view = await getAssignmentsView(u.id, { now: NOW }, t.db);
    expect(view.done).toEqual([]);
  });

  it("leaves out another user's assignments and courses", async () => {
    const me = await user();
    const other = await user();
    const mine = await course(me.id, "Forecasting Methods");
    const theirs = await course(other.id, "Someone else's course");
    await assignment(me.id, mine.id, "Mine", { dueAt: new Date("2026-11-14T21:00:00+02:00") });
    await assignment(other.id, theirs.id, "Theirs", { dueAt: new Date("2026-11-14T20:00:00+02:00") });
    await assignment(other.id, theirs.id, "Theirs done", { submittedAt: new Date("2026-11-14T10:00:00+02:00") });

    const view = await getAssignmentsView(me.id, { now: NOW }, t.db);
    expect(view.open.map((a) => a.title)).toEqual(["Mine"]);
    expect(view.done).toEqual([]);
    expect(view.courses.map((c) => c.name)).toEqual(["Forecasting Methods"]);

    // Choosing their course id does not reach their assignments.
    const peek = await getAssignmentsView(me.id, { course: theirs.id, now: NOW }, t.db);
    expect(peek.course).toBeNull();
    expect(peek.open.map((a) => a.title)).toEqual(["Mine"]);
  });

  it("leaves out hidden courses and their assignments", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods");
    const old = await course(u.id, "Hidden course", true);
    await assignment(u.id, fm.id, "Visible", { dueAt: new Date("2026-11-14T21:00:00+02:00") });
    await assignment(u.id, old.id, "Hidden open", { dueAt: new Date("2026-11-14T20:00:00+02:00") });
    await assignment(u.id, old.id, "Hidden done", { submittedAt: new Date("2026-11-14T10:00:00+02:00") });

    const view = await getAssignmentsView(u.id, { now: NOW }, t.db);
    expect(view.courses.map((c) => c.name)).toEqual(["Forecasting Methods"]);
    expect(view.open.map((a) => a.title)).toEqual(["Visible"]);
    expect(view.done).toEqual([]);

    const chosen = await getAssignmentsView(u.id, { course: old.id, now: NOW }, t.db);
    expect(chosen.course).toBeNull();
    expect(chosen.open.map((a) => a.title)).toEqual(["Visible"]);
  });

  it("marks status: New after the first sync, Draft saved, else Not started", async () => {
    const u = await user();
    const fm = await course(u.id, "Forecasting Methods");
    const due = new Date("2026-11-20T12:00:00+02:00");
    await assignment(u.id, fm.id, "First sync", { dueAt: due });
    await assignment(u.id, fm.id, "Arrived later", { dueAt: due, firstSeenAt: new Date(NOW.getTime() - 2 * HOUR) });
    await assignment(u.id, fm.id, "Later but opened", {
      dueAt: due,
      firstSeenAt: new Date(NOW.getTime() - 2 * HOUR),
      seenAt: new Date(NOW.getTime() - HOUR),
    });
    await assignment(u.id, fm.id, "Draft state", { dueAt: due, state: "draft" });
    const withDraft = await assignment(u.id, fm.id, "Draft row", { dueAt: due });
    await t.db.insert(drafts).values({ userId: u.id, assignmentId: withDraft.id, contentMd: "Some words" });

    const view = await getAssignmentsView(u.id, { now: NOW }, t.db);
    const status = Object.fromEntries(view.open.map((a) => [a.title, a.status]));
    expect(status).toEqual({
      "First sync": "not_started",
      "Arrived later": "new",
      "Later but opened": "not_started",
      "Draft state": "draft_saved",
      "Draft row": "draft_saved",
    });
  });

  it("marks nothing New without a Moodle connection", async () => {
    const u = await user(false);
    const fm = await course(u.id, "Forecasting Methods");
    await assignment(u.id, fm.id, "Fresh", {
      dueAt: new Date("2026-11-20T12:00:00+02:00"),
      firstSeenAt: new Date(NOW.getTime() - HOUR),
    });

    const view = await getAssignmentsView(u.id, { now: NOW }, t.db);
    expect(view.open[0].status).toBe("not_started");
  });
});
