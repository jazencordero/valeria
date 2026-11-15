// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, newToken, NotSignedIn } from "@/server/auth/session";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { events } from "@/server/db/schema/calendar";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { jobs } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import { ALLOWED_SITES, connectWithKey } from "@/server/moodle/connect";
import { DEMO_KEY } from "@/server/moodle/fake-inline";
import { getAssignments, getSubmissionStatus } from "@/server/moodle/read/assignments";
import type { CalendarEvent, Quiz } from "@/server/moodle/read/calendar";
import type { CourseSection } from "@/server/moodle/read/contents";
import { getCourses } from "@/server/moodle/read/courses";
import { SYNC_FILES_KIND, type SyncFilesDeps } from "./files";
import { STAGE_ORDER, runFirstSync, startFirstSync, syncProgress, type SyncStage } from "./progress";
import { BUDGET_MS, CURSOR_KEY, type SyncNowDeps } from "./run";

// The route reads the app database and the signed-in user; the test swaps in its own.
const hoisted = vi.hoisted(() => ({ db: undefined as unknown, currentUser: vi.fn(), after: vi.fn() }));
vi.mock("@/server/db/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db/client")>();
  const db = new Proxy({}, {
    get(_target, prop) {
      const value: unknown = Reflect.get(hoisted.db as object, prop);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(hoisted.db) : value;
    },
  });
  return { ...real, db };
});
vi.mock("@/server/auth/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/auth/session")>();
  return { ...real, currentUser: hoisted.currentUser };
});
vi.mock("next/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("next/server")>();
  return { ...real, after: hoisted.after };
});

const { GET, POST } = await import("@/app/api/sync/progress/route");

// Made-up values for tests only. The fake Moodle accepts DEMO_KEY and nothing else.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const AALTO = ALLOWED_SITES[0];
const SLOW = 30_000;
vi.setConfig({ testTimeout: SLOW, hookTimeout: 120_000 });

let t: TestDb;
beforeEach(async () => {
  vi.stubEnv("MOODLE_FAKE", "1");
  vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
  t = await createTestDb();
  hoisted.db = t.db;
  hoisted.currentUser.mockReset();
  hoisted.after.mockReset();
});
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

async function setCursor(userId: string, cursor: Record<string, unknown> | null) {
  const [me] = await t.db.select({ settings: users.settings }).from(users).where(eq(users.id, userId));
  const settings = { ...(me.settings as Record<string, unknown>) };
  if (cursor) settings[CURSOR_KEY] = cursor;
  else delete settings[CURSOR_KEY];
  await t.db.update(users).set({ settings }).where(eq(users.id, userId));
}

function rank(stage: SyncStage): number {
  return STAGE_ORDER.indexOf(stage);
}

function expectInOrder(stages: SyncStage[]) {
  for (let i = 1; i < stages.length; i++) {
    expect(rank(stages[i]), `${stages[i - 1]} then ${stages[i]}`).toBeGreaterThanOrEqual(rank(stages[i - 1]));
  }
}

const DEC_1 = new Date("2026-12-01T10:00:00Z");
// The inline fake Moodle has no calendar and no course pages, so these answer made-up ones.
const QUIZZES: Quiz[] = [
  { moodleRef: "quiz:8101", courseMoodleId: 3102, name: "Week 6 quiz", opensAt: null, closesAt: DEC_1 },
];
const CALENDAR: CalendarEvent[] = [
  { moodleRef: "event:9101", courseMoodleId: 3101, title: "Assignment 3 is due", startsAt: DEC_1, module: "assign", url: null },
];
const PAGES: Record<number, CourseSection[]> = {
  3101: [
    {
      section: "Week 1",
      position: 1,
      modules: [
        {
          moodleRef: "cm:7101",
          name: "Lecture 1",
          kind: "resource",
          files: [{ name: "lecture-01.pdf", size: 1000, mime: "application/pdf", url: "https://example.test/f/lecture-01.pdf", modifiedAt: null }],
        },
      ],
    },
  ],
};
const filesDeps: SyncFilesDeps = { getCourseContents: async (_conn, id) => structuredClone(PAGES[id] ?? []) };

/**
 * The fake Moodle on a clock of its own where every call takes a whole sync
 * budget, so each `syncNow` call does one step and saves its cursor. Before
 * every Moodle call the progress is read, as the polling client would.
 */
