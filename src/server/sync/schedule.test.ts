// @vitest-environment node
import { and, asc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, newToken } from "@/server/auth/session";
import { seal } from "@/server/crypto/seal";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { jobs } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import { DEMO_FLAG } from "@/server/demo/seed";
import { drain, enqueue } from "@/server/jobs/queue";
import { KeyRejected, resetMoodleClient } from "@/server/moodle/client";
import { ALLOWED_SITES, connectWithKey } from "@/server/moodle/connect";
import { DEMO_KEY } from "@/server/moodle/fake-inline";
import type { SyncNowDeps } from "./run";
import {
  JITTER_MS,
  MAX_PER_DAY,
  STALE_MS,
  SYNC_KIND,
  jitterFraction,
  runBackgroundSync,
  scheduleSyncs,
} from "./schedule";

// The cron routes read the shared `db`; here that is the test's own database.
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

// Made-up values for tests only. The fake Moodle accepts DEMO_KEY and nothing else.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const TEST_CRON_SECRET = "test-only-cron-secret-not-real";
const AALTO = ALLOWED_SITES[0];
// The machine can be busy; a fresh database per test takes a while.
const SLOW = 30_000;
const HOUR = 60 * 60_000;

let t: TestDb;
beforeEach(async () => {
  vi.stubEnv("MOODLE_FAKE", "1");
  vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
  t = await createTestDb();
  holder.db = t.db;
}, 120_000);
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetMoodleClient();
  await t.close();
});

/** The fake Moodle's demo user, connected for real; her data is `ageMs` old (connected and last synced then). */
async function fakeMoodleUser(ageMs: number): Promise<string> {
  const { user } = await ensureSessionFor(t.db, newToken());
  const result = await connectWithKey(user.id, AALTO, DEMO_KEY, t.db);
  if (!result.ok) throw new Error("the fake Moodle rejected the demo key");
  await age(result.userId, ageMs);
  return result.userId;
}

async function age(userId: string, ageMs: number, synced = true) {
  const at = new Date(Date.now() - ageMs);
  await t.db
    .update(moodleConnections)
    .set({ connectedAt: at, lastSyncAt: synced ? at : null })
    .where(eq(moodleConnections.userId, userId));
}

let nextMoodleId = 900_000;
/**
 * A user with a connection row of her own (the fake Moodle has one identity,
 * and connecting it twice merges the two users). Nothing here calls Moodle.
 */
async function userWithData(ageMs: number, synced = true): Promise<string> {
  const { user } = await ensureSessionFor(t.db, newToken());
  await t.db.insert(moodleConnections).values({
    userId: user.id,
    siteUrl: AALTO,
    moodleUserId: nextMoodleId++,
    tokenSealed: seal("not-a-real-token"),
  });
  await age(user.id, ageMs, synced);
  return user.id;
}

async function syncJobs(userId?: string) {
  return t.db
    .select()
    .from(jobs)
    .where(userId ? and(eq(jobs.kind, SYNC_KIND), eq(jobs.userId, userId)) : eq(jobs.kind, SYNC_KIND))
    .orderBy(asc(jobs.createdAt));
}

const noJitter = () => 0;

