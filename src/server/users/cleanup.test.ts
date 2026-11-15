// @vitest-environment node
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { exams } from "@/server/db/schema/study";
import { jobs } from "@/server/db/schema/system";
import { sessions, users } from "@/server/db/schema/users";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { cleanup } from "./cleanup";
import { CLEANUP_KIND, DEMO_PER_HOUR, demoBusy, scheduleCleanup } from "./schedule";

// The cron route reads the shared `db`; here that is the test's own database.
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/server/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/db/client")>()),
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        const real = holder.db as object;
        const value: unknown = Reflect.get(real, prop, real);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
      },
    },
  ),
}));

const SLOW = 30_000;
const DAY = 24 * 60 * 60_000;
const NOW = new Date("2026-11-15T10:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
// A made-up value for tests only.
const TEST_SECRET = "test-only-cron-secret-not-real";

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  holder.db = t.db;
}, SLOW);
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
});

type Make = { lastSeen?: Date | null; created?: Date; demo?: boolean; connected?: boolean; connectedAt?: Date };

/** A user with one session last seen at `lastSeen` (none when null), optionally a demo and/or connected. */
async function makeUser({ lastSeen = NOW, created = ago(400 * DAY), demo = false, connected = false, connectedAt }: Make) {
  const [user] = await t.db
    .insert(users)
    .values({ createdAt: created, settings: demo ? { demo: true } : {} })
    .returning();
  if (lastSeen) {
    await t.db.insert(sessions).values({ userId: user.id, tokenHash: `hash-${user.id}`, lastSeenAt: lastSeen });
  }
  if (connected) {
    await t.db.insert(moodleConnections).values({
      userId: user.id,
      siteUrl: "https://moodle.example.test",
      moodleUserId: 1,
      tokenSealed: "not-a-real-sealed-token",
      connectedAt: connectedAt ?? created,
    });
  }
  return user.id;
}

async function exists(id: string): Promise<boolean> {
  const rows = await t.db.select({ id: users.id }).from(users).where(eq(users.id, id));
  return rows.length === 1;
}

describe("cleanup", () => {
  it("removes an idle anonymous user and an idle demo user, with their data", { timeout: SLOW }, async () => {
    const anon = await makeUser({ lastSeen: ago(31 * DAY) });
    // A demo user holds the fake Moodle's connection and courses; neither keeps it.
    const demo = await makeUser({ lastSeen: ago(8 * DAY), demo: true, connected: true });
    await t.db.insert(courses).values({ userId: demo, moodleId: 1, name: "Sample course" });

    expect(await cleanup(NOW, t.db)).toEqual({ anonymous: 1, demo: 1 });
    expect(await exists(anon)).toBe(false);
    expect(await exists(demo)).toBe(false);
    // Cascade: nothing of theirs is left behind.
    expect(await t.db.select().from(sessions).where(inArray(sessions.userId, [anon, demo]))).toEqual([]);
    expect(await t.db.select().from(courses).where(eq(courses.userId, demo))).toEqual([]);
    expect(await t.db.select().from(moodleConnections).where(eq(moodleConnections.userId, demo))).toEqual([]);
  });

  it("keeps a connected user idle for a year", { timeout: SLOW }, async () => {
    const connected = await makeUser({ lastSeen: ago(365 * DAY), connected: true });
    const noSession = await makeUser({ lastSeen: null, created: ago(365 * DAY), connected: true });
    expect(await cleanup(NOW, t.db)).toEqual({ anonymous: 0, demo: 0 });
    expect(await exists(connected)).toBe(true);
    expect(await exists(noSession)).toBe(true);
  });

  it("keeps an unconnected non-demo user idle 60 days who owns a course or an exam", { timeout: SLOW }, async () => {
    // What the M3-51 importer leaves: study data, no Moodle connection.
    const withCourse = await makeUser({ lastSeen: ago(60 * DAY) });
    const [course] = await t.db
      .insert(courses)
      .values({ userId: withCourse, moodleId: 1, name: "Imported course" })
      .returning();
    // Only an exam (its course row belongs to the other user), so the exam check alone keeps her.
    const withExam = await makeUser({ lastSeen: ago(60 * DAY) });
    await t.db.insert(exams).values({ userId: withExam, courseId: course.id, title: "Final exam", at: ago(-10 * DAY) });
    const empty = await makeUser({ lastSeen: ago(60 * DAY) });

    expect(await cleanup(NOW, t.db)).toEqual({ anonymous: 1, demo: 0 });
    expect(await exists(withCourse)).toBe(true);
    expect(await exists(withExam)).toBe(true);
    expect(await exists(empty)).toBe(false);
  });

  it("keeps recent users: anonymous within 30 days, demo within 7", { timeout: SLOW }, async () => {
    const anon = await makeUser({ lastSeen: ago(29 * DAY) });
    const demo = await makeUser({ lastSeen: ago(6 * DAY), demo: true, connected: true });
    // An anonymous user idle 8 days is past the demo limit but not its own.
    const anon8 = await makeUser({ lastSeen: ago(8 * DAY) });
    expect(await cleanup(NOW, t.db)).toEqual({ anonymous: 0, demo: 0 });
    expect(await exists(anon)).toBe(true);
    expect(await exists(demo)).toBe(true);
    expect(await exists(anon8)).toBe(true);
  });

  it("never removes an account with a username, even logged out for a year (M5-14)", { timeout: SLOW }, async () => {
    const account = await makeUser({ lastSeen: null, created: ago(400 * DAY) });
    await t.db.update(users).set({ username: "test.student" }).where(eq(users.id, account));
    const demoAccount = await makeUser({ lastSeen: ago(30 * DAY), demo: true });
    await t.db.update(users).set({ username: "test.demo" }).where(eq(users.id, demoAccount));
    const anon = await makeUser({ lastSeen: null, created: ago(400 * DAY) });
    expect(await cleanup(NOW, t.db)).toEqual({ anonymous: 1, demo: 0 });
    expect(await exists(account)).toBe(true);
    expect(await exists(demoAccount)).toBe(true);
    expect(await exists(anon)).toBe(false);
  });

  it("reads the newest session, and falls back to created_at with no session", { timeout: SLOW }, async () => {
    const twoDevices = await makeUser({ lastSeen: ago(60 * DAY) });
    await t.db.insert(sessions).values({ userId: twoDevices, tokenHash: "hash-second", lastSeenAt: ago(DAY) });
    const oldNoSession = await makeUser({ lastSeen: null, created: ago(31 * DAY) });
    const newNoSession = await makeUser({ lastSeen: null, created: ago(DAY) });
    expect(await cleanup(NOW, t.db)).toEqual({ anonymous: 1, demo: 0 });
    expect(await exists(twoDevices)).toBe(true);
    expect(await exists(oldNoSession)).toBe(false);
    expect(await exists(newNoSession)).toBe(true);
  });
});