function slowMoodle(userId: string) {
  const clock = { now: Date.parse("2026-11-15T08:00:00Z") };
  const seen: SyncStage[] = [];
  const step = async <T>(real: () => Promise<T>): Promise<T> => {
    seen.push((await syncProgress(userId, t.db)).stage);
    const answer = await real();
    clock.now += BUDGET_MS;
    return answer;
  };
  const deps: SyncNowDeps = {
    now: () => clock.now,
    getCourses: (conn, id) => step(() => getCourses(conn, id)),
    getAssignments: (conn, ids) => step(() => getAssignments(conn, ids)),
    getSubmissionStatus: (conn, id) => step(() => getSubmissionStatus(conn, id)),
    getQuizzes: () => step(async () => QUIZZES),
    getUpcoming: () => step(async () => CALENDAR),
  };
  const files: SyncFilesDeps = {
    getCourseContents: async (conn, id) => {
      seen.push((await syncProgress(userId, t.db)).stage);
      return filesDeps.getCourseContents(conn, id);
    },
  };
  return { deps, files, seen };
}

describe("syncProgress", () => {
  it("counts rise as rows are added, and the stage ends at done", async () => {
    const userId = await connectedUser();
    const stages: SyncStage[] = [];
    const look = async () => {
      const p = await syncProgress(userId, t.db);
      stages.push(p.stage);
      return p;
    };

    expect(await look()).toEqual({ stage: "courses", courses: [], files: 0, dates: 0 });

    const [stats, forecasting] = await t.db
      .insert(courses)
      .values([
        { userId, moodleId: 1, name: "Statistics" },
        { userId, moodleId: 2, name: "Forecasting" },
      ])
      .returning();
    await t.db.insert(courses).values({ userId, moodleId: 3, name: "Old course", hidden: true });
    expect(await look()).toEqual({ stage: "assignments", courses: ["Forecasting", "Statistics"], files: 0, dates: 0 });

    await setCursor(userId, { startedAt: Date.now(), done: [] });
    await t.db.insert(courseFiles).values({ userId, courseId: stats.id, moodleRef: "assign:1:intro:brief.pdf", name: "brief.pdf", url: "https://example.test/brief.pdf" });
    expect(await look()).toMatchObject({ stage: "assignments", files: 1 });

    await setCursor(userId, { startedAt: Date.now(), done: [1], assignmentsDone: true });
    await t.db.insert(events).values([
      { userId, courseId: stats.id, kind: "deadline", title: "Due", startsAt: DEC_1, source: "moodle", moodleRef: "event:1" },
      { userId, courseId: forecasting.id, kind: "exam", title: "Exam", startsAt: DEC_1, source: "moodle", moodleRef: "event:2" },
      { userId, kind: "other", title: "My own", startsAt: DEC_1, source: "manual" },
    ]);
    expect(await look()).toMatchObject({ stage: "dates", dates: 2 });

    // Dates are in, grades are being read: its own stage, not 'dates' again.
    await setCursor(userId, { startedAt: Date.now(), done: [1], assignmentsDone: true, datesDone: true, gradesDone: [] });
    expect(await look()).toMatchObject({ stage: "grades", dates: 2 });

    // The sync finished: cursor gone, last_sync_at set, files job queued.
    await setCursor(userId, null);
    await t.db.update(moodleConnections).set({ lastSyncAt: new Date() }).where(eq(moodleConnections.userId, userId));
    await t.db.insert(jobs).values({ kind: SYNC_FILES_KIND, userId, payload: {} });
    expect(await look()).toMatchObject({ stage: "files" });

    await t.db.insert(courseFiles).values({ userId, courseId: forecasting.id, moodleRef: "cm:9:slides.pdf", name: "slides.pdf", url: "https://example.test/slides.pdf" });
    await t.db.update(jobs).set({ status: "running" }).where(eq(jobs.kind, SYNC_FILES_KIND));
    expect(await look()).toMatchObject({ stage: "files", files: 2 });

    await t.db.update(jobs).set({ status: "done" }).where(eq(jobs.kind, SYNC_FILES_KIND));
    expect(await look()).toEqual({ stage: "done", courses: ["Forecasting", "Statistics"], files: 2, dates: 2 });

    expect(stages).toEqual(["courses", "assignments", "assignments", "dates", "grades", "files", "files", "done"]);
    expectInOrder(stages);
  });

  it("a files job that failed for good counts as done", async () => {
    const userId = await connectedUser();
    await t.db.update(moodleConnections).set({ lastSyncAt: new Date() }).where(eq(moodleConnections.userId, userId));
    await t.db.insert(jobs).values({ kind: SYNC_FILES_KIND, userId, payload: {}, status: "failed" });
    expect((await syncProgress(userId, t.db)).stage).toBe("done");
  });

  it("does not count another user's rows", async () => {
    const me = await connectedUser();
    // Not connected to Moodle: the fake has one account, and connecting it twice merges the two users.
    const other = (await ensureSessionFor(t.db, newToken())).user.id;
    const [theirs] = await t.db.insert(courses).values({ userId: other, moodleId: 1, name: "Their course" }).returning();
    await t.db.insert(courseFiles).values({ userId: other, courseId: theirs.id, moodleRef: "cm:1:a.pdf", name: "a.pdf", url: "https://example.test/a.pdf" });
    await t.db.insert(events).values({ userId: other, kind: "exam", title: "Exam", startsAt: DEC_1, source: "moodle", moodleRef: "event:1" });
    await t.db.insert(jobs).values({ kind: SYNC_FILES_KIND, userId: other, payload: {} });
    await t.db.update(moodleConnections).set({ lastSyncAt: new Date() }).where(eq(moodleConnections.userId, me));

    // Her sync finished and she has no files job; theirs being queued does not hold her at 'files'.
    expect(await syncProgress(me, t.db)).toEqual({ stage: "done", courses: [], files: 0, dates: 0 });
    expect(await syncProgress(other, t.db)).toEqual({ stage: "assignments", courses: ["Their course"], files: 1, dates: 1 });
  });
});

