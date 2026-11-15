/*
 * M2-28: what the tutor's Claude path costs this month, and whether there is budget left.
 *
 *   if (await claudeAllowed()) ai.streamChat({ ..., paid: "tutor" });   // else the free models only
 *   const line = await tutorBudgetLine();   // "Tutor this month: about 12 EUR of 150"
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
import { and, eq, gte, like, sum } from "drizzle-orm";
import { db as defaultDb, type Db } from "@/server/db/client";
import { tutorMessages } from "@/server/db/schema/learn";

/*
 * The tutor's Claude models and their prices, USD per million tokens.
 * Checked 2026-11-15 in the claude-api skill (model table "cached 2026-11-03", Claude Haiku 5.5
 * and Claude Fable 5.2 migration notes, prompt-caching economics), which points at
 * https://platform.claude.com/docs/en/about-claude/pricing for the live figures.
 * - claude-haiku-5-5 (the current small Claude, everyday answers): $0.10 in / $0.50 out for
 *   prompts of 100K tokens or fewer (the tutor's are a few thousand); cache reads 0.1x the input
 *   rate, 5-minute cache writes 1.25x.
 * - claude-fable-5-2 ("Go deeper" only): $8 in / $40 out, cache reads $0.20, 5-minute cache
 *   writes 1.25x ($10). A server-side refusal fallback answers in the same call and is counted
 *   here at these (higher) rates.
 * Re-check both before relying on the euro line; a price change is a one-line edit here.
 */
export const TUTOR_CLAUDE = {
  small: {
    id: "claude-haiku-5-5",
    /** Everyday answers are capped here (output tokens). */
    maxTokens: 500,
    usdPerMTok: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  },
  deep: {
    id: "claude-fable-5-2",
    /** "Go deeper" answers are capped here (output tokens). */
    maxTokens: 1200,
    usdPerMTok: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  },
} as const;

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
