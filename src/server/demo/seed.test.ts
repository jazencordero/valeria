// @vitest-environment node
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentUserFor, ensureSessionFor, newToken } from "@/server/auth/session";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { lectureConcepts, lectureContent, lectures, notes } from "@/server/db/schema/learn";
import { cardConcepts, cards, exams, reviews } from "@/server/db/schema/study";
import { moodleConnections } from "@/server/db/schema/moodle";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { ALLOWED_SITES, connectWithKey } from "@/server/moodle/connect";
import { DEMO_KEY, fakeCall } from "@/server/moodle/fake-inline";
import { courseView } from "@/server/courses/store";
import { syncNow } from "@/server/sync/run";
import { seedLearn } from "./seed-learn";
import { DemoUnavailable, demoDueDates, isDemo, openDemo, resetDemo, seedDemo } from "./seed";

// Made-up values for tests only. The fake Moodle accepts DEMO_KEY and nothing else.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const SLOW = 120_000;
// Saturday 14 November 2026, 12:00 in Helsinki (UTC+2), like the prototype's day.
const NOW = new Date("2026-11-14T10:00:00Z");
// Today 21:00, today + 3 at 23:59, today + 5 at 16:00, Helsinki time.
const EXPECTED_DUE = ["2026-11-14T19:00:00.000Z", "2026-11-17T21:59:00.000Z", "2026-11-19T14:00:00.000Z"];

let t: TestDb;
beforeEach(async () => {
  vi.stubEnv("MOODLE_FAKE", "1");
  vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
  vi.stubEnv("VERCEL_ENV", "");
  t = await createTestDb();
}, SLOW);
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
});

async function browser() {
  const token = newToken();
  const { user } = await ensureSessionFor(t.db, token);
  return { token, user };
}

async function assignmentRows(userId: string) {
  return t.db
    .select({ name: assignments.name, dueAt: assignments.dueAt, state: assignments.state, moodleId: assignments.moodleId })
    .from(assignments)
    .where(eq(assignments.userId, userId))
    .orderBy(asc(assignments.dueAt));
}

describe("demoDueDates", () => {
  it("puts the first at 21:00 today and the rest on the prototype's Tuesday and Thursday (Helsinki)", () => {
    expect(demoDueDates(NOW).map((d) => d.toISOString())).toEqual(EXPECTED_DUE);
  });

  it("reads today on Helsinki's clock, not UTC's", () => {
    // 23:30 UTC on the 13th is already 01:30 on the 14th in Helsinki.
    expect(demoDueDates(new Date("2026-11-13T23:30:00Z"))[0].toISOString()).toBe(EXPECTED_DUE[0]);
  });

  it("follows summer time", () => {
    // 1 July, Helsinki is UTC+3.
    expect(demoDueDates(new Date("2026-07-01T09:00:00Z"))[0].toISOString()).toBe("2026-07-01T18:00:00.000Z");
  });
});

describe("seedDemo", () => {
  it("gives three assignments with the shifted due dates and marks the user a demo user", async () => {
    const { user } = await browser();
    const result = await seedDemo(user.id, t.db, { now: NOW });
    expect(result.assignments).toBe(3);

    const rows = await assignmentRows(user.id);
    expect(rows.map((r) => r.name)).toEqual(["Assignment 3", "Case memo 2", "Service blueprint"]);
    expect(rows.map((r) => r.dueAt?.toISOString())).toEqual(EXPECTED_DUE);
    expect(rows.every((r) => r.state === "open")).toBe(true);

    const [me] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(isDemo(me)).toBe(true);
    const own = await t.db.select().from(courses).where(eq(courses.userId, user.id));
    expect(own.length).toBeGreaterThan(0);
  }, SLOW);

  it("adds the prototype's exam and quiz on the synced courses, with cards and reviews (M3-40)", async () => {
    const { user } = await browser();
    const result = await seedDemo(user.id, t.db, { now: NOW });
    expect(result.exams).toBe(2);

    const rows = await t.db
      .select({ title: exams.title, kind: exams.kind, at: exams.at, course: courses.name })
      .from(exams)
      .innerJoin(courses, eq(courses.id, exams.courseId))
      .where(eq(exams.userId, user.id))
      .orderBy(asc(exams.at));
    expect(rows.map((r) => [r.title, r.kind, r.at.toISOString()])).toEqual([
      ["Exam", "exam", "2026-11-20T07:00:00.000Z"],
      ["Quiz 4: ARIMA basics", "quiz", "2026-11-27T10:00:00.000Z"],
    ]);
    expect(rows[0].course).toMatch(/Strategic IT Management/);
    expect(rows[1].course).toMatch(/Forecasting Methods/);
    expect(await t.db.select().from(cards).where(eq(cards.userId, user.id))).toHaveLength(16);
    expect((await t.db.select().from(reviews).where(eq(reviews.userId, user.id))).length).toBeGreaterThan(68 + 11);
  }, SLOW);

  it("keeps the shifted dates through Home's sync (not forced)", async () => {
    const { user } = await browser();
    await seedDemo(user.id, t.db, { now: NOW });
    const after = await syncNow(user.id, { force: false }, t.db);
    expect(after.ran).toBe(false);
    expect((await assignmentRows(user.id)).map((r) => r.dueAt?.toISOString())).toEqual(EXPECTED_DUE);
  }, SLOW);
});

