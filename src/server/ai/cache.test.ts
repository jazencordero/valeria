// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { aiCache } from "@/server/db/schema/system";
import { cacheKey, cached, stableJson } from "./cache";

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

describe("stableJson and cacheKey", () => {
  it("sorts keys at every depth", () => {
    expect(stableJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: 3 } })).toBe(
      '{"a":{"c":3,"d":[{"x":2,"y":1}]},"b":1}',
    );
  });

  it("key order in the input does not change the hash", () => {
    const one = cacheKey("explain-card", { cardId: "c1", pages: [1, 2], opts: { short: true, lang: "en" } });
    const two = cacheKey("explain-card", { opts: { lang: "en", short: true }, pages: [1, 2], cardId: "c1" });
    expect(one).toBe(two);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a different job, input or array order changes the hash", () => {
    const base = cacheKey("a", { x: [1, 2] });
    expect(cacheKey("b", { x: [1, 2] })).not.toBe(base);
    expect(cacheKey("a", { x: [1, 3] })).not.toBe(base);
    expect(cacheKey("a", { x: [2, 1] })).not.toBe(base);
  });
});

describe("cached", () => {
  it("runs produce on the first call, stores it, and the second call does not run produce", async () => {
    const produce = vi.fn(async () => ({ text: "Explained." }));

    const first = await cached("explain-card", { cardId: "c1" }, produce, { model: "small", database: t.db });
    const second = await cached("explain-card", { cardId: "c1" }, produce, { model: "small", database: t.db });

    expect(first).toEqual({ text: "Explained." });
    expect(second).toEqual({ text: "Explained." });
    expect(produce).toHaveBeenCalledTimes(1);

    const rows = await t.db.select().from(aiCache);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      hash: cacheKey("explain-card", { cardId: "c1" }),
      job: "explain-card",
      model: "small",
      output: { text: "Explained." },
    });
  });

  it("treats the same input in a different key order as a hit", async () => {
    const produce = vi.fn(async () => "once");
    await cached("j", { a: 1, b: 2 }, produce, { database: t.db });
    await cached("j", { b: 2, a: 1 }, produce, { database: t.db });
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("runs produce once for two simultaneous calls", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const produce = vi.fn(async () => {
      await gate;
      return { n: 42 };
    });

    const both = Promise.all([
      cached("j", { q: "same" }, produce, { database: t.db }),
      cached("j", { q: "same" }, produce, { database: t.db }),
    ]);
    release();

    expect(await both).toEqual([{ n: 42 }, { n: 42 }]);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(await t.db.select().from(aiCache)).toHaveLength(1);
  });

  it("stores nothing when produce fails, so the next call tries again", async () => {
    const failing = vi.fn(async () => {
      throw new Error("provider down");
    });
    await expect(cached("j", { q: 1 }, failing, { database: t.db })).rejects.toThrow("provider down");
    expect(await t.db.select().from(aiCache)).toHaveLength(0);

    const working = vi.fn(async () => "ok");
    expect(await cached("j", { q: 1 }, working, { database: t.db })).toBe("ok");
    expect(working).toHaveBeenCalledTimes(1);
  });
});
