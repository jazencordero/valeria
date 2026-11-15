// @vitest-environment node
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor } from "@/server/auth/session";
import { notes, tutorMessages } from "@/server/db/schema/learn";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import {
  answersLeftFor,
  budgetEur,
  budgetLeft,
  claudeAllowed,
  costDots,
  costEur,
  DEFAULT_ANSWER_TOKENS,
  DEFAULT_BUDGET_EUR,
  LEVEL_MODEL,
  monthOf,
  monthSpend,
  TUTOR_CLAUDE,
  tutorBudgetLine,
  tutorMeter,
  USD_TO_EUR,
} from "./budget";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

const KEY = { ANTHROPIC_API_KEY: "fake-anthropic-key-not-real" };

async function answer(userId: string, model: string | null, at: Date, use: { in?: number; out?: number; read?: number; write?: number }) {
  await t.db.insert(tutorMessages).values({
    userId,
    anchorKind: "general",
    role: "assistant",
    body: "a",
    model,
    tokensIn: use.in ?? 0,
    tokensOut: use.out ?? 0,
    cacheReadTokens: use.read ?? 0,
    cacheWriteTokens: use.write ?? 0,
    createdAt: at,
  });
}

describe("the price block", () => {
  it("names the small, middle and large Claude models, with their caps", () => {
    expect(TUTOR_CLAUDE.small).toMatchObject({ id: "claude-haiku-5-5", maxTokens: 500 });
    expect(TUTOR_CLAUDE.balanced).toMatchObject({ id: "claude-sonnet-5-5", maxTokens: 800 });
    expect(TUTOR_CLAUDE.deep).toMatchObject({ id: "claude-fable-5-2", maxTokens: 1200 });
    expect(TUTOR_CLAUDE.balanced.usdPerMTok).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
  });

  it("maps the picker's levels onto the models, and derives the cost marks from the price ratios", () => {
    expect([LEVEL_MODEL.quick.id, LEVEL_MODEL.balanced.id, LEVEL_MODEL.deep.id]).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-fable-5-2"]);
    // 1 : 20 : 80 on price -> 1, 3 and 4 dots.
    expect([costDots("quick"), costDots("balanced"), costDots("deep")]).toEqual([1, 3, 4]);
  });

  it("prices input, output, cache reads and writes per model, in euros; free models cost nothing", () => {
    const million = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(costEur("anthropic:claude-haiku-5-5", million)).toBeCloseTo(0.1 * USD_TO_EUR, 10);
    expect(costEur("anthropic:claude-fable-5-2", { ...million, input: 0, output: 1_000_000 })).toBeCloseTo(40 * USD_TO_EUR, 10);
    expect(costEur("anthropic:claude-fable-5-2", { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 })).toBeCloseTo(10.2 * USD_TO_EUR, 10);
    expect(costEur("groq:openai/gpt-oss-120b", million)).toBe(0);
    // An Anthropic model we do not list is priced as the dearest.
    expect(costEur("anthropic:something-new", million)).toBeCloseTo(8 * USD_TO_EUR, 10);
  });
});

describe("budgetEur", () => {
  it("defaults to 150, reads a plain number, and fails closed (0) on anything else", () => {
    expect(budgetEur({})).toBe(DEFAULT_BUDGET_EUR);
    expect(DEFAULT_BUDGET_EUR).toBe(150);
    expect(budgetEur({ TUTOR_BUDGET_EUR: " " })).toBe(150);
    expect(budgetEur({ TUTOR_BUDGET_EUR: "40" })).toBe(40);
    expect(budgetEur({ TUTOR_BUDGET_EUR: "12.5" })).toBe(12.5);
    for (const bad of ["-5", "5O", "abc", "1e9", "Infinity", "NaN", "10 EUR"]) expect(budgetEur({ TUTOR_BUDGET_EUR: bad }), bad).toBe(0);
  });
});

describe("monthOf (Europe/Helsinki)", () => {
  it("starts the month at Helsinki midnight on the 1st, in winter and summer time", () => {
    // 2026-11-15: Helsinki is UTC+2, so November starts 2026-10-31 22:00 UTC.
    expect(monthOf(new Date("2026-11-15T10:00:00Z"))).toEqual({
      start: new Date("2026-10-31T22:00:00Z"),
      end: new Date("2026-11-30T22:00:00Z"),
    });
    // July (UTC+3).
    expect(monthOf(new Date("2026-07-10T12:00:00Z")).start).toEqual(new Date("2026-06-30T21:00:00Z"));
    // 23:30 UTC on Nov 30 is already December in Helsinki.
    expect(monthOf(new Date("2026-11-30T23:30:00Z")).start).toEqual(new Date("2026-11-30T22:00:00Z"));
    // Across the year end.
    expect(monthOf(new Date("2026-12-31T21:59:00Z")).end).toEqual(new Date("2026-12-31T22:00:00Z"));
  });
});

