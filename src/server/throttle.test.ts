// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { users } from "@/server/db/schema/users";
import { allow, resetThrottle } from "./throttle";

const T0 = Date.UTC(2026, 10, 14, 10, 0, 0);
const SEC = 1000;
const PER_MINUTE = { max: 5, perSeconds: 60 };

async function tries(n: number, key: string, limit: typeof PER_MINUTE, opts: Parameters<typeof allow>[2]) {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) out.push(await allow(key, limit, opts));
  return out;
}

describe("allow, in memory (no user)", () => {
  beforeEach(() => resetThrottle());

  it("allows max tries in a window, refuses the next, and starts over after the window", async () => {
    expect(await tries(6, "s1:connect", PER_MINUTE, { now: T0 })).toEqual([true, true, true, true, true, false]);
    expect(await allow("s1:connect", PER_MINUTE, { now: T0 + 59 * SEC })).toBe(false);
    expect(await allow("s1:connect", PER_MINUTE, { now: T0 + 60 * SEC })).toBe(true);
  });

  it("counts each key on its own", async () => {
    await tries(5, "s1:connect", PER_MINUTE, { now: T0 });
    expect(await allow("s1:connect", PER_MINUTE, { now: T0 })).toBe(false);
    expect(await allow("s2:connect", PER_MINUTE, { now: T0 })).toBe(true);
  });

  it("refuses everything for a limit of zero", async () => {
    expect(await allow("k", { max: 0, perSeconds: 60 }, { now: T0 })).toBe(false);
  });
});

describe("allow, in users.settings", () => {
  let t: TestDb;
  let userId: string;

  beforeEach(async () => {
    resetThrottle();
    t = await createTestDb();
    const [u] = await t.db.insert(users).values({ settings: { theme: "calm" } }).returning();
    userId = u.id;
  });
  afterEach(async () => {
    await t.close();
  });

  const opts = (now: number) => ({ userId, db: t.db, now });

  it("keeps the count in her settings, next to what was there, and resets after the window", async () => {
    expect(await tries(6, "connect:minute", PER_MINUTE, opts(T0))).toEqual([true, true, true, true, true, false]);
    const [row] = await t.db.select({ settings: users.settings }).from(users).where(eq(users.id, userId));
    expect(row.settings).toEqual({ theme: "calm", throttle: { "connect:minute": { start: T0, count: 5 } } });

    expect(await allow("connect:minute", PER_MINUTE, opts(T0 + 59 * SEC))).toBe(false);
    expect(await allow("connect:minute", PER_MINUTE, opts(T0 + 60 * SEC))).toBe(true);
    const [after] = await t.db.select({ settings: users.settings }).from(users).where(eq(users.id, userId));
    expect(after.settings.throttle).toEqual({ "connect:minute": { start: T0 + 60 * SEC, count: 1 } });
  });

  it("survives a fresh server instance (memory forgotten)", async () => {
    await tries(5, "connect:minute", PER_MINUTE, opts(T0));
    resetThrottle();
    expect(await allow("connect:minute", PER_MINUTE, opts(T0 + SEC))).toBe(false);
  });

  it("lets only max of many tries at once through", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => allow("connect:minute", PER_MINUTE, opts(T0))));
    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it("falls back to memory when the user row does not exist", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    const o = { userId: ghost, db: t.db, now: T0 };
    expect(await tries(6, "connect:minute", PER_MINUTE, o)).toEqual([true, true, true, true, true, false]);
  });
});
