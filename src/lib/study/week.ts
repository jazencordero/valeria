/**
 * Study days: the weekly goal (context/study-loop.md, "Study days, not a
 * daily streak").
 *
 * Pure: the current time is passed in as `now`. Weeks run Monday 00:00 to
 * Sunday 23:59 Helsinki time, via `startOfWeek` / `daysBetween` in
 * `../dates`, so daylight saving is handled there.
 *
 * Choices:
 * - `reviewDays` are instants she reviewed on, in any form `dates.ts` takes.
 *   Several on one day count once. Instants after `now` and invalid dates are
 *   ignored (she cannot have studied in the future).
 * - Goal is whole days, clamped to 1..7. Default 4 (the Cut: fixed at 4 of 7
 *   until a settings control exists).
 * - Day dots, Monday first. `state` is one of:
 *   - `done`: she reviewed that day. Today counts as `done` once she has,
 *     with `isToday` still true so the ring can be drawn around it
 *     (prototype: classes `on` and `today` together).
 *   - `today`: today, not yet reviewed.
 *   - `future`: later this week (dashed dot).
 *   - `missed`: an earlier day this week without a review. The prototype
 *     draws it as a plain empty dot (no class); the name is ours.
 * - Sentence (prototype `weekHTML`, exact): under the goal
 *   "{n} of {goal} days this week. {k} more to go." or, one short,
 *   "{n} of {goal} days this week. One more makes the week."; at or above it
 *   "Goal met. {n} of {goal} days this week." Over the goal keeps the real
 *   count ("Goal met. 5 of 4 days this week.").
 * - Free skip: one missed day a week is forgiven automatically, so a past
 *   week is kept with `goal - 1` days (never fewer than 1: an empty week is
 *   never kept, even with goal 1).
 * - `weeksInARow`: consecutive kept weeks counted back from last week. The
 *   current week adds 1 only once its goal is fully met (prototype:
 *   `streak + (met ? 1 : 0)`); until then it neither adds nor breaks.
 * - `freeSkipsLeft` (this week): 1 while the full goal is still reachable
 *   with the days left (today counts as left until she has reviewed), or once
 *   it is met; 0 once the week can only be kept by using the skip (or cannot
 *   be kept at all). Label "1 FREE SKIP LEFT" is the prototype's; the 0 case
 *   has no prototype copy, so "FREE SKIP USED" is ours.
 * - No weeks in a row yet: the streak line is left out (`streakLine` gives
 *   ""), not "0 WEEKS IN A ROW".
 * - With an exam in sight (`goalFor`): from 14 days before the exam to the day
 *   before it, the week's goal is every day until the exam, because the plan
 *   asks for bites every day. That is the days she has studied this week plus
 *   every day still open this week (today, if she has not studied yet, to
 *   Sunday or the day before the exam, whichever comes first). Days already
 *   missed are not held against her. Otherwise the usual goal. Weeks in a
 *   row and the free skip keep the usual goal either way.
 */
import { daysBetween, startOfWeek, type DateInput } from "../dates";

export const DEFAULT_GOAL = 4;
export const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"] as const;

export type DayState = "done" | "today" | "future" | "missed";

export type DayDot = {
  /** One-letter weekday, Monday first. */
  label: (typeof DAY_LABELS)[number];
  state: DayState;
  isToday: boolean;
};

export type Week = {
  days: DayDot[];
  /** Distinct days reviewed this week, up to and including today. */
  count: number;
  goal: number;
  met: boolean;
  sentence: string;
};

function clampGoal(goal: number): number {
  if (!Number.isFinite(goal)) return DEFAULT_GOAL;
  return Math.min(7, Math.max(1, Math.round(goal)));
}

function toMs(input: DateInput): number {
  return (input instanceof Date ? input : new Date(input)).getTime();
}

/**
 * Distinct review days as Helsinki day offsets from this week's Monday
 * (0..6 this week, negative earlier). Future instants are dropped.
 */
function dayOffsets(reviewDays: readonly DateInput[], now: DateInput): Set<number> {
  const monday = startOfWeek(now);
  const nowMs = toMs(now);
  const out = new Set<number>();
  for (const r of reviewDays) {
    const ms = toMs(r);
    if (!Number.isFinite(ms) || ms > nowMs) continue;
    out.add(daysBetween(monday, ms));
  }
  return out;
}