describe("scheduleCleanup", () => {
  it("adds one cleanup job a day, however often it is called", { timeout: SLOW }, async () => {
    let clock = NOW;
    const opts = { db: t.db, now: () => clock };
    expect(await scheduleCleanup(opts)).toEqual({ created: true });
    expect(await scheduleCleanup(opts)).toEqual({ created: false });

    // Still none once today's job is done.
    await t.db.update(jobs).set({ status: "done" }).where(eq(jobs.kind, CLEANUP_KIND));
    clock = new Date("2026-11-15T23:59:00Z");
    expect(await scheduleCleanup(opts)).toEqual({ created: false });

    clock = new Date("2026-11-16T00:01:00Z");
    expect(await scheduleCleanup(opts)).toEqual({ created: true });
    const rows = await t.db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.kind, CLEANUP_KIND));
    expect(rows).toHaveLength(2);
  });
});

describe("demoBusy", () => {
  it(`refuses the ${DEMO_PER_HOUR + 1}st demo user in an hour, in total`, { timeout: SLOW }, async () => {
    const opts = { db: t.db, now: () => NOW };
    // Older demos and connected real users do not count.
    await makeUser({ demo: true, connected: true, connectedAt: ago(61 * 60_000) });
    await makeUser({ connected: true, connectedAt: ago(60_000) });
    for (let i = 0; i < DEMO_PER_HOUR - 1; i++) {
      await makeUser({ demo: true, connected: true, connectedAt: ago(i * 60_000) });
    }
    expect(await demoBusy(opts)).toBe(false); // 19 made: the 20th may come
    await makeUser({ demo: true, connected: true, connectedAt: ago(30_000) });
    expect(await demoBusy(opts)).toBe(true); // 20 made: the 21st is refused
    // An hour after the first ones, there is room again.
    expect(await demoBusy({ db: t.db, now: () => new Date(NOW.getTime() + 61 * 60_000) })).toBe(false);
  });
});

describe("POST /api/cron/cleanup", () => {
  const call = async (authorization?: string) => {
    const { POST } = await import("@/app/api/cron/cleanup/route");
    const headers: Record<string, string> = authorization ? { authorization } : {};
    return POST(new Request("http://localhost/api/cron/cleanup", { method: "POST", headers }));
  };

  it("answers 401 without the cron secret, and deletes nothing", { timeout: SLOW }, async () => {
    vi.stubEnv("CRON_SECRET", TEST_SECRET);
    const anon = await makeUser({ lastSeen: new Date(Date.now() - 40 * DAY) });
    await scheduleCleanup({ db: t.db });
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(await exists(anon)).toBe(true);
  });

  it("drains the day's cleanup job", { timeout: SLOW }, async () => {
    vi.stubEnv("CRON_SECRET", TEST_SECRET);
    const anon = await makeUser({ lastSeen: new Date(Date.now() - 40 * DAY) });
    const kept = await makeUser({ lastSeen: new Date(Date.now() - 400 * DAY), connected: true });
    await scheduleCleanup({ db: t.db });
    const res = await call(`Bearer ${TEST_SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, done: 1, retried: 0, failed: 0, deleted: { anonymous: 1, demo: 0 } });
    expect(await exists(anon)).toBe(false);
    expect(await exists(kept)).toBe(true);
    const [job] = await t.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.kind, CLEANUP_KIND));
    expect(job.status).toBe("done");
  });
});
