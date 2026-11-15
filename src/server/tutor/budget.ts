/*
 * M2-28: what the tutor's Claude path costs this month, and whether there is budget left.
 *
 *   if (await claudeAllowed()) ai.streamChat({ ..., paid: "tutor" });   // else the free models only
 *   const line = await tutorBudgetLine();   // "Tutor this month: about 12 EUR of 150"
 *   const meter = await tutorMeter(userId);  // the chat's usage chip and its popover
 *
 * - Spend is the sum of `tutor_messages` answers whose model starts with "anthropic:", for ALL
 *   users (one key, one bill), from the start of the calendar month in Europe/Helsinki (where
 *   Ready's students are; the month turns at local midnight on the 1st, 22:00 or 21:00 UTC the
 *   day before), priced with `TUTOR_CLAUDE` below and converted at `USD_TO_EUR`.
 * - The budget is `TUTOR_BUDGET_EUR` (default 150). A value that is not a plain non-negative
 *   number fails closed: the budget is 0, so the tutor uses the free models until it is fixed.
 * - Past the budget, `claudeAllowed` is false until the next month: the route then sends no
 *   `paid`, so nothing calls Anthropic. A single answer may go a little past it; that is fine.
 * - A chat she deletes with its note takes its token counts with it, so the sum can drop a
 *   little below what was billed. Answers whose stream broke part-way were never stored.
 *
 * No AI SDK and no router in here (tests/arch/ai-boundary.test.ts); the router imports the
 * model ids and caps from here, so the ids and their prices sit in one block.
 */
import { and, count, eq, gte, like, sum } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { tutorMessages } from "@/server/db/schema/learn";

/*
 * The tutor's Claude models and their prices, USD per million tokens.
 * Checked 2026-11-15 in the claude-api skill (model table "cached 2026-11-03", the Claude Haiku
 * 5.5, Claude Sonnet 5.5 and Claude Fable 5.2 migration notes, prompt-caching economics), which
 * points at https://platform.claude.com/docs/en/about-claude/pricing for the live figures.
 * - claude-haiku-5-5 (the current small Claude, "Quick", the default): $0.10 in / $0.50 out for
 *   prompts of 100K tokens or fewer (the tutor's are a few thousand); cache reads 0.1x the input
 *   rate, 5-minute cache writes 1.25x.
 * - claude-sonnet-5-5 (the current middle Claude, "Balanced"): $2 in / $10 out, cache reads
 *   $0.10 (half Claude Sonnet 5's rate), 5-minute cache writes $2.50. A server-side refusal
 *   fallback (to Claude Sonnet 5, same $2 / $10) answers in the same call and is counted here.
 * - claude-fable-5-2 (the large Claude, "Deep" and "Go deeper"): $8 in / $40 out, cache reads
 *   $0.20, 5-minute cache writes 1.25x ($10). A server-side refusal fallback answers in the
 *   same call and is counted here at these (higher) rates.
 * Re-check all three before relying on the euro line; a price change is a one-line edit here.
 *
 * Answer caps (output tokens, thinking included where the model thinks): Quick 500, Balanced
 * 800, Deep 1,200 (Jazen, 2026-11-15). The keys `small` / `balanced` / `deep` are the models;
 * `TUTOR_LEVELS` below maps the picker's levels onto them.
 */
export const TUTOR_CLAUDE = {
  small: {
    id: "claude-haiku-5-5",
    /** Quick answers are capped here (output tokens). */
    maxTokens: 500,
    usdPerMTok: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  },
  balanced: {
    id: "claude-sonnet-5-5",
    /** Balanced answers are capped here (output tokens). */
    maxTokens: 800,
    usdPerMTok: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  },
  deep: {
    id: "claude-fable-5-2",
    /** Deep and "Go deeper" answers are capped here (output tokens). */
    maxTokens: 1200,
    usdPerMTok: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  },
} as const;

/**
 * The picker's three levels (her explicit choice; the client never sends a model id). The
 * server maps a level to a model here; "Go deeper" is a one-shot "deep".
 */
export const TUTOR_LEVELS = ["quick", "balanced", "deep"] as const;
export type TutorLevel = (typeof TUTOR_LEVELS)[number];
export const LEVEL_MODEL: Record<TutorLevel, (typeof TUTOR_CLAUDE)[keyof typeof TUTOR_CLAUDE]> = {
  quick: TUTOR_CLAUDE.small,
  balanced: TUTOR_CLAUDE.balanced,
  deep: TUTOR_CLAUDE.deep,
};

