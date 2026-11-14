// @vitest-environment node
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, newToken } from "@/server/auth/session";
import { seal } from "@/server/crypto/seal";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { jobs } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { MoodleDown } from "@/server/moodle/client";
import { ALLOWED_SITES, connectWithKey } from "@/server/moodle/connect";
import { DEMO_KEY } from "@/server/moodle/fake-inline";
import { getAssignments, getSubmissionStatus, type Assignment } from "@/server/moodle/read/assignments";
import { getCourses } from "@/server/moodle/read/courses";
import { ESTIMATE_KIND } from "@/server/ai/jobs/estimate";
import { SYNC_FILES_KIND } from "./files";
import { BUDGET_MS, CURSOR_KEY, CURSOR_MAX_AGE_MS, FRESH_MS, SLICE, cursorFrom, syncNow, type SyncNowDeps } from "./run";

// Made-up values for tests only. The fake Moodle accepts DEMO_KEY and nothing else.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const AALTO = ALLOWED_SITES[0];
// The machine can be busy; a fresh database per test takes a while.
const SLOW = 120_000;
const MINUTE = 60_000;

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

/** A user with the fake Moodle connected and nothing synced yet. */
async function connectedUser(): Promise<string> {
  const { user } = await ensureSessionFor(t.db, newToken());
  const result = await connectWithKey(user.id, AALTO, DEMO_KEY, t.db);
  if (!result.ok) throw new Error("the fake Moodle rejected the demo key");
  return result.userId;
}

type FakeOptions = {
  /** How long every Moodle call takes, on the test's own clock. */
  callMs?: number;
  /** Answer with this many assignments (copies of the fake's three) instead of three. */
  assignments?: number;
};

/**
 * The fake Moodle with a clock of its own. A call takes `callMs` on that clock
 * and no real time: calls that start together end together, like real calls
 * in flight at once. `asked` records every call.
 */
function fakeMoodle(options: FakeOptions = {}) {
  const callMs = options.callMs ?? 0;
  const state = {
    clock: Date.parse("2026-11-14T08:00:00Z"),
    /** Assignment Moodle ids whose status call fails with MoodleDown while this is set. */
    downFor: new Set<number>(),
  };
  const asked = { courses: 0, lists: 0, statusFor: [] as number[] };
  /** The fake's own assignment each copy was made from. */
  const baseOf = new Map<number, number>();

  async function call<T>(real: () => Promise<T>): Promise<T> {
    const startedAt = state.clock;
    const answer = await real();
    state.clock = Math.max(state.clock, startedAt + callMs);
    return answer;
  }

  const deps: SyncNowDeps = {
    now: () => state.clock,
    getCourses: (conn, moodleUserId) => {
      asked.courses += 1;
      return call(() => getCourses(conn, moodleUserId));
    },
    getAssignments: (conn, courseIds) => {
      asked.lists += 1;
      return call(async () => {
        const real = await getAssignments(conn, courseIds);
        if (options.assignments === undefined) return real;
        return Array.from({ length: options.assignments }, (_, i): Assignment => {
          const base = real[i % real.length];
          baseOf.set(9000 + i, base.moodleId);
          return { ...base, moodleId: 9000 + i, cmid: 9500 + i, name: `${base.name} (${i})` };
        });
      });
    },
    getSubmissionStatus: (conn, assignId) => {
      asked.statusFor.push(assignId);
      return call(async () => {
        if (state.downFor.has(assignId)) throw new MoodleDown("Moodle did not answer in time");
        return getSubmissionStatus(conn, baseOf.get(assignId) ?? assignId);
      });
    },
  };
  return { deps, asked, state };
}

async function connectionOf(userId: string) {
  const [row] = await t.db.select().from(moodleConnections).where(eq(moodleConnections.userId, userId));
  return row;
}

async function settingsOf(userId: string) {
  const [row] = await t.db.select({ settings: users.settings }).from(users).where(eq(users.id, userId));
  return row.settings;
}

async function assignmentIds(userId: string) {
  const rows = await t.db
    .select({ moodleId: assignments.moodleId })
    .from(assignments)
    .where(eq(assignments.userId, userId))
    .orderBy(asc(assignments.moodleId));
  return rows.map((row) => row.moodleId);
}

async function courseCount(userId: string) {
  return (await t.db.select({ id: courses.id }).from(courses).where(eq(courses.userId, userId))).length;
}

async function syncFilesJobs() {
  return t.db.select().from(jobs).where(eq(jobs.kind, SYNC_FILES_KIND)).orderBy(asc(jobs.createdAt));
}