describe("seedDemo: lectures and notes (M9-20)", () => {
  async function lectureRows(userId: string) {
    return t.db
      .select({ id: lectures.id, course: courses.name, courseId: lectures.courseId, n: lectures.n, title: lectures.title })
      .from(lectures)
      .innerJoin(courses, eq(courses.id, lectures.courseId))
      .where(eq(lectures.userId, userId))
      .orderBy(asc(courses.name), asc(lectures.n));
  }
  const countBy = (rows: { course: string }[]) => {
    const out: Record<string, number> = {};
    for (const r of rows) {
      const short = r.course.split(",")[0];
      out[short] = (out[short] ?? 0) + 1;
    }
    return out;
  };

  it("gives each of the four courses the prototype's lectures, with the current one where the prototype has it", async () => {
    const { user } = await browser();
    const result = await seedDemo(user.id, t.db, { now: NOW });
    expect(result.lectures).toBe(24);
    const rows = await lectureRows(user.id);
    expect(countBy(rows)).toEqual({
      "Digital Service Design": 5,
      "Forecasting Methods": 6,
      "Strategic IT Management": 8,
      "Supply Chain Analytics": 5,
    });

    const states: Record<string, string> = {};
    for (const courseId of new Set(rows.map((r) => r.courseId))) {
      const view = await courseView(user.id, courseId, t.db, NOW);
      states[view.course.name.split(",")[0]] = view.lectures.map((l) => l.state[0]).join("");
    }
    // d done, c current, u up next, s not posted yet.
    expect(states).toEqual({
      "Digital Service Design": "ddcus",
      "Forecasting Methods": "dddcus",
      "Strategic IT Management": "ddddcuus",
      "Supply Chain Analytics": "dddcu",
    });
  }, SLOW);

  it("writes the two full lecture pages with their blocks, and a short page for every other posted lecture", async () => {
    const { user } = await browser();
    await seedDemo(user.id, t.db, { now: NOW });
    const pages = await t.db
      .select({ course: courses.name, n: lectures.n, breath: lectureContent.breath, minutes: lectureContent.minutes, sections: lectureContent.sections })
      .from(lectureContent)
      .innerJoin(lectures, eq(lectures.id, lectureContent.lectureId))
      .innerJoin(courses, eq(courses.id, lectures.courseId))
      .where(eq(lectures.userId, user.id));
    // 24 lectures, three not posted yet (no page).
    expect(pages).toHaveLength(21);
    expect(pages.every((p) => (p.breath ?? "").length > 0 && (p.minutes ?? 0) >= 1)).toBe(true);

    type Section = { heading: string; blocks: [string, unknown][]; terms: string[]; slides: string };
    const sit = (n: number) => pages.find((p) => p.course.startsWith("Strategic IT Management") && p.n === n)!;
    const five = sit(5).sections as Section[];
    expect(sit(5).minutes).toBe(6);
    expect(five.map((s) => s.heading)).toEqual([
      "Why firms source IT from outside",
      "The sourcing options",
      "What to keep in-house",
      "Vendor lock-in",
      "Service level agreements",
    ]);
    expect(five.flatMap((s) => s.blocks.map((b) => b[0]))).toEqual(expect.arrayContaining(["p", "ul", "dl"]));
    expect(five.flatMap((s) => s.blocks.map((b) => b[0]))).not.toContain("fig");
    expect(five[3].terms).toEqual(["Switching costs", "Multi-sourcing"]);
    expect(five[4].slides).toBe("slides 20–24");
    const three = sit(3).sections as Section[];
    expect(sit(3).minutes).toBe(4);
    expect(three.map((s) => s.heading)).toEqual(["Governance is not management", "Five key IT decisions", "Who decides"]);
    expect(three[1].blocks.map((b) => b[0])).toEqual(["p", "ul"]);
  }, SLOW);

  it("links lectures only to deck concepts that have cards", async () => {
    const { user } = await browser();
    await seedDemo(user.id, t.db, { now: NOW });
    const links = await t.db
      .select({ course: courses.name, n: lectures.n, conceptId: lectureConcepts.conceptId })
      .from(lectureConcepts)
      .innerJoin(lectures, eq(lectures.id, lectureConcepts.lectureId))
      .innerJoin(courses, eq(courses.id, lectures.courseId))
      .where(eq(lectures.userId, user.id));
    const where = [...new Set(links.map((l) => `${l.course.split(",")[0]} ${l.n}`))].sort();
    expect(where).toEqual([
      "Forecasting Methods 5",
      "Forecasting Methods 6",
      "Strategic IT Management 3",
      "Strategic IT Management 5",
      "Strategic IT Management 6",
      "Strategic IT Management 7",
    ]);
    for (const l of links) {
      expect(await t.db.select().from(cardConcepts).where(eq(cardConcepts.conceptId, l.conceptId))).not.toHaveLength(0);
    }
    // The current lecture of the exam's course: Sourcing and SLAs, 4 + 3 cards.
    const rows = await lectureRows(user.id);
    const sitId = rows.find((r) => r.course.startsWith("Strategic IT Management"))!.courseId;
    const view = await courseView(user.id, sitId, t.db, NOW);
    expect(view.lectures.find((l) => l.n === 5)).toMatchObject({ state: "cur", cards: 7 });
    expect(view.lectures.filter((l) => l.cards > 0).map((l) => l.n)).toEqual([3, 5, 6, 7]);
  }, SLOW);

  it("writes the three seed notes, attached as in the prototype", async () => {
    const { user } = await browser();
    const result = await seedDemo(user.id, t.db, { now: NOW });
    expect(result.notes).toBe(3);
    const rows = await t.db
      .select({
        title: notes.title,
        kind: notes.attachKind,
        highlighted: notes.highlighted,
        course: courses.name,
        lecture: lectures.title,
        assignment: assignments.name,
        updatedAt: notes.updatedAt,
      })
      .from(notes)
      .innerJoin(courses, eq(courses.id, notes.courseId))
      .leftJoin(lectures, eq(lectures.id, notes.lectureId))
      .leftJoin(assignments, eq(assignments.id, notes.assignmentId))
      .where(eq(notes.userId, user.id))
      .orderBy(asc(notes.updatedAt));
    expect(rows.map((r) => [r.title, r.kind, r.course.split(",")[0], r.lecture ?? r.assignment, r.highlighted])).toEqual([
      ["Questions for Thursday's session", "course", "Digital Service Design", null, false],
      ["Lock-in: how to argue it in the exam", "lecture", "Strategic IT Management", "Sourcing and vendors", true],
      ["A3 plan", "assignment", "Forecasting Methods", "Assignment 3", false],
    ]);
    // Wednesday, Thursday and Friday before the prototype's Saturday.
    expect(rows.map((r) => r.updatedAt.toISOString().slice(0, 10))).toEqual(["2026-11-11", "2026-11-12", "2026-11-13"]);
  }, SLOW);

  it("is safe to run again: same lectures (same ids), pages, links and notes", async () => {
    const { user } = await browser();
    await seedDemo(user.id, t.db, { now: NOW });
    const before = await lectureRows(user.id);
    const count = async () => ({
      pages: (await t.db.select().from(lectureContent).innerJoin(lectures, eq(lectures.id, lectureContent.lectureId)).where(eq(lectures.userId, user.id))).length,
      links: (await t.db.select().from(lectureConcepts).innerJoin(lectures, eq(lectures.id, lectureConcepts.lectureId)).where(eq(lectures.userId, user.id))).length,
      notes: (await t.db.select().from(notes).where(eq(notes.userId, user.id))).length,
    });
    const first = await count();

    await seedLearn(user.id, NOW, t.db);
    expect(await lectureRows(user.id)).toEqual(before);
    expect(await count()).toEqual(first);
    expect(first.notes).toBe(3);
  }, SLOW);
});