/**
 * The picker's cost marks: 1 + round(log2(price ratio to Quick) / 2) dots, the ratio taken on
 * the output price (the input prices have the same ratio, 1 : 20 : 80). Quick 1, Balanced 3
 * (20x), Deep 4 (80x). The chat draws the same numbers (src/components/tutor/tutor-chat.tsx,
 * `LEVEL_CHOICES`), tested equal on both sides.
 */
export function costDots(level: TutorLevel): number {
  const ratio = LEVEL_MODEL[level].usdPerMTok.output / TUTOR_CLAUDE.small.usdPerMTok.output;
  return 1 + Math.round(Math.log2(ratio) / 2);
}

/** Prices checked on this date (see the block above). */
export const PRICES_CHECKED = "2026-11-15";

/**
 * Fixed planning rate, USD to EUR, chosen 2026-11-15. Not a live quote: the euro line is an
 * estimate ("about"), and a fixed rate keeps it stable. Change it here if the rate moves a lot.
 */
export const USD_TO_EUR = 0.92;

export const DEFAULT_BUDGET_EUR = 150;
export const BUDGET_ENV = "TUTOR_BUDGET_EUR";
export const TUTOR_TIME_ZONE = "Europe/Helsinki";

/** "anthropic:<id>" as stored in `tutor_messages.model`. */
export const ANTHROPIC_PREFIX = "anthropic:";

export type TokenUse = { input: number; output: number; cacheRead: number; cacheWrite: number };

type Env = Record<string, string | undefined>;