/** Distinct review days per week: key 0 is this week, -1 last week, ... */
function countsByWeek(offsets: Set<number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const d of offsets) {
    const w = Math.floor(d / 7);
    out.set(w, (out.get(w) ?? 0) + 1);
  }
  return out;
}

/** From this many days before an exam, the week's goal is every day until the exam. */
export const EVERY_DAY_WITHIN = 14;

/**
 * The week's goal for `weekOf`: every day until the exam while one is 1 to 14
 * days away (see the header), else `fallback`.
 */
export function goalFor(
  reviewDays: readonly DateInput[],
  examAt: DateInput | null | undefined,
  now: DateInput,
  fallback: number = DEFAULT_GOAL,
): number {
  if (examAt == null) return fallback;
  const daysToExam = daysBetween(now, examAt);
  if (daysToExam < 1 || daysToExam > EVERY_DAY_WITHIN) return fallback;
  const today = daysBetween(startOfWeek(now), now);
  const offsets = dayOffsets(reviewDays, now);
  let done = 0;
  for (let i = 0; i <= today; i++) if (offsets.has(i)) done++;
  // The last day that counts: Sunday, or the day before the exam.
  const last = Math.min(6, today + daysToExam - 1);
  const open = last - today + (offsets.has(today) ? 0 : 1);
  return clampGoal(done + open);
}

/** A finished week counts toward the streak, using the free skip if needed. */
function kept(count: number, goal: number): boolean {
  return count >= Math.max(1, goal - 1);
}

export function weekSentence(count: number, goal: number): string {
  if (count >= goal) return `Goal met. ${count} of ${goal} days this week.`;
  const left = goal - count;
  const tail = left === 1 ? "One more makes the week." : `${left} more to go.`;
  return `${count} of ${goal} days this week. ${tail}`;
}

/** This week's seven dots, count, whether the goal is met, and the sentence. */
export function weekOf(
  reviewDays: readonly DateInput[],
  goal: number = DEFAULT_GOAL,
  now: DateInput,
): Week {
  const g = clampGoal(goal);
  const offsets = dayOffsets(reviewDays, now);
  const today = daysBetween(startOfWeek(now), now);
  const days = DAY_LABELS.map((label, i): DayDot => {
    const isToday = i === today;
    let state: DayState;
    if (offsets.has(i)) state = "done";
    else if (isToday) state = "today";
    else if (i > today) state = "future";
    else state = "missed";
    return { label, state, isToday };
  });
  const count = days.filter((d) => d.state === "done").length;
  const met = count >= g;
  return { days, count, goal: g, met, sentence: weekSentence(count, g) };
}

/**
 * Consecutive weeks that kept the goal: past weeks back from last week (one
 * free skip each), plus this week once it is fully met.
 */
export function weeksInARow(
  reviewDays: readonly DateInput[],
  goal: number = DEFAULT_GOAL,
  now: DateInput,
): number {
  const g = clampGoal(goal);
  const byWeek = countsByWeek(dayOffsets(reviewDays, now));
  let streak = 0;
  for (let w = -1; kept(byWeek.get(w) ?? 0, g); w--) streak++;
  if ((byWeek.get(0) ?? 0) >= g) streak++;
  return streak;
}

/** This week's free skip: 1 while unused, 0 once the week needs it. */
export function freeSkipsLeft(
  reviewDays: readonly DateInput[],
  goal: number = DEFAULT_GOAL,
  now: DateInput,
): 0 | 1 {
  const { days, count, goal: g } = weekOf(reviewDays, goal, now);
  const open = days.filter((d) => d.state === "today" || d.state === "future").length;
  return count + open >= g ? 1 : 0;
}

export function freeSkipLabel(left: number): string {
  return left > 0 ? `${left} FREE SKIP LEFT` : "FREE SKIP USED";
}

/** The line under the sentence: "3 WEEKS IN A ROW · 1 FREE SKIP LEFT". Empty with no week in a row yet. */
export function streakLine(weeks: number, skipsLeft: number): string {
  if (weeks <= 0) return "";
  const w = weeks === 1 ? "1 WEEK IN A ROW" : `${weeks} WEEKS IN A ROW`;
  return `${w} · ${freeSkipLabel(skipsLeft)}`;
}
