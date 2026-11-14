// @vitest-environment node
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentUserFor, ensureSessionFor, newToken } from "@/server/auth/session";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { ALLOWED_SITES, connectWithKey } from "@/server/moodle/connect";
import { DEMO_KEY, fakeCall } from "@/server/moodle/fake-inline";
import { syncNow } from "@/server/sync/run";
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

  it("keeps the shifted dates through Home's sync (not forced)", async () => {
    const { user } = await browser();
    await seedDemo(user.id, t.db, { now: NOW });
    const after = await syncNow(user.id, { force: false }, t.db);
    expect(after.ran).toBe(false);
    expect((await assignmentRows(user.id)).map((r) => r.dueAt?.toISOString())).toEqual(EXPECTED_DUE);
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