describe("scheduleSyncs", () => {
  it("queues one job for each stale user and none for fresh ones", { timeout: SLOW }, async () => {
    const stale = await userWithData(STALE_MS + HOUR);
    const fresh = await userWithData(STALE_MS - HOUR);
    const justNow = await userWithData(0);

    const { queued } = await scheduleSyncs({ db: t.db, jitter: noJitter });
    expect(queued.map((q) => q.userId)).toEqual([stale]);
    const rows = await syncJobs();
    expect(rows.map((j) => [j.userId, j.status])).toEqual([[stale, "queued"]]);
    expect((await syncJobs(fresh)).length + (await syncJobs(justNow)).length).toBe(0);
  });

  it("a connection whose first sync never finished counts from when she connected", { timeout: SLOW }, async () => {
    const longAgo = await userWithData(STALE_MS + HOUR, false);
    const recent = await userWithData(HOUR, false);
    // Reconnected a minute ago after a long-stale sync: her first sync runs in the foreground now.
    const reconnected = await userWithData(STALE_MS + HOUR);
    await t.db
      .update(moodleConnections)
      .set({ connectedAt: new Date(Date.now() - 60_000) })
      .where(eq(moodleConnections.userId, reconnected));

    const { queued } = await scheduleSyncs({ db: t.db, jitter: noJitter });
    expect(queued.map((q) => q.userId)).toEqual([longAgo]);
    expect(await syncJobs(recent)).toEqual([]);
    expect(await syncJobs(reconnected)).toEqual([]);
  });

  it("never queues a user whose key was rejected, until she reconnects", { timeout: SLOW }, async () => {
    const userId = await fakeMoodleUser(STALE_MS + HOUR);
    for (const status of ["expired", "revoked", "error"] as const) {
      await t.db.update(moodleConnections).set({ status }).where(eq(moodleConnections.userId, userId));
      expect((await scheduleSyncs({ db: t.db, jitter: noJitter })).queued).toEqual([]);
    }
    expect(await syncJobs(userId)).toEqual([]);

    // She reconnects: status 'ok' and a fresh connected_at; once that is 6 hours old she is due again.
    await connectWithKey(userId, AALTO, DEMO_KEY, t.db);
    expect((await scheduleSyncs({ db: t.db, jitter: noJitter })).queued).toEqual([]);
    const later = new Date(Date.now() + STALE_MS + HOUR);
    const { queued } = await scheduleSyncs({ db: t.db, jitter: noJitter, now: () => later });
    expect(queued.map((q) => q.userId)).toEqual([userId]);
  });

  it("never queues a demo user", { timeout: SLOW }, async () => {
    const userId = await userWithData(STALE_MS + HOUR);
    await t.db
      .update(users)
      .set({ settings: { [DEMO_FLAG]: true } })
      .where(eq(users.id, userId));
    expect((await scheduleSyncs({ db: t.db, jitter: noJitter })).queued).toEqual([]);
  });

  it("adds no second job while one is queued or running", { timeout: SLOW }, async () => {
    const userId = await userWithData(STALE_MS + HOUR);
    expect((await scheduleSyncs({ db: t.db, jitter: noJitter })).queued).toHaveLength(1);
    expect((await scheduleSyncs({ db: t.db, jitter: noJitter })).queued).toEqual([]);

    await t.db.update(jobs).set({ status: "running" }).where(eq(jobs.userId, userId));
    expect((await scheduleSyncs({ db: t.db, jitter: noJitter })).queued).toEqual([]);
    expect(await syncJobs(userId)).toHaveLength(1);

    // Two ticks at the same moment still add one.
    const other = await userWithData(STALE_MS + HOUR);
    await Promise.all([
      scheduleSyncs({ db: t.db, jitter: noJitter }),
      scheduleSyncs({ db: t.db, jitter: noJitter }),
    ]);
    expect(await syncJobs(other)).toHaveLength(1);
  });

  it(`stops at ${MAX_PER_DAY} jobs per user in 24 hours`, { timeout: SLOW }, async () => {
    const userId = await userWithData(STALE_MS + HOUR);
    // Each sync ends without finishing (Moodle down), so she stays stale.
    for (let i = 0; i < MAX_PER_DAY; i++) {
      expect((await scheduleSyncs({ db: t.db, jitter: noJitter })).queued).toHaveLength(1);
      await t.db.update(jobs).set({ status: i % 2 ? "done" : "failed" }).where(eq(jobs.userId, userId));
    }
    expect((await scheduleSyncs({ db: t.db, jitter: noJitter })).queued).toEqual([]);
    expect(await syncJobs(userId)).toHaveLength(MAX_PER_DAY);

    // Jobs older than 24 hours no longer count.
    await t.db
      .update(jobs)
      .set({ createdAt: new Date(Date.now() - 25 * HOUR) })
      .where(eq(jobs.userId, userId));
    expect((await scheduleSyncs({ db: t.db, jitter: noJitter })).queued).toHaveLength(1);
  });

  it("spreads run times over the next two hours, the same for a user all day", { timeout: SLOW }, async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await userWithData(STALE_MS + HOUR));
    const at = new Date("2026-11-15T09:00:00.000Z");
    const { queued } = await scheduleSyncs({ db: t.db, now: () => at });

    expect(queued).toHaveLength(6);
    const offsets = queued.map((q) => q.runAfter.getTime() - at.getTime());
    for (const o of offsets) {
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(JITTER_MS);
    }
    expect(new Set(offsets).size).toBe(6);
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThan(10 * 60_000);
    // Stored as the job's run_after.
    for (const q of queued) {
      const [job] = await syncJobs(q.userId);
      expect(job.runAfter.getTime()).toBe(q.runAfter.getTime());
    }
    // Deterministic per user and day; another day gives another offset.
    expect(jitterFraction(ids[0], at)).toBe(jitterFraction(ids[0], new Date("2026-11-15T23:59:00.000Z")));
    expect(jitterFraction(ids[0], at)).not.toBe(jitterFraction(ids[0], new Date("2026-11-16T09:00:00.000Z")));

    // An injected jitter is used as given.
    const other = await userWithData(STALE_MS + HOUR);
    const half = await scheduleSyncs({ db: t.db, now: () => at, jitter: () => 0.5 });
    expect(half.queued).toEqual([{ userId: other, runAfter: new Date(at.getTime() + JITTER_MS / 2) }]);
  });
});

