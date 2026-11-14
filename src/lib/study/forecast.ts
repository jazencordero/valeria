/**
 * The exam forecast: the share of the exam she would get right today, and the
 * two futures drawn after it (a bite a day, or stop).
 *
 * Pure: no clock, no storage. Formulas are the prototype's (main-flow.html
 * fcRaw / fcOf / fcPlanEnd / fcPlanAt / fcStopAt / gradeAt / verdictExam).
 * The two futures are rules of thumb, labelled "about" on screen; there is no
 * simulation behind them.
 */
import { gradeStep } from "../grades/scale";
import type { WeightedConcept } from "./ladder";

/** Best a bite a day can reach by exam day, in percent. */
export const PLAN_CAP = 94;
/** Points a bite a day adds per day left, before the cap. */
export const PLAN_GAIN_PER_DAY = 5.5;
/** Time constant (days) of the plan curve: most of the gain comes early. */
export const PLAN_TAU = 2.4;
/** Share of today's forecast lost per day if she stops. */
export const STOP_DECAY_PER_DAY = 0.035;
/** Days of history the chart shows before today. */
export const HISTORY_DAYS = 13;

/**
 * Forecast today, 0..100, not rounded: `100 * sum(weight * mastery) /
 * sum(weight)`. 0 for no concepts or a total weight of 0. The chart draws
 * this raw value; screens show `forecastShown`.
 */
export function forecastNow(concepts: readonly WeightedConcept[]): number {
  let sw = 0;
  let s = 0;
  for (const c of concepts) {
    sw += c.weight;
    s += c.weight * c.mastery;
  }
  return sw > 0 ? (100 * s) / sw : 0;
}

/** The forecast as screens show it: `forecastNow` rounded to a whole percent. */
export function forecastShown(concepts: readonly WeightedConcept[]): number {
  return Math.round(forecastNow(concepts));
}

/** Where a bite a day lands on exam day: `min(94, f + daysLeft * 5.5)`. */
export function planEnd(f: number, daysLeft: number): number {
  return Math.min(PLAN_CAP, f + daysLeft * PLAN_GAIN_PER_DAY);
}

/**
 * Forecast with a bite a day, one point per day from today (index 0, = f) to
 * exam day (index daysLeft, = planEnd). Eases out: `f + (end - f) *
 * (1 - e^(-d/2.4)) / (1 - e^(-D/2.4))`. daysLeft is floored; 0 or less
 * gives `[f]`. If f is already above the cap the curve falls to 94, as in the
 * prototype.
 */
export function planCurve(f: number, daysLeft: number): number[] {
  const D = Math.max(0, Math.floor(daysLeft));
  if (D === 0) return [f];
  const end = planEnd(f, D);
  const norm = 1 - Math.exp(-D / PLAN_TAU);
  const out: number[] = [];
  for (let d = 0; d <= D; d++) {
    out.push(f + ((end - f) * (1 - Math.exp(-d / PLAN_TAU))) / norm);
  }
  return out;
}

/**
 * Forecast if she stops, one point per day from today (index 0, = f) to exam
 * day: `f * (1 - 0.035 * d)`, never below 0 (only matters past 28 days).
 * daysLeft is floored; 0 or less gives `[f]`.
 */
export function stopCurve(f: number, daysLeft: number): number[] {
  const D = Math.max(0, Math.floor(daysLeft));
  const out: number[] = [];
  for (let d = 0; d <= D; d++) {
    out.push(Math.max(0, f * (1 - STOP_DECAY_PER_DAY * d)));
  }
  return out;
}

export type VerdictKey = "ready" | "on_track" | "tight";

export type Verdict = {
  key: VerdictKey;
  text: string;
  /** False only for `tight` (the prototype's `ok`). */
  ok: boolean;
};

export const VERDICTS: Readonly<Record<VerdictKey, Verdict>> = {
  ready: { key: "ready", text: "Ready. Keep it warm.", ok: true },
  on_track: { key: "on_track", text: "On track with a bite a day", ok: true },
  tight: { key: "tight", text: "Tight. Two bites a day gets you there.", ok: false },
};

/**
 * Ready when today's forecast already meets the target, on track when a bite a
 * day reaches it by exam day, otherwise tight. Both comparisons are `>=`.
 * The prototype passes the shown (rounded) forecast and `planEnd` of it.
 */
export function verdict(f: number, target: number, planEndPct: number): Verdict {
  if (f >= target) return VERDICTS.ready;
  if (planEndPct >= target) return VERDICTS.on_track;
  return VERDICTS.tight;
}

/** Whole Finnish grade 0..5 for a forecast percentage (floored grade step). */
export function gradeFor(pct: number): 0 | 1 | 2 | 3 | 4 | 5 {
  return gradeStep(pct);
}

/**
 * One stored daily snapshot: each concept's mastery (0..1) at the end of
 * that day. `day` is a calendar day key `YYYY-MM-DD` in the student's time
 * zone; the caller makes the keys.
 */
export type DailySnapshot = {
  day: string;
  mastery: Readonly<Record<string, number>>;
};

/** A concept as history needs it: its id and its exam weight. */
export type HistoryConcept = { id: string; weight: number };

const DAY_MS = 24 * 60 * 60 * 1000;

function dayNumber(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/**
 * The forecast for each of the last 13 days that have data, oldest first,
 * for the chart (today's live forecast is appended by the caller).
 *
 * - The window is the 13 calendar days ending on the latest snapshot's day.
 * - A day with no snapshot repeats the previous day's masteries (nothing was
 *   reviewed). Days before the first snapshot are left out, so a new exam has
 *   a shorter history; the result is never longer than 13.
 * - Each day's value is `forecastNow` over `concepts` (today's weights), with
 *   that day's mastery; a concept missing from a snapshot counts as 0.
 * - Input order does not matter; if two snapshots share a day, the later one
 *   in the list wins. Values are not rounded.
 */
export function history(
  reviewsByDay: readonly DailySnapshot[],
  concepts: readonly HistoryConcept[],
): number[] {
  if (reviewsByDay.length === 0) return [];
  const byDay = new Map<number, DailySnapshot>();
  for (const s of reviewsByDay) byDay.set(dayNumber(s.day), s);
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const first = days[0];
  const last = days[days.length - 1];
  const start = Math.max(first, last - HISTORY_DAYS + 1);

  // The snapshot in force on `start`: the latest one on or before it.
  let current: DailySnapshot | undefined;
  for (const d of days) if (d <= start) current = byDay.get(d);

  const out: number[] = [];
  for (let d = start; d <= last; d++) {
    current = byDay.get(d) ?? current;
    const mastery = current?.mastery ?? {};
    out.push(
      forecastNow(
        concepts.map((c) => ({ weight: c.weight, mastery: mastery[c.id] ?? 0 })),
      ),
    );
  }
  return out;
}