async function estimateJobs() {
  return t.db.select().from(jobs).where(eq(jobs.kind, ESTIMATE_KIND)).orderBy(asc(jobs.createdAt));
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

describe("syncNow", () => {
  it("stops a slow Moodle sync in under 10 s with more: true, and a later call finishes it with nothing synced twice", async () => {
    const userId = await connectedUser();
    // 2 s per call: courses, the list, then 20 assignments in 5 rounds of status calls.
    const { deps, asked, state } = fakeMoodle({ callMs: 2_000, assignments: 20 });

    const firstStart = state.clock;
    const first = await syncNow(userId, {}, t.db, deps);
    const firstTook = state.clock - firstStart;

    // Courses (2 s), the list (4 s), two rounds of statuses (6 s, 8 s), then time is up.
    expect(first).toEqual({ ran: true, added: 4 + 2 * SLICE, status: "ok", more: true });
    expect(firstTook).toBeGreaterThanOrEqual(BUDGET_MS);
    expect(firstTook).toBeLessThan(10_000);
    expect(await courseCount(userId)).toBe(4);
    expect(await assignmentIds(userId)).toEqual(range(9000, 2 * SLICE));
    expect((await connectionOf(userId)).lastSyncAt).toBeNull();
    expect(cursorFrom(await settingsOf(userId))).toEqual({ startedAt: firstStart, done: range(9000, 2 * SLICE) });

    state.clock += 1_000; // the client calls again
    const secondStart = state.clock;
    const second = await syncNow(userId, {}, t.db, deps);

    expect(second).toEqual({ ran: true, added: 20 - 2 * SLICE, status: "ok", more: false });
    expect(state.clock - secondStart).toBeLessThan(10_000);
    expect(await assignmentIds(userId)).toEqual(range(9000, 20));
    expect(await courseCount(userId)).toBe(4);

    // Nothing twice: the courses were read once, every hand-in status was asked
    // once, and the two calls together added each row once. The list is the one
    // thing each call reads again (see the header of run.ts).
    expect(asked.courses).toBe(1);
    expect([...asked.statusFor].sort((a, b) => a - b)).toEqual(range(9000, 20));
    expect(asked.lists).toBe(2);
    expect(first.added + second.added).toBe(4 + 20);

    const conn = await connectionOf(userId);
    expect(conn.lastSyncAt?.getTime()).toBe(state.clock);
    expect(conn.status).toBe("ok");
    expect(CURSOR_KEY in (await settingsOf(userId))).toBe(false);
  }, SLOW);

  it("asks Moodle once for two calls within 10 minutes of a finished sync", async () => {
    const userId = await connectedUser();
    const { deps, asked, state } = fakeMoodle();

    expect(await syncNow(userId, {}, t.db, deps)).toEqual({ ran: true, added: 4 + 3, status: "ok", more: false });
    const afterFirst = { courses: asked.courses, lists: asked.lists, statuses: asked.statusFor.length };
    expect(afterFirst).toEqual({ courses: 1, lists: 1, statuses: 3 });
    const syncedAt = (await connectionOf(userId)).lastSyncAt;

    state.clock += FRESH_MS - 1;
    expect(await syncNow(userId, {}, t.db, deps)).toEqual({ ran: false, added: 0, status: "ok", more: false });
    expect({ courses: asked.courses, lists: asked.lists, statuses: asked.statusFor.length }).toEqual(afterFirst);
    expect((await connectionOf(userId)).lastSyncAt).toEqual(syncedAt);
  }, SLOW);

  it("syncs again when forced, and when 10 minutes have passed", async () => {
    const userId = await connectedUser();
    const { deps, asked, state } = fakeMoodle();
    await syncNow(userId, {}, t.db, deps);

    state.clock += MINUTE;
    expect(await syncNow(userId, { force: true }, t.db, deps)).toEqual({ ran: true, added: 0, status: "ok", more: false });
    expect(asked.courses).toBe(2);
    expect((await connectionOf(userId)).lastSyncAt?.getTime()).toBe(state.clock);

    state.clock += FRESH_MS;
    expect(await syncNow(userId, {}, t.db, deps)).toEqual({ ran: true, added: 0, status: "ok", more: false });
    expect(asked.courses).toBe(3);
    expect(await assignmentIds(userId)).toEqual([7101, 7301, 7401]);
  }, SLOW);

  it("marks the connection expired when Moodle rejects the key, and does not try that key again", async () => {
    const userId = await connectedUser();
    // The stored key is swapped for one the fake Moodle rejects, as if she had revoked it.
    await t.db
      .update(moodleConnections)
      .set({ tokenSealed: seal("a-key-moodle-no-longer-takes") })
      .where(eq(moodleConnections.userId, userId));
    const { deps, asked } = fakeMoodle();

    expect(await syncNow(userId, {}, t.db, deps)).toEqual({ ran: true, added: 0, status: "expired", more: false });
    const conn = await connectionOf(userId);
    expect(conn.status).toBe("expired");
    expect(conn.lastError).toContain("KeyRejected");
    expect(conn.lastError).not.toContain("a-key-moodle-no-longer-takes");
    expect(conn.lastSyncAt).toBeNull();
    expect(await courseCount(userId)).toBe(0);
    expect(asked.courses).toBe(1);

    expect(await syncNow(userId, { force: true }, t.db, deps)).toEqual({
      ran: false,
      added: 0,
      status: "expired",
      more: false,
    });
    expect(asked.courses).toBe(1);
  }, SLOW);

  it("keeps the status and saves last_error when Moodle is down, then carries on from where it was", async () => {
    const userId = await connectedUser();
    const { deps, asked, state } = fakeMoodle({ assignments: 3 * SLICE });
    state.downFor.add(9000 + SLICE + 1); // one status in the second round fails

    expect(await syncNow(userId, {}, t.db, deps)).toEqual({ ran: true, added: 4 + SLICE, status: "ok", more: false });
    let conn = await connectionOf(userId);
    expect(conn.status).toBe("ok");
    expect(conn.lastError).toBe("MoodleDown: Moodle did not answer in time");
    expect(conn.lastSyncAt).toBeNull();
    // The first round is kept; the round that failed wrote nothing.
    expect(await assignmentIds(userId)).toEqual(range(9000, SLICE));
    expect(cursorFrom(await settingsOf(userId))?.done).toEqual(range(9000, SLICE));

    state.downFor.clear();
    state.clock += MINUTE;
    // Forced, as a "try again" button would: it continues, it does not start over.
    expect(await syncNow(userId, { force: true }, t.db, deps)).toEqual({
      ran: true,
      added: 2 * SLICE,
      status: "ok",
      more: false,
    });
    expect(asked.courses).toBe(1);
    for (const id of range(9000, SLICE)) expect(asked.statusFor.filter((x) => x === id)).toHaveLength(1);
    expect(await assignmentIds(userId)).toEqual(range(9000, 3 * SLICE));
    conn = await connectionOf(userId);
    expect(conn.lastError).toBeNull();
    expect(conn.lastSyncAt?.getTime()).toBe(state.clock);
  }, SLOW);

  it("saves last_error and no cursor when Moodle is down for the course list", async () => {
    const userId = await connectedUser();
    const { deps } = fakeMoodle();
    const down: SyncNowDeps = {
      ...deps,
      getCourses: async () => {
        throw new MoodleDown("HTTP 503");
      },
    };

    expect(await syncNow(userId, {}, t.db, down)).toEqual({ ran: true, added: 0, status: "ok", more: false });
    const conn = await connectionOf(userId);
    expect(conn.status).toBe("ok");
    expect(conn.lastError).toBe("MoodleDown: HTTP 503");
    expect(conn.lastSyncAt).toBeNull();
    expect(cursorFrom(await settingsOf(userId))).toBeNull();
  }, SLOW);

  it("starts over when the unfinished sync is too old to continue", async () => {
    const userId = await connectedUser();
    const { deps, asked, state } = fakeMoodle({ callMs: 2_000, assignments: 20 });
    expect((await syncNow(userId, {}, t.db, deps)).more).toBe(true);

    state.clock += CURSOR_MAX_AGE_MS; // she closed the app and came back later
    const again = await syncNow(userId, {}, t.db, deps);
    expect(again).toEqual({ ran: true, added: 0, status: "ok", more: true });
    expect(asked.courses).toBe(2);
    expect(cursorFrom(await settingsOf(userId))?.done).toEqual(range(9000, 2 * SLICE));
  }, SLOW);

  it("keeps what else is in users.settings when it saves and clears the cursor", async () => {
    const userId = await connectedUser();
    await t.db.update(users).set({ settings: { moodleCalls: { day: "2026-11-14", count: 7 } } }).where(eq(users.id, userId));
    const { deps } = fakeMoodle({ callMs: 2_000, assignments: 20 });

    expect((await syncNow(userId, {}, t.db, deps)).more).toBe(true);
    expect((await settingsOf(userId)).moodleCalls).toEqual({ day: "2026-11-14", count: 7 });
    expect((await syncNow(userId, {}, t.db, deps)).more).toBe(false);
    expect(await settingsOf(userId)).toEqual({ moodleCalls: { day: "2026-11-14", count: 7 } });
  }, SLOW);

  it("adds one sync-files job for her when a sync finishes, and none while a step is unfinished", async () => {
    const userId = await connectedUser();
    const { deps, state } = fakeMoodle({ callMs: 2_000, assignments: 20 });

    // Time runs out with assignments left: no job yet.
    expect((await syncNow(userId, {}, t.db, deps)).more).toBe(true);
    expect(await syncFilesJobs()).toEqual([]);

    state.clock += 1_000;
    expect((await syncNow(userId, {}, t.db, deps)).more).toBe(false);
    const queued = await syncFilesJobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ userId, status: "queued", payload: { _dedupeKey: userId } });
    // Due at once, on the sync's own clock.
    expect(queued[0].runAfter.getTime()).toBe(state.clock);

    // Another finished sync while that job still waits: still one job.
    state.clock += MINUTE;
    expect((await syncNow(userId, { force: true }, t.db, deps)).more).toBe(true);
    expect((await syncNow(userId, { force: true }, t.db, deps)).more).toBe(false);
    expect(await syncFilesJobs()).toEqual(queued);

    // A call that asks Moodle nothing adds nothing; once the job has run, the next finished sync adds a new one.
    await t.db.update(jobs).set({ status: "done" }).where(eq(jobs.kind, SYNC_FILES_KIND));
    expect((await syncNow(userId, {}, t.db, deps)).ran).toBe(false);
    expect(await syncFilesJobs()).toHaveLength(1);
    state.clock += FRESH_MS;
    expect((await syncNow(userId, {}, t.db, deps)).more).toBe(true);
    expect(await syncFilesJobs()).toHaveLength(1);
    expect((await syncNow(userId, {}, t.db, deps)).more).toBe(false);
    expect((await syncFilesJobs()).map((j) => j.status)).toEqual(["done", "queued"]);
  }, SLOW);

  it("adds one estimate job per assignment with no estimate when a sync finishes, deduped per assignment", async () => {
    const userId = await connectedUser();
    const { deps, state } = fakeMoodle({ callMs: 2_000, assignments: 20 });

    // Unfinished: none yet.
    expect((await syncNow(userId, {}, t.db, deps)).more).toBe(true);
    expect(await estimateJobs()).toEqual([]);

    state.clock += 1_000;
    expect((await syncNow(userId, {}, t.db, deps)).more).toBe(false);
    const rows = await t.db.select({ id: assignments.id }).from(assignments).where(eq(assignments.userId, userId));
    expect(rows).toHaveLength(20);
    const queued = await estimateJobs();
    expect(queued.map((j) => (j.payload as { assignmentId: string }).assignmentId).sort()).toEqual(
      rows.map((r) => r.id).sort(),
    );
    for (const j of queued) {
      expect(j).toMatchObject({ userId, status: "queued", payload: { _dedupeKey: (j.payload as { assignmentId: string }).assignmentId } });
    }

    // Another finished sync while they wait: still one per assignment.
    state.clock += MINUTE;
    while ((await syncNow(userId, { force: true }, t.db, deps)).more) state.clock += 1_000;
    expect(await estimateJobs()).toHaveLength(20);

    // Once they have run, only assignments still without an estimate get a new job.
    await t.db.update(jobs).set({ status: "done" }).where(eq(jobs.kind, ESTIMATE_KIND));
    const [first, ...others] = rows;
    await t.db.update(assignments).set({ estimateMin: 45 }).where(eq(assignments.id, first.id));
    state.clock += MINUTE;
    while ((await syncNow(userId, { force: true }, t.db, deps)).more) state.clock += 1_000;
    const fresh = (await estimateJobs()).filter((j) => j.status === "queued");
    expect(fresh.map((j) => (j.payload as { assignmentId: string }).assignmentId).sort()).toEqual(
      others.map((r) => r.id).sort(),
    );
  }, SLOW);

  it("adds no sync-files job when Moodle is down or rejects the key", async () => {
    const userId = await connectedUser();
    const { deps, state } = fakeMoodle({ assignments: 2 * SLICE });
    state.downFor.add(9000);

    expect(await syncNow(userId, {}, t.db, deps)).toMatchObject({ ran: true, more: false });
    expect((await connectionOf(userId)).lastSyncAt).toBeNull();
    expect(await syncFilesJobs()).toEqual([]);

    await t.db
      .update(moodleConnections)
      .set({ tokenSealed: seal("a-key-moodle-no-longer-takes") })
      .where(eq(moodleConnections.userId, userId));
    state.downFor.clear();
    expect((await syncNow(userId, { force: true }, t.db, deps)).status).toBe("expired");
    expect(await syncFilesJobs()).toEqual([]);
    expect(await estimateJobs()).toEqual([]);

  }, SLOW);

  it("answers not_connected, without asking Moodle, for a user with no connection", async () => {
    const { user } = await ensureSessionFor(t.db, newToken());
    const { deps, asked } = fakeMoodle();

    expect(await syncNow(user.id, { force: true }, t.db, deps)).toEqual({
      ran: false,
      added: 0,
      status: "not_connected",
      more: false,
    });
    expect(asked).toEqual({ courses: 0, lists: 0, statusFor: [] });
  }, SLOW);
});
