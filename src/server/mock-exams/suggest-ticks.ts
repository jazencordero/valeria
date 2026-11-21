/*
 * "Check my answer" for a mock exam part: the ticks the tutor suggests for her answer.
 *
 *   const r = await suggestTicksForPart(userId, courseId, part, answer, { level, stem });
 *   if (r.status === "ok") { r.ticks; r.missing; r.model }   // else the button says it is not available
 *
 * Result: `{ status: "ok", ticks, missing, model }` or `{ status: "unavailable" }`.
 * - `ticks`: indexes into `part.ticks` her answer really earns (sorted, no repeats, never one
 *   outside the list). `missing`: exactly two plain lines, what was missing (or, when nothing
 *   was, what was good), in the language she wrote in. `model`: "provider:model", or "none" when
 *   no AI was asked (an empty answer).
 * - These are SUGGESTIONS. Her own ticks always win: keeping, overriding and saving them is the
 *   caller's job (src/server/mock-exams/index.ts). Nothing is stored here except the usage row.
 *
 * Only when allowed, checked here, in this order, each without any AI call:
 *   1. The tutor is switched on for her account (`tutorEnabled(users.settings)`).
 *   2. The course is hers, its study rule is 'allowed' and her files switch is on
 *      (`mayUseFiles`, src/server/ai/consent.ts): the model answer and ticks are course material.
 *      A course that is not hers, a study rule 'unknown' or 'not_allowed', or her switch off:
 *      `unavailable`.
 *   3. An empty or whitespace answer: `ok` with no ticks and the two EMPTY_LINES, model "none".
 *   4. Abuse guard: 30 tutor calls a minute (the tutor chat's guard, shared: both count the
 *      `ai_calls` rows of job "tutor") and 1,800 AI calls an hour (the tutor route's aiRoute cap).
 *      Over either: `unavailable`. A caller route may add aiRoute on top; it need not.
 * Then src/server/ai/jobs/check-answer.ts asks the model through the tutor's chain (Claude on
 * her level, Quick by default, while the key is set and the budget lasts; the free models
 * otherwise) and records the tokens in her usage meter without showing up in any chat. Any AI
 * trouble is `unavailable`; nothing is thrown for it.
 *
 * Nothing here logs her answer, the model answer or a key.
 */
import { and, count, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { mayUseFiles } from "@/server/ai/consent";
import { checkAnswer, type CheckPart, type CheckResult, type CheckSeams } from "@/server/ai/jobs/check-answer";
import { db as defaultDb, type Db } from "@/server/db/client";
import { aiCalls } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import type { TutorLevel } from "@/server/tutor/budget";
import { tutorEnabled } from "@/server/tutor/context";

export type SuggestPart = CheckPart;
export type SuggestResult = CheckResult;

export type SuggestOptions = {
  level?: TutorLevel;
  /** The question's shared text, when the part belongs to a question with a stem. */
  stem?: string;
  db?: Db;
  /** Test seams for the AI call (router deps without providers, `paidAllowed`). */
  ai?: Omit<CheckSeams, "database">;
  now?: () => Date;
};

/** The two lines for an empty answer (no AI call). */
export const EMPTY_LINES = [
  "There is no answer here yet, so there is nothing to tick.",
  "Write what you know, even a first step, then check it again.",
] as const;

export const PER_MINUTE = 30;
export const PER_HOUR = 1800;

const UNAVAILABLE: SuggestResult = { status: "unavailable" };

async function overGuard(userId: string, now: Date, database: Db): Promise<boolean> {
  const minute = new Date(now.getTime() - 60_000);
  const hour = new Date(now.getTime() - 3_600_000);
  const [m] = await database
    .select({ n: count() })
    .from(aiCalls)
    .where(and(eq(aiCalls.userId, userId), eq(aiCalls.job, "tutor"), gt(aiCalls.createdAt, minute)));
  if ((m?.n ?? 0) >= PER_MINUTE) return true;
  const [h] = await database
    .select({ n: count() })
    .from(aiCalls)
    .where(and(eq(aiCalls.userId, userId), gt(aiCalls.createdAt, hour)));
  return (h?.n ?? 0) >= PER_HOUR;
}

export async function suggestTicksForPart(
  userId: string,
  courseId: string,
  part: SuggestPart,
  answer: string,
  opts: SuggestOptions = {},
): Promise<SuggestResult> {
  const database = opts.db ?? defaultDb;
  if (!z.uuid().safeParse(userId).success || !z.uuid().safeParse(courseId).success) return UNAVAILABLE;

  const [user] = await database.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !tutorEnabled(user.settings)) return UNAVAILABLE;
  if (!(await mayUseFiles(userId, courseId, database))) return UNAVAILABLE;

  if (!answer.trim()) return { status: "ok", ticks: [], missing: [...EMPTY_LINES], model: "none" };

  const now = opts.now?.() ?? new Date();
  if (await overGuard(userId, now, database)) return UNAVAILABLE;

  return checkAnswer(
    { userId, part, answer, stem: opts.stem, level: opts.level },
    { ...opts.ai, database },
  );
}