/** `TUTOR_BUDGET_EUR` as a number: the default when unset, 0 when it is not a plain number >= 0. */
export function budgetEur(env: Env = process.env): number {
  const raw = env[BUDGET_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_BUDGET_EUR;
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return 0;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** USD per token for a stored model ("anthropic:claude-haiku-5-5"), or null for a free one. */
function pricesFor(model: string) {
  if (!model.startsWith(ANTHROPIC_PREFIX)) return null;
  const id = model.slice(ANTHROPIC_PREFIX.length);
  for (const m of Object.values(TUTOR_CLAUDE)) if (m.id === id) return m.usdPerMTok;
  // An Anthropic model we do not list (should not happen): price it as the dearest one.
  return TUTOR_CLAUDE.deep.usdPerMTok;
}

/** What `use` on `model` costs in euros; 0 for the free models. */
export function costEur(model: string, use: TokenUse): number {
  const p = pricesFor(model);
  if (!p) return 0;
  const usd =
    (use.input * p.input + use.output * p.output + use.cacheRead * p.cacheRead + use.cacheWrite * p.cacheWrite) / 1_000_000;
  return usd * USD_TO_EUR;
}

/** The offset of `zone` from UTC at `at`, in milliseconds (Helsinki: +2h or +3h). */
function offsetMs(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return local - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant of local midnight on the 1st of `month` (0-11, may overflow) of `year` in `zone`. */
function localMonthStart(year: number, month: number, zone: string): Date {
  const guess = Date.UTC(year, month, 1);
  // Helsinki changes its clocks on the last Sunday of March and October, never on the 1st,
  // so one correction is enough; the second pass covers any zone that does.
  let at = guess - offsetMs(new Date(guess), zone);
  at = guess - offsetMs(new Date(at), zone);
  return new Date(at);
}

/** The month `now` is in, in `zone`: [start, next start). */
export function monthOf(now: Date, zone = TUTOR_TIME_ZONE): { start: Date; end: Date } {
  const local = new Date(now.getTime() + offsetMs(now, zone));
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  return { start: localMonthStart(y, m, zone), end: localMonthStart(y, m + 1, zone) };
}

export type Spend = { eur: number; byModel: { model: string; use: TokenUse; eur: number }[] };

/** All tutor use on the Anthropic path this month, every user, in euros. */
export async function monthSpend(now: Date = new Date(), database: Db = defaultDb): Promise<Spend> {
  const { start } = monthOf(now);
  const rows = await database
    .select({
      model: tutorMessages.model,
      input: sum(tutorMessages.tokensIn),
      output: sum(tutorMessages.tokensOut),
      cacheRead: sum(tutorMessages.cacheReadTokens),
      cacheWrite: sum(tutorMessages.cacheWriteTokens),
    })
    .from(tutorMessages)
    .where(and(gte(tutorMessages.createdAt, start), like(tutorMessages.model, `${ANTHROPIC_PREFIX}%`), eq(tutorMessages.role, "assistant")))
    .groupBy(tutorMessages.model);
  const num = (v: string | null) => (v === null ? 0 : Number(v));
  const byModel = rows.map((r) => {
    const use = { input: num(r.input), output: num(r.output), cacheRead: num(r.cacheRead), cacheWrite: num(r.cacheWrite) };
    const model = r.model ?? "";
    return { model, use, eur: costEur(model, use) };
  });
  return { eur: byModel.reduce((a, b) => a + b.eur, 0), byModel };
}

/** True while this month's spend is under the budget. Does not look at the key. */
export async function budgetLeft(env: Env = process.env, now: Date = new Date(), database: Db = defaultDb): Promise<boolean> {
  const budget = budgetEur(env);
  if (budget <= 0) return false;
  return (await monthSpend(now, database)).eur < budget;
}

/** The key is set and there is budget left: the tutor may ask Claude. */
export async function claudeAllowed(env: Env = process.env, now: Date = new Date(), database: Db = defaultDb): Promise<boolean> {
  if (!env.ANTHROPIC_API_KEY) return false;
  return budgetLeft(env, now, database);
}

/** Settings: "Tutor this month: about N EUR of M". */
export async function tutorBudgetLine(env: Env = process.env, now: Date = new Date(), database: Db = defaultDb): Promise<string> {
  const { eur } = await monthSpend(now, database);
  const budget = budgetEur(env);
  return `Tutor this month: about ${Math.round(eur)} EUR of ${Number.isInteger(budget) ? budget : budget.toFixed(2)}`;
}

/*
 * The chat's usage meter (the chip and its popover).
 *
 * - The bar is ALL users' tutor spend this month against the one budget (`monthSpend`): it is
 *   Jazen's allowance, one key and one bill, so it is the same bar for everyone who sees it.
 * - "What is left at each level" (Jazen, 2026-11-15, after the meter promised 490,000 Quick
 *   answers from two short ones): never extrapolate from a handful of tiny answers.
 *     default   the cost of one `DEFAULT_ANSWER_TOKENS` answer at that level's model, every
 *               input token at the plain (uncached) input price, which is the dearest case.
 *     baseline  floor(left / default), left = max(0, budget - everyone's spend this month).
 *     n < 30    (her answers at that level this month, `BLEND_FROM`): the baseline only.
 *     n >= 30   blend toward her own average cost per answer at that level, `own`:
 *                 w     = n / (n + 30)               (0.5 at 30, 0.77 at 100, 0.91 at 300)
 *                 each  = w * own + (1 - w) * default
 *                 left  = floor(left / each), but never above 2 x baseline (`CEILING_TIMES`).
 *               The default always keeps some weight, and the ceiling stops a run of very short
 *               answers from promising more than twice the conservative figure. Answers longer
 *               than the default lower the figure with no floor.
 *   "Go deeper" answers count as Deep. The popover rounds the figure to two significant
 *   figures and says "roughly" (src/components/tutor/tutor-controls.tsx).
 * - Everything here is an estimate; the popover says so.
 */

/**
 * One answer before she has 30 at a level (chosen 2026-11-15): the context a lecture sends (the
 * rules, the passage, its section, the lecture's key points and the last turns) is about 3,000
 * input tokens, all counted as uncached; the output is the level's cap for Quick (500) and Deep
 * (1,200, its short thinking included), and Balanced is held at 500 like Quick.
 */
export const DEFAULT_ANSWER_TOKENS: Record<TutorLevel, TokenUse> = {
  quick: { input: 3000, output: 500, cacheRead: 0, cacheWrite: 0 },
  balanced: { input: 3000, output: 500, cacheRead: 0, cacheWrite: 0 },
  deep: { input: 3000, output: 1200, cacheRead: 0, cacheWrite: 0 },
};

/** Her answers at a level this month before her own average counts at all. */
export const BLEND_FROM = 30;
/** The answers-left figure is never above this many times the default-based one. */
export const CEILING_TIMES = 2;

/**
 * Answers left at one level: `left` euros, one default answer costing `defaultEach`, and her own
 * `n` answers at that level this month averaging `ownEach` (see the block above).
 */
export function answersLeftFor(left: number, defaultEach: number, own: { n: number; each: number } | null): LevelLeft {
  if (!(left > 0) || !(defaultEach > 0)) return { answersLeft: 0, basis: own && own.n >= BLEND_FROM ? "own" : "default" };
  const baseline = Math.floor(left / defaultEach);
  if (!own || own.n < BLEND_FROM) return { answersLeft: baseline, basis: "default" };
  const w = own.n / (own.n + BLEND_FROM);
  const each = w * Math.max(0, own.each) + (1 - w) * defaultEach;
  return { answersLeft: Math.min(Math.floor(left / each), CEILING_TIMES * baseline), basis: "own" };
}

export type LevelLeft = {
  /** About how many more answers at this level fit in what is left of the budget (`answersLeftFor`). */
  answersLeft: number;
  /** "own": blended with her own answers (30 or more this month); "default": `DEFAULT_ANSWER_TOKENS` only. */
  basis: "own" | "default";
};

export type TutorMeter = {
  usedEur: number;
  budgetEur: number;
  /** usedEur / budgetEur, 0 to 1 (1 when the budget is 0). */
  fraction: number;
  /** The local date (Europe/Helsinki) the month turns, "YYYY-MM-DD". */
  resetsOn: string;
  /** Paid levels can be chosen now: the key is set and there is budget left. */
  paidAvailable: boolean;
  levels: Record<TutorLevel, LevelLeft>;
};

/** The level a stored "anthropic:<id>" answer was on, or null. */
function levelOf(model: string | null): TutorLevel | null {
  if (!model?.startsWith(ANTHROPIC_PREFIX)) return null;
  const id = model.slice(ANTHROPIC_PREFIX.length);
  return TUTOR_LEVELS.find((l) => LEVEL_MODEL[l].id === id) ?? null;
}

/** Her answers this month on the Claude path: per level, how many and the tokens of one average answer. */
export async function ownAverages(
  userId: string,
  now: Date = new Date(),
  database: Db = defaultDb,
): Promise<Partial<Record<TutorLevel, { n: number; use: TokenUse }>>> {
  const { start } = monthOf(now);
  const rows = await database
    .select({
      model: tutorMessages.model,
      n: count(),
      input: sum(tutorMessages.tokensIn),
      output: sum(tutorMessages.tokensOut),
      cacheRead: sum(tutorMessages.cacheReadTokens),
      cacheWrite: sum(tutorMessages.cacheWriteTokens),
    })
    .from(tutorMessages)
    .where(
      and(
        eq(tutorMessages.userId, userId),
        gte(tutorMessages.createdAt, start),
        like(tutorMessages.model, `${ANTHROPIC_PREFIX}%`),
        eq(tutorMessages.role, "assistant"),
      ),
    )
    .groupBy(tutorMessages.model);
  const num = (v: string | null) => (v === null ? 0 : Number(v));
  const totals: Partial<Record<TutorLevel, TokenUse & { n: number }>> = {};
  for (const r of rows) {
    const level = levelOf(r.model);
    if (!level || r.n === 0) continue;
    const t = (totals[level] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, n: 0 });
    t.input += num(r.input);
    t.output += num(r.output);
    t.cacheRead += num(r.cacheRead);
    t.cacheWrite += num(r.cacheWrite);
    t.n += r.n;
  }
  const out: Partial<Record<TutorLevel, { n: number; use: TokenUse }>> = {};
  for (const level of TUTOR_LEVELS) {
    const t = totals[level];
    if (t) out[level] = { n: t.n, use: { input: t.input / t.n, output: t.output / t.n, cacheRead: t.cacheRead / t.n, cacheWrite: t.cacheWrite / t.n } };
  }
  return out;
}

/** "YYYY-MM-DD" of `at` in `zone`. */
function localDate(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The chat's usage meter for `userId`. Reads token counts only; no AI call. */
export async function tutorMeter(
  userId: string,
  env: Env = process.env,
  now: Date = new Date(),
  database: Db = defaultDb,
): Promise<TutorMeter> {
  const budget = budgetEur(env);
  const [{ eur: used }, own] = await Promise.all([monthSpend(now, database), ownAverages(userId, now, database)]);
  const left = Math.max(0, budget - used);
  const levels = {} as Record<TutorLevel, LevelLeft>;
  for (const level of TUTOR_LEVELS) {
    const model = `${ANTHROPIC_PREFIX}${LEVEL_MODEL[level].id}`;
    const mine = own[level];
    levels[level] = answersLeftFor(left, costEur(model, DEFAULT_ANSWER_TOKENS[level]), mine ? { n: mine.n, each: costEur(model, mine.use) } : null);
  }
  return {
    usedEur: used,
    budgetEur: budget,
    fraction: budget > 0 ? Math.min(1, used / budget) : 1,
    resetsOn: localDate(monthOf(now).end, TUTOR_TIME_ZONE),
    paidAvailable: Boolean(env.ANTHROPIC_API_KEY) && budget > 0 && used < budget,
    levels,
  };
}
