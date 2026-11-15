// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { pushSubscriptions, reminderLog } from "@/server/db/schema/calendar";
import { courses } from "@/server/db/schema/courses";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { enqueue } from "@/server/jobs/queue";

// The cron route reads the shared `db`; here that is the test's own database.
const holder = vi.hoisted(() => ({ db: undefined as unknown, send: vi.fn() }));
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
vi.mock("@/server/push/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/push/send")>()),
  sendPush: holder.send,
}));

// Made-up values for tests only.
const TEST_CRON_SECRET = "test-only-cron-secret-not-real";
const SLOW = 30_000;
// Sun 15 Nov 2026, 18:07 Helsinki: the day-before hour for a Monday deadline.
const NOW = new Date("2026-11-15T16:07:00Z");

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  holder.db = t.db;
  holder.send.mockReset();
  holder.send.mockResolvedValue({ status: "sent", sent: 1, removed: 0, failed: 0 });
  vi.stubEnv("CRON_SECRET", TEST_CRON_SECRET);
  vi.stubEnv("VAPID_PUBLIC_KEY", "test-only-public");
  vi.stubEnv("VAPID_PRIVATE_KEY", "test-only-private");
  vi.stubEnv("VAPID_SUBJECT", "mailto:test@example.com");
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
}, 120_000);
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await t.close();
});

async function student(settings: Record<string, unknown> = {}) {
  const [user] = await t.db.insert(users).values({ settings }).returning();
  const [course] = await t.db.insert(courses).values({ userId: user.id, moodleId: 1, name: "Course", code: "C-1" }).returning();
  const due = new Date("2026-11-16T21:59:00Z");
  await t.db.insert(assignments).values([
    { userId: user.id, courseId: course.id, moodleId: 100, name: "Essay", dueAt: due, state: "open" },
    { userId: user.id, courseId: course.id, moodleId: 101, name: "Handed", dueAt: due, state: "submitted" },
  ]);
  await t.db.insert(pushSubscriptions).values({
    userId: user.id,
    endpoint: `https://fcm.googleapis.com/fcm/send/${user.id}`,
    keys: { p256dh: "p", auth: "a" },
  });
  return user.id;
}

async function run() {
  await enqueue("remind", {}, { db: t.db, runAfter: new Date(NOW.getTime() - 60_000) });
  const route = await import("./route");
  const res = await route.POST(
    new Request("https://ready.test/api/cron/remind", { method: "POST", headers: { authorization: `Bearer ${TEST_CRON_SECRET}` } }),
  );
  return { status: res.status, body: await res.json() };
}

describe("POST /api/cron/remind", () => {
  it("answers 401 without the secret", { timeout: SLOW }, async () => {
    const route = await import("./route");
    const res = await route.POST(new Request("https://ready.test/api/cron/remind", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("sends the due reminder once, logs it, and skips handed-in work and demo users", { timeout: SLOW }, async () => {
    const userId = await student();
    await student({ demo: true });
    await student({ reminders: false });

    const first = await run();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, done: 1, configured: true, users: 1, sent: 1, unsent: 0, errors: 0 });
    expect(holder.send).toHaveBeenCalledTimes(1);
    expect(holder.send.mock.calls[0][0]).toBe(userId);
    expect(holder.send.mock.calls[0][1]).toEqual({ title: "Essay", body: "C-1 · Due tomorrow at 23:59.", url: "/calendar" });
    const log = await t.db.select({ kind: reminderLog.kind }).from(reminderLog).where(eq(reminderLog.userId, userId));
    expect(log).toEqual([{ kind: "day_before" }]);

    const second = await run();
    expect(second.body).toMatchObject({ ok: true, sent: 0 });
    expect(holder.send).toHaveBeenCalledTimes(1);
  });

  it("logs nothing when push is not set up, or when no device got it", { timeout: SLOW }, async () => {
    const userId = await student();
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    expect((await run()).body).toMatchObject({ ok: true, configured: false, users: 0, sent: 0 });
    expect(holder.send).not.toHaveBeenCalled();

    vi.stubEnv("VAPID_PRIVATE_KEY", "test-only-private");
    holder.send.mockResolvedValue({ status: "sent", sent: 0, removed: 0, failed: 1 });
    expect((await run()).body).toMatchObject({ ok: true, sent: 0, unsent: 1 });
    expect(await t.db.select().from(reminderLog).where(eq(reminderLog.userId, userId))).toEqual([]);
  });
});
