// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { usageEvents } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import { isStartPath, logEvent, OPEN_EVERY_MS, recordPageView, VISIT_MAX_MS } from "./log";
import { usageSummary } from "./summary";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const MIN = 60_000;
const T0 = new Date("2026-11-10T08:00:00Z"); // Tuesday, 10:00 in Helsinki

let t: TestDb;
let userId: string;

beforeEach(async () => {
  t = await createTestDb();
  [{ id: userId }] = await t.db.insert(users).values({}).returning({ id: users.id });
});
afterEach(async () => {
  await t.close();
});

const at = (ms: number) => new Date(T0.getTime() + ms);
const rows = (id = userId) =>
  t.db
    .select({ kind: usageEvents.kind, at: usageEvents.at, ms: usageEvents.ms })
    .from(usageEvents)
    .where(eq(usageEvents.userId, id))
    .orderBy(usageEvents.at);

describe("logEvent open", () => {
  it("two opens within 30 minutes count once", async () => {
    expect(await logEvent(userId, "open", null, { db: t.db, now: T0 })).toBe(true);
    expect(await logEvent(userId, "open", null, { db: t.db, now: at(29 * MIN) })).toBe(false);
    expect(await rows()).toHaveLength(1);
  });

  it("an open 30 minutes after the last one is a new visit", async () => {
    await logEvent(userId, "open", null, { db: t.db, now: T0 });
    expect(await logEvent(userId, "open", null, { db: t.db, now: at(OPEN_EVERY_MS) })).toBe(true);
    expect((await rows()).map((r) => r.kind)).toEqual(["open", "open"]);
  });

  it("the throttle is per user", async () => {
    const [{ id: other }] = await t.db.insert(users).values({}).returning({ id: users.id });
    await logEvent(userId, "open", null, { db: t.db, now: T0 });
    expect(await logEvent(other, "open", null, { db: t.db, now: at(MIN) })).toBe(true);
  });

  it("stores no ms on an open", async () => {
    await logEvent(userId, "open", 1234, { db: t.db, now: T0 });
    expect((await rows())[0].ms).toBeNull();
  });
});

describe("logEvent start", () => {
  it("stores the ms since that visit's open", async () => {
    await logEvent(userId, "open", null, { db: t.db, now: T0 });
    expect(await logEvent(userId, "start", null, { db: t.db, now: at(7_500) })).toBe(true);
    const [, start] = await rows();
    expect(start).toMatchObject({ kind: "start", ms: 7_500 });
  });

  it("keeps the ms the caller measured", async () => {
    await logEvent(userId, "open", null, { db: t.db, now: T0 });
    await logEvent(userId, "start", 4_200.4, { db: t.db, now: at(9_000) });
    expect((await rows())[1].ms).toBe(4_200);
  });

  it("an open older than the visit window gives no ms", async () => {
    await logEvent(userId, "open", null, { db: t.db, now: T0 });
    await logEvent(userId, "start", null, { db: t.db, now: at(VISIT_MAX_MS + 1) });
    expect((await rows())[1]).toMatchObject({ kind: "start", ms: null });
  });

  it("with no open at all, the start is stored with no ms", async () => {
    await logEvent(userId, "start", null, { db: t.db, now: T0 });
    expect(await rows()).toEqual([{ kind: "start", at: T0, ms: null }]);
  });
});

describe("logEvent guards", () => {
  it("never logs a demo user", async () => {
    const [{ id: demo }] = await t.db
      .insert(users)
      .values({ settings: { demo: true } })
      .returning({ id: users.id });
    expect(await logEvent(demo, "open", null, { db: t.db, now: T0 })).toBe(false);
    expect(await logEvent(demo, "start", 100, { db: t.db, now: T0 })).toBe(false);
    expect(await logEvent(demo, "hand_in", null, { db: t.db, now: T0 })).toBe(false);
    await recordPageView(demo, "/assignments/a1", { db: t.db, now: T0 });
    expect(await rows(demo)).toEqual([]);
  });

  it("logs a hand-in with no ms", async () => {
    expect(await logEvent(userId, "hand_in", 99, { db: t.db, now: T0 })).toBe(true);
    expect(await rows()).toEqual([{ kind: "hand_in", at: T0, ms: null }]);
  });

  it("does not throw on a bad id, an unknown kind, a missing user or a closed database", async () => {
    expect(await logEvent("not-a-uuid", "open", null, { db: t.db })).toBe(false);
    expect(await logEvent(userId, "nope" as never, null, { db: t.db })).toBe(false);
    expect(await logEvent("00000000-0000-4000-8000-000000000000", "open", null, { db: t.db })).toBe(false);
    await t.close();
    await expect(logEvent(userId, "open", null, { db: t.db })).resolves.toBe(false);
    t = await createTestDb(); // afterEach closes it
  });
});

describe("recordPageView", () => {
  it("logs an open, and a start on an assignment or study page", async () => {
    await recordPageView(userId, "/home", { db: t.db, now: T0 });
    await recordPageView(userId, "/assignments", { db: t.db, now: at(2_000) });
    await recordPageView(userId, "/assignments/a1", { db: t.db, now: at(6_000) });
    expect(await rows()).toEqual([
      { kind: "open", at: T0, ms: null },
      { kind: "start", at: at(6_000), ms: 6_000 },
    ]);
  });

  it("landing straight on an assignment is a start 0 ms after the open", async () => {
    await recordPageView(userId, "/assignments/a1", { db: t.db, now: T0 });
    expect((await rows()).map((r) => [r.kind, r.ms])).toEqual([
      ["open", null],
      ["start", 0],
    ]);
  });

  it("knows which paths are starts", () => {
    expect(isStartPath("/assignments/abc")).toBe(true);
    expect(isStartPath("/study")).toBe(true);
    expect(isStartPath("/study/session/1")).toBe(true);
    expect(isStartPath("/assignments")).toBe(false);
    expect(isStartPath("/studying")).toBe(false);
    expect(isStartPath("/home")).toBe(false);
    expect(isStartPath(42)).toBe(false);
  });
});

describe("usageSummary", () => {
  it("reads her log from the database into weeks", async () => {
    const [{ id: other }] = await t.db.insert(users).values({}).returning({ id: users.id });
    const DAY = 24 * 60 * MIN;
    // Week 46 (Mon 9 to Sun 15 November 2026): two days, starts after 6 s and 10 s.
    await recordPageView(userId, "/home", { db: t.db, now: T0 });
    await recordPageView(userId, "/assignments/a1", { db: t.db, now: at(6_000) });
    await recordPageView(userId, "/home", { db: t.db, now: at(DAY) });
    await recordPageView(userId, "/study", { db: t.db, now: at(DAY + 10_000) });
    // Week 47: one day, no start.
    await recordPageView(userId, "/home", { db: t.db, now: at(7 * DAY) });
    // Someone else's log is not hers.
    await recordPageView(other, "/home", { db: t.db, now: at(2 * DAY) });

    expect(await usageSummary(userId, t.db)).toEqual([
      { week: "2026-W46", weekStart: "2026-11-09", daysOpened: 2, opens: 2, starts: 2, medianStartMs: 8_000 },
      { week: "2026-W47", weekStart: "2026-11-16", daysOpened: 1, opens: 1, starts: 0, medianStartMs: null },
    ]);
  });
});