describe("monthSpend and the budget", () => {
  const NOW = new Date("2026-11-15T10:00:00Z");

  it("sums every user's Claude answers this month, per model; free models, her questions and last month do not count", async () => {
    const { user: a } = await ensureSessionFor(t.db, undefined);
    const { user: b } = await ensureSessionFor(t.db, undefined);
    await answer(a.id, "anthropic:claude-haiku-5-5", new Date("2026-11-02T08:00:00Z"), { in: 600_000, out: 400_000, read: 1_000_000 });
    await answer(b.id, "anthropic:claude-haiku-5-5", new Date("2026-11-03T08:00:00Z"), { in: 400_000, out: 600_000 });
    await answer(b.id, "anthropic:claude-fable-5-2", new Date("2026-11-14T08:00:00Z"), { out: 100_000 });
    await answer(a.id, "groq:openai/gpt-oss-120b", new Date("2026-11-14T08:00:00Z"), { in: 9_000_000, out: 9_000_000 });
    // 2026-10-31 21:59 UTC is still October in Helsinki.
    await answer(a.id, "anthropic:claude-fable-5-2", new Date("2026-10-31T21:59:00Z"), { out: 9_000_000 });
    await t.db.insert(tutorMessages).values({ userId: a.id, anchorKind: "general", role: "user", body: "q", model: "anthropic:claude-fable-5-2", tokensOut: 9_000_000 });

    const spend = await monthSpend(NOW, t.db);
    const haiku = spend.byModel.find((m) => m.model === "anthropic:claude-haiku-5-5")!;
    expect(haiku.use).toEqual({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 });
    // (0.10 + 0.50 + 0.01) USD + 100K Fable output (4 USD) = 4.61 USD.
    expect(spend.eur).toBeCloseTo(4.61 * USD_TO_EUR, 6);
    expect(spend.byModel).toHaveLength(2);
  });

  it("past the budget: no budget left, so Claude is not allowed until next month", async () => {
    const { user } = await ensureSessionFor(t.db, undefined);
    // 3 million Fable output tokens: 120 USD, about 110 EUR.
    await answer(user.id, "anthropic:claude-fable-5-2", new Date("2026-11-10T08:00:00Z"), { out: 3_000_000 });
    expect(await budgetLeft({ TUTOR_BUDGET_EUR: "150" }, NOW, t.db)).toBe(true);
    expect(await budgetLeft({ TUTOR_BUDGET_EUR: "100" }, NOW, t.db)).toBe(false);
    expect(await claudeAllowed({ ...KEY, TUTOR_BUDGET_EUR: "100" }, NOW, t.db)).toBe(false);
    expect(await claudeAllowed({ ...KEY, TUTOR_BUDGET_EUR: "150" }, NOW, t.db)).toBe(true);
    // A new month in Helsinki starts from zero.
    expect(await claudeAllowed({ ...KEY, TUTOR_BUDGET_EUR: "100" }, new Date("2026-11-30T22:00:01Z"), t.db)).toBe(true);
    // No key: never allowed. A broken budget value: never allowed.
    expect(await claudeAllowed({ TUTOR_BUDGET_EUR: "150" }, NOW, t.db)).toBe(false);
    expect(await claudeAllowed({ ...KEY, TUTOR_BUDGET_EUR: "lots" }, NOW, t.db)).toBe(false);
  });

  it("gives Settings its line", async () => {
    const { user } = await ensureSessionFor(t.db, undefined);
    expect(await tutorBudgetLine({}, NOW, t.db)).toBe("Tutor this month: about 0 EUR of 150");
    await answer(user.id, "anthropic:claude-fable-5-2", new Date("2026-11-10T08:00:00Z"), { out: 1_000_000 });
    expect(await tutorBudgetLine({ TUTOR_BUDGET_EUR: "60" }, NOW, t.db)).toBe(`Tutor this month: about ${Math.round(40 * USD_TO_EUR)} EUR of 60`);
  });
});