describe("runFirstSync", () => {
  it("runs the fake Moodle's first sync to done, stages in order, files listed without the cron", async () => {
    const userId = await connectedUser();
    const moodle = slowMoodle(userId);

    const result = await runFirstSync(userId, t.db, { sync: moodle.deps, files: moodle.files });
    expect(result.calls).toBeGreaterThan(2); // one step per call, so the cursor stages were seen
    expect(result.filesListed).toBe(true);

    const end = await syncProgress(userId, t.db);
    expect(end.stage).toBe("done");
    expect(end.courses.length).toBeGreaterThan(0);
    expect(end.files).toBeGreaterThan(0);
    expect(end.dates).toBe(2);

    const stages = [...moodle.seen, end.stage];
    expectInOrder(stages);
    for (const s of ["courses", "assignments", "dates", "files", "done"] as const) expect(stages).toContain(s);

    // The queued files job was settled, so the cron has nothing left to do for her.
    const live = await t.db.select().from(jobs).where(eq(jobs.kind, SYNC_FILES_KIND));
    expect(live.map((j) => j.status)).toEqual(["done"]);

    // A finished first sync is not repeated.
    expect(await runFirstSync(userId, t.db, { sync: moodle.deps, files: moodle.files })).toEqual({ calls: 0, filesListed: false });
  });
});

describe("startFirstSync", () => {
  it("starts once while one is scheduled or running, and again after it ended", async () => {
    const userId = await connectedUser();
    const moodle = slowMoodle(userId);
    const tasks: (() => Promise<void>)[] = [];
    const opts = { db: t.db, deps: { sync: moodle.deps, files: moodle.files }, schedule: (task: () => Promise<void>) => void tasks.push(task) };

    expect(startFirstSync(userId, opts)).toEqual({ started: true });
    expect(startFirstSync(userId, opts)).toEqual({ started: false });
    expect(tasks).toHaveLength(1);
    // Nothing ran yet: it only runs after the response.
    expect((await syncProgress(userId, t.db)).stage).toBe("courses");

    await tasks[0]();
    expect((await syncProgress(userId, t.db)).stage).toBe("done");
    expect(startFirstSync(userId, opts)).toEqual({ started: true });
    await tasks[1]();
  });
});

describe("/api/sync/progress", () => {
  it("GET answers her progress, uncached; 401 when signed out", async () => {
    const userId = await connectedUser();
    await t.db.insert(courses).values({ userId, moodleId: 1, name: "Statistics" });
    hoisted.currentUser.mockResolvedValue({ id: userId });

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ stage: "assignments", courses: ["Statistics"], files: 0, dates: 0 });

    hoisted.currentUser.mockRejectedValue(new NotSignedIn());
    const out = await GET();
    expect(out.status).toBe(401);
    expect(await out.json()).toEqual({ error: "not_signed_in" });
    expect((await POST()).status).toBe(401);
    expect(hoisted.after).not.toHaveBeenCalled();
  });

  it("POST hands the sync to after() and answers at once", async () => {
    const userId = await connectedUser();
    hoisted.currentUser.mockResolvedValue({ id: userId });

    const res = await POST();
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ started: true, stage: "courses", courses: [], files: 0, dates: 0 });
    expect(hoisted.after).toHaveBeenCalledTimes(1);

    const again = await POST();
    expect(await again.json()).toMatchObject({ started: false });
    expect(hoisted.after).toHaveBeenCalledTimes(1);
  });
});