describe("openDemo", () => {
  it("turns an empty browser user into the demo and seeds it", async () => {
    const { token, user } = await browser();
    const result = await openDemo(user, { now: NOW }, t.db);
    expect(result).toEqual({ ok: true, userId: user.id, seeded: true });
    expect(await assignmentRows(user.id)).toHaveLength(3);
    expect((await currentUserFor(t.db, token)).id).toBe(user.id);
  }, SLOW);

  it("leaves a demo user as it is without reset", async () => {
    const { user } = await browser();
    await openDemo(user, { now: NOW }, t.db);
    const [me] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(await openDemo(me, { now: NOW }, t.db)).toEqual({ ok: true, userId: user.id, seeded: false });
  }, SLOW);

  it("reset wipes the demo and seeds it again on the same browser", async () => {
    const { token, user } = await browser();
    await openDemo(user, { now: NOW }, t.db);

    // A hand-in of Assignment 3: the fake Moodle remembers it, the row says submitted.
    const conn = { siteUrl: ALLOWED_SITES[0], token: DEMO_KEY, userId: user.id };
    const statusOf = (c: typeof conn) =>
      (fakeCall(c, "mod_assign_get_submission_status", { assignid: 7101 }) as { lastattempt: { submission: { status: string } } })
        .lastattempt.submission.status;
    fakeCall(conn, "mod_assign_save_submission", { assignmentid: 7101, plugindata: {} });
    expect(statusOf(conn)).toBe("submitted");
    await t.db
      .update(assignments)
      .set({ state: "submitted", submittedAt: NOW })
      .where(and(eq(assignments.userId, user.id), eq(assignments.moodleId, 7101)));

    const [me] = await t.db.select().from(users).where(eq(users.id, user.id));
    const result = await openDemo(me, { reset: true, now: NOW }, t.db);
    if (!result.ok) throw new Error("reset refused");
    expect(result.seeded).toBe(true);

    // The old user and everything in it are gone; this browser holds the fresh one.
    expect(await t.db.select().from(users).where(eq(users.id, user.id))).toHaveLength(0);
    expect(await assignmentRows(user.id)).toHaveLength(0);
    const now = await currentUserFor(t.db, token);
    expect(now.id).toBe(result.userId);
    expect(isDemo(now)).toBe(true);

    const rows = await assignmentRows(result.userId);
    expect(rows.map((r) => r.name)).toEqual(["Assignment 3", "Case memo 2", "Service blueprint"]);
    // The demo deck comes back fresh, and the old user's went with it.
    expect(await t.db.select().from(exams).where(eq(exams.userId, user.id))).toHaveLength(0);
    expect(await t.db.select().from(exams).where(eq(exams.userId, result.userId))).toHaveLength(2);
    expect(rows.every((r) => r.state === "open")).toBe(true);
    expect(rows.map((r) => r.dueAt?.toISOString())).toEqual(EXPECTED_DUE);
    // The fake forgot the old user's hand-in.
    expect(statusOf(conn)).not.toBe("submitted");
  }, SLOW);

  it("never touches a user with data of its own, with or without reset", async () => {
    // A real-looking user: connected and synced (the fake stands in for MyCourses here).
    const { user } = await browser();
    const connected = await connectWithKey(user.id, ALLOWED_SITES[0], DEMO_KEY, t.db);
    if (!connected.ok) throw new Error("connect failed");
    await syncNow(user.id, { force: true }, t.db);
    const before = await assignmentRows(user.id);
    const [link] = await t.db.select().from(moodleConnections).where(eq(moodleConnections.userId, user.id));
    expect(before).toHaveLength(3);

    const [me] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(await openDemo(me, { now: NOW }, t.db)).toEqual({ ok: false, reason: "has_own_data" });
    expect(await openDemo(me, { reset: true, now: NOW }, t.db)).toEqual({ ok: false, reason: "has_own_data" });
    await expect(resetDemo(user.id, t.db, { now: NOW })).rejects.toThrow(/not a demo user/);

    expect(await assignmentRows(user.id)).toEqual(before);
    const [still] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(isDemo(still)).toBe(false);
    const [linkAfter] = await t.db.select().from(moodleConnections).where(eq(moodleConnections.userId, user.id));
    expect(linkAfter).toEqual(link);
  }, SLOW);

  it("a reset of one demo user leaves another demo user alone", async () => {
    const a = await browser();
    const b = await browser();
    await openDemo(a.user, { now: NOW }, t.db);
    await openDemo(b.user, { now: NOW }, t.db);
    const [aUser] = await t.db.select().from(users).where(eq(users.id, a.user.id));
    await openDemo(aUser, { reset: true, now: NOW }, t.db);
    expect((await currentUserFor(t.db, b.token)).id).toBe(b.user.id);
    expect(await assignmentRows(b.user.id)).toHaveLength(3);
  }, SLOW);
});

describe("without the fake Moodle", () => {
  it.each([
    ["MOODLE_FAKE unset", { MOODLE_FAKE: "" }],
    ["production", { MOODLE_FAKE: "1", VERCEL_ENV: "production" }],
  ])("refuses (%s) and writes nothing", async (_label, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const { user } = await browser();
    await expect(openDemo(user, { now: NOW }, t.db)).rejects.toBeInstanceOf(DemoUnavailable);
    await expect(seedDemo(user.id, t.db, { now: NOW })).rejects.toBeInstanceOf(DemoUnavailable);
    await expect(resetDemo(user.id, t.db, { now: NOW })).rejects.toBeInstanceOf(DemoUnavailable);
    const [me] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(isDemo(me)).toBe(false);
    expect(await t.db.select().from(moodleConnections)).toHaveLength(0);
    expect(await assignmentRows(user.id)).toHaveLength(0);
  }, SLOW);
});