describe("tutorMeter", () => {
  const NOW = new Date("2026-11-15T10:00:00Z");
  const each = (level: "quick" | "balanced" | "deep") => costEur(`anthropic:${LEVEL_MODEL[level].id}`, DEFAULT_ANSWER_TOKENS[level]);

  /** `n` answers of `use` on `model` for `userId`, one insert. */
  async function answers(userId: string, model: string, n: number, use: { in?: number; out?: number }) {
    const at = new Date("2026-11-10T08:00:00Z");
    await t.db.insert(tutorMessages).values(
      Array.from({ length: n }, () => ({
        userId,
        anchorKind: "general" as const,
        role: "assistant" as const,
        body: "a",
        model,
        tokensIn: use.in ?? 0,
        tokensOut: use.out ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        createdAt: at,
      })),
    );
  }

  it("the defaults: 3,000 uncached input tokens, 500 / 500 / 1,200 output", () => {
    expect(DEFAULT_ANSWER_TOKENS).toEqual({
      quick: { input: 3000, output: 500, cacheRead: 0, cacheWrite: 0 },
      balanced: { input: 3000, output: 500, cacheRead: 0, cacheWrite: 0 },
      deep: { input: 3000, output: 1200, cacheRead: 0, cacheWrite: 0 },
    });
    // Quick 0.0003 + 0.00025 USD, Balanced 0.006 + 0.005, Deep 0.024 + 0.048; times 0.92.
    expect(each("quick")).toBeCloseTo(0.00055 * USD_TO_EUR, 12);
    expect(each("balanced")).toBeCloseTo(0.011 * USD_TO_EUR, 12);
    expect(each("deep")).toBeCloseTo(0.072 * USD_TO_EUR, 12);
  });

  it("before she has any answers: the defaults, the reset date, and what is left", async () => {
    const { user } = await ensureSessionFor(t.db, undefined);
    const m = await tutorMeter(user.id, { ...KEY }, NOW, t.db);
    expect(m).toMatchObject({ usedEur: 0, budgetEur: 150, fraction: 0, resetsOn: "2026-12-01", paidAvailable: true });
    // A fresh month with 150 EUR: these are the figures the popover rounds.
    expect(m.levels).toEqual({
      quick: { answersLeft: 296_442, basis: "default" },
      balanced: { answersLeft: 14_822, basis: "default" },
      deep: { answersLeft: 2_264, basis: "default" },
    });
    // The last day of November in Helsinki is still November; 22:00 UTC is 1 December there.
    expect((await tutorMeter(user.id, KEY, new Date("2026-11-30T21:59:00Z"), t.db)).resetsOn).toBe("2026-12-01");
    expect((await tutorMeter(user.id, KEY, new Date("2026-11-30T22:00:01Z"), t.db)).resetsOn).toBe("2027-01-01");
  });

  it("two tiny answers do not move the estimate: still the default figures (the 490,000 Quick answers fault)", async () => {
    const { user } = await ensureSessionFor(t.db, undefined);
    await answers(user.id, "anthropic:claude-haiku-5-5", 2, { in: 40, out: 12 });
    await answers(user.id, "anthropic:claude-sonnet-5-5", 2, { in: 40, out: 12 });
    await answers(user.id, "anthropic:claude-fable-5-2", 2, { in: 40, out: 12 });
    const m = await tutorMeter(user.id, KEY, NOW, t.db);
    const left = 150 - m.usedEur;
    expect(m.usedEur).toBeGreaterThan(0);
    for (const level of ["quick", "balanced", "deep"] as const) {
      expect(m.levels[level]).toEqual({ answersLeft: Math.floor(left / each(level)), basis: "default" });
    }
    // 29 is still too few.
    await answers(user.id, "anthropic:claude-sonnet-5-5", 27, { in: 40, out: 12 });
    expect((await tutorMeter(user.id, KEY, NOW, t.db)).levels.balanced.basis).toBe("default");
  });

  it("from 30 answers at a level: blends toward her own cost, weight n / (n + 30)", async () => {
    const { user: her } = await ensureSessionFor(t.db, undefined);
    const { user: other } = await ensureSessionFor(t.db, undefined);
    // 40 Balanced answers of 6,000 in and 1,000 out: 0.012 + 0.01 = 0.022 USD each, twice the default.
    await answers(her.id, "anthropic:claude-sonnet-5-5", 40, { in: 6000, out: 1000 });
    // Someone else's Deep answers count for the bar, not for her levels.
    await answers(other.id, "anthropic:claude-fable-5-2", 50, { in: 6000, out: 1000 });
    const m = await tutorMeter(her.id, { ...KEY, TUTOR_BUDGET_EUR: "50" }, NOW, t.db);
    const used = (40 * 0.022 + 50 * (0.048 + 0.04)) * USD_TO_EUR;
    expect(m.usedEur).toBeCloseTo(used, 6);
    expect(m.fraction).toBeCloseTo(used / 50, 6);
    const w = 40 / 70;
    const blended = w * 0.022 * USD_TO_EUR + (1 - w) * each("balanced");
    expect(m.levels.balanced).toEqual({ answersLeft: Math.floor((50 - used) / blended), basis: "own" });
    expect(m.levels.balanced.answersLeft).toBeLessThan(Math.floor((50 - used) / each("balanced")));
    expect(m.levels.deep).toEqual({ answersLeft: Math.floor((50 - used) / each("deep")), basis: "default" });
  });

  it("very short answers can never promise more than twice the default-based figure", async () => {
    const { user } = await ensureSessionFor(t.db, undefined);
    // 100 Quick answers of 10 output tokens: the blend alone would say about 1.2 million.
    await answers(user.id, "anthropic:claude-haiku-5-5", 100, { out: 10 });
    const m = await tutorMeter(user.id, KEY, NOW, t.db);
    const left = 150 - m.usedEur;
    const baseline = Math.floor(left / each("quick"));
    const w = 100 / 130;
    const blended = Math.floor(left / (w * costEur("anthropic:claude-haiku-5-5", { input: 0, output: 10, cacheRead: 0, cacheWrite: 0 }) + (1 - w) * each("quick")));
    expect(blended).toBeGreaterThan(2 * baseline);
    expect(m.levels.quick).toEqual({ answersLeft: 2 * baseline, basis: "own" });
  });

  it("answersLeftFor: the rule on its own", () => {
    expect(answersLeftFor(100, 1, null)).toEqual({ answersLeft: 100, basis: "default" });
    expect(answersLeftFor(100, 1, { n: 29, each: 0.01 })).toEqual({ answersLeft: 100, basis: "default" });
    // 30 answers: w = 0.5. Own 3: each 2, 50 left. Own 0.5: each 0.75, 133.
    expect(answersLeftFor(100, 1, { n: 30, each: 3 })).toEqual({ answersLeft: 50, basis: "own" });
    expect(answersLeftFor(100, 1, { n: 30, each: 0.5 })).toEqual({ answersLeft: 133, basis: "own" });
    // Own 0: each 0.5, 200 = exactly the ceiling; 300 answers of 0 would say 1,100, capped at 200.
    expect(answersLeftFor(100, 1, { n: 30, each: 0 })).toEqual({ answersLeft: 200, basis: "own" });
    expect(answersLeftFor(100, 1, { n: 300, each: 0 })).toEqual({ answersLeft: 200, basis: "own" });
    expect(answersLeftFor(0, 1, null)).toEqual({ answersLeft: 0, basis: "default" });
    expect(answersLeftFor(100, 0, null).answersLeft).toBe(0);
  });

  it("past the budget, or with no key or a broken budget: nothing left and no paid levels", async () => {
    const { user } = await ensureSessionFor(t.db, undefined);
    await answer(user.id, "anthropic:claude-fable-5-2", new Date("2026-11-10T08:00:00Z"), { out: 3_000_000 });
    const over = await tutorMeter(user.id, { ...KEY, TUTOR_BUDGET_EUR: "100" }, NOW, t.db);
    expect(over).toMatchObject({ fraction: 1, paidAvailable: false });
    expect(over.levels.quick.answersLeft).toBe(0);
    expect((await tutorMeter(user.id, {}, NOW, t.db)).paidAvailable).toBe(false);
    expect(await tutorMeter(user.id, { ...KEY, TUTOR_BUDGET_EUR: "lots" }, NOW, t.db)).toMatchObject({ budgetEur: 0, fraction: 1, paidAvailable: false });
  });
});

describe("the tutor_messages table (migration 0003 on a fresh PGlite)", () => {
  it("exists, checks its value sets, and goes with the note it sits under", async () => {
    const { user } = await ensureSessionFor(t.db, undefined);
    await expect(
      t.db.execute(sql`insert into tutor_messages (user_id, anchor_kind, role, body) values (${user.id}, 'assignment', 'user', 'x')`),
    ).rejects.toThrow();
    await expect(
      t.db.execute(sql`insert into tutor_messages (user_id, anchor_kind, role, body) values (${user.id}, 'general', 'system', 'x')`),
    ).rejects.toThrow();
    const [note] = await t.db.insert(notes).values({ userId: user.id, body: "n" }).returning();
    await t.db.insert(tutorMessages).values({ userId: user.id, noteId: note.id, anchorKind: "general", role: "user", body: "q" });
    await t.db.insert(tutorMessages).values({ userId: user.id, anchorKind: "general", role: "user", body: "kept" });
    await t.db.delete(notes).where(eq(notes.id, note.id));
    expect((await t.db.select().from(tutorMessages)).map((r) => r.body)).toEqual(["kept"]);
  });
});