describe("runBackgroundSync", () => {
  it("skips a user who synced in the meantime, and ends quietly on a rejected key", { timeout: SLOW }, async () => {
    const fresh = await userWithData(HOUR);
    expect(await runBackgroundSync(fresh, { db: t.db })).toEqual({ outcome: "skipped", calls: 0 });

    const userId = await userWithData(STALE_MS + HOUR);
    const rejecting: SyncNowDeps = {
      getCourses: async () => {
        throw new KeyRejected("core_enrol_get_users_courses", { errorcode: "invalidtoken" });
      },
      getAssignments: async () => [],
      getSubmissionStatus: async () => {
        throw new Error("not reached");
      },
      getUpcoming: async () => [],
      getQuizzes: async () => [],
      getGradeItems: async () => [],
      now: () => Date.now(),
    };
    expect(await runBackgroundSync(userId, { db: t.db, deps: rejecting })).toEqual({ outcome: "expired", calls: 1 });
    const [link] = await t.db.select().from(moodleConnections).where(eq(moodleConnections.userId, userId));
    expect(link.status).toBe("expired");
    // Expired now: never queued, and a job already queued asks Moodle nothing.
    expect((await scheduleSyncs({ db: t.db, jitter: noJitter })).queued).toEqual([]);
    expect(await runBackgroundSync(userId, { db: t.db, deps: rejecting })).toEqual({ outcome: "skipped", calls: 0 });
  });
});

describe("POST /api/cron/sync", () => {
  const URL_ = "https://ready.test/api/cron/sync";
  const call = async (headers: Record<string, string> = {}) => {
    const route = await import("@/app/api/cron/sync/route");
    return route.POST(new Request(URL_, { method: "POST", headers }));
  };
  const bearer = { authorization: `Bearer ${TEST_CRON_SECRET}` };

  it("answers 401 without the secret and runs no job", { timeout: SLOW }, async () => {
    const userId = await fakeMoodleUser(STALE_MS + HOUR);
    await scheduleSyncs({ db: t.db, jitter: noJitter });

    expect((await call(bearer)).status).toBe(401);
    vi.stubEnv("CRON_SECRET", TEST_CRON_SECRET);
    const attempts: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }, { authorization: TEST_CRON_SECRET }];
    for (const headers of attempts) {
      const res = await call(headers);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(TEST_CRON_SECRET);
    }
    expect((await syncJobs(userId)).map((j) => j.status)).toEqual(["queued"]);
  });

  it("with the secret, drains her sync job and runs the sync against the fake Moodle", { timeout: SLOW }, async () => {
    const userId = await fakeMoodleUser(STALE_MS + HOUR);
    const before = Date.now();
    await scheduleSyncs({ db: t.db, jitter: noJitter });
    vi.stubEnv("CRON_SECRET", TEST_CRON_SECRET);

    const res = await call(bearer);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(TEST_CRON_SECRET);
    expect(body).not.toContain(DEMO_KEY);
    expect(JSON.parse(body)).toEqual({
      ok: true,
      done: 1,
      retried: 0,
      failed: 0,
      synced: 1,
      unfinished: 0,
      expired: 0,
      skipped: 0,
    });
    expect((await syncJobs(userId)).map((j) => j.status)).toEqual(["done"]);
    const [link] = await t.db.select().from(moodleConnections).where(eq(moodleConnections.userId, userId));
    expect(link.status).toBe("ok");
    expect(link.lastSyncAt!.getTime()).toBeGreaterThanOrEqual(before);
    // The fake's courses are in.
    expect((await t.db.select().from(courses).where(eq(courses.userId, userId))).length).toBeGreaterThan(0);

    // Fresh now: the next tick queues nothing for her.
    expect((await scheduleSyncs({ db: t.db, jitter: noJitter })).queued).toEqual([]);
    // Nothing left to drain.
    expect(await drain(SYNC_KIND, () => {}, { db: t.db })).toEqual({ done: 0, retried: 0, failed: 0 });
  });
});

describe("GET /api/cron/tick", () => {
  it("queues the background syncs first, and still runs when that fails", { timeout: SLOW }, async () => {
    vi.stubEnv("CRON_SECRET", TEST_CRON_SECRET);
    const userId = await fakeMoodleUser(STALE_MS + HOUR);
    const fetchMock = vi.fn(async () => Response.json({ done: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const route = await import("@/app/api/cron/tick/route");
    const tick = () =>
      route.GET(new Request("https://ready.test/api/cron/tick", { headers: { authorization: `Bearer ${TEST_CRON_SECRET}` } }));

    const res = await tick();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, skipped: [] });
    expect((await syncJobs(userId)).map((j) => j.status)).toEqual(["queued"]);

    // Scheduling throws (here: the connections table is gone); the tick still drains what is due.
    await enqueue("work", {}, { db: t.db });
    await t.db.execute(sql.raw("alter table moodle_connections rename to moodle_connections_gone"));
    const failed = await tick();
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({
      ok: true,
      kinds: [{ kind: "work", status: 200, ok: true }],
      skipped: [],
      scheduleFailed: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
