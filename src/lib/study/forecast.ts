/**
 * The exam forecast: the share of the exam she would get right today, and the
 * two futures drawn after it (a bite a day, or stop).
 *
 * Pure: no clock, no storage. `forecastNow`, `stopCurve` and `history` are the
 * prototype's formulas (main-flow.html fcRaw / fcOf / fcStopAt).
 *
 * The forecast of a whole deck (`deckForecast`) is the one model every number
 * on screen comes from: the concepts' masteries, weighted (the readiness
 * model is written out at `deckMasteries`: all cards for an unmarked deck,
 * core cards first for a bundle with core marks). The
 * gain of a session (`gainOf`) is that forecast if each of its cards is
 * recalled now, minus the forecast now. Where a plan lands on exam day is a
 * simulation of the same model (`./plan`).
 *
 * `planEnd`, `planCurve` and the three-argument `verdict` are the prototype's
 * rules of thumb (fcPlanEnd / fcPlanAt / verdictExam). No screen of the app
 * reads them any more: they overpromised on a large deck. They remain for the
 * component previews under `src/app/dev`, which have no deck to simulate.
 */
import { gradeStep } from "../grades/scale";
import type { Deck } from "./bite";
import { conceptMastery, type WeightedConcept } from "./ladder";
import { grade, newCard, recallAt, type MemoryState } from "./memory";

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

const time = (t: number | Date) => (typeof t === "number" ? t : t.getTime());

/**
 * Each concept's mastery (0..1) for the given card memories.
 *
 * READINESS MODEL
 * - A deck without core marks (AI-made, demo): a concept's mastery is the
 *   mean predicted recall on exam day over all its active cards (a card
 *   belongs to its `conceptId`; one never graded counts as 0). Unchanged.
 * - A deck with core marks (a hand-made bundle): readiness is measured on
 *   what the bundle calls essential. A concept's mastery is the mean
 *   predicted recall on exam day over its active CORE cards; a core card she
 *   has never graded counts as 0 (not known).
 *   Other cards add on top once core is covered: when every core card of the
 *   concept has been graded at least once, each of the concept's other cards
 *   that she has graded joins that mean. A card she has not met never counts
 *   against her, and none counts before the concept's core cards are all
 *   seen. (A seen extra card she recalls worse than her core cards lowers the
 *   mean a little: it is part of what she now carries.)
 *   A concept with no core card at all is measured as in an unmarked deck.
 * - The forecast is the concepts' masteries weighted by the concept weights
 *   (the bundle's), 0..100.
 * So the core-first pace and the forecast tell one story: seeing and holding
 * the 184 core cards of a 401-card bundle is 100% of what is measured until
 * the extras are opened, not 46%.
 */
export function deckMasteries(
  deck: Deck,
  states: Readonly<Record<string, MemoryState>> = deck.states,
): Record<string, number> {
  const examAt = new Date(time(deck.examAt));
  const blank = newCard(examAt);
  const counted = countedCards(deck, states);
  const out: Record<string, number> = {};
  for (const concept of deck.concepts) {
    out[concept.id] = conceptMastery(
      (counted.get(concept.id) ?? []).map((c) => ({ state: states[c.id] ?? blank, active: true })),
      examAt,
    );
  }
  return out;
}

/** Per concept, the cards its mastery is the mean of (the readiness model above). */
function countedCards(
  deck: Deck,
  states: Readonly<Record<string, MemoryState>>,
): Map<string, Deck["cards"][number][]> {
  const marked = deck.coreMarked ?? deck.cards.some((c) => c.core === true);
  const seen = (id: string) => (states[id]?.lastReviewAt ?? null) !== null;
  const own = new Map<string, Deck["cards"][number][]>();
  for (const c of deck.cards) {
    if (!c.active) continue;
    const list = own.get(c.conceptId);
    if (list) list.push(c);
    else own.set(c.conceptId, [c]);
  }
  const out = new Map<string, Deck["cards"][number][]>();
  for (const concept of deck.concepts) {
    let cards = own.get(concept.id) ?? [];
    const core = marked ? cards.filter((c) => c.core === true) : [];
    if (core.length > 0) {
      const covered = core.every((c) => seen(c.id));
      cards = covered ? cards.filter((c) => c.core === true || seen(c.id)) : core;
    }
    out.set(concept.id, cards);
  }
  return out;
}

/**
 * What reviewing each of the cards `ids` now is worth, in forecast points: the
 * forecast if that one card is recalled now (graded Good at `deck.now`), minus
 * the forecast now. It is `gainOf(deck, [id])` for each card, worked out in
 * one pass: the rise of the card's predicted recall on exam day, over the
 * number of cards its concept's mastery is the mean of, times the concept's
 * share of the weights. A card the model does not count (see the readiness
 * model) is worth 0. For cards she has graded the worths add up: reviewing
 * several is worth their sum.
 */
export function reviewWorth(deck: Deck, ids: readonly string[]): Map<string, number> {
  const examAt = new Date(time(deck.examAt));
  const now = new Date(time(deck.now));
  const counted = countedCards(deck, deck.states);
  const total = deck.concepts.reduce((sum, c) => sum + c.weight, 0);
  const share = new Map<string, number>();
  for (const concept of deck.concepts) {
    const cards = counted.get(concept.id) ?? [];
    for (const c of cards) share.set(c.id, total > 0 ? (100 * concept.weight) / total / cards.length : 0);
  }
  const out = new Map<string, number>();
  for (const id of ids) {
    const per = share.get(id) ?? 0;
    const state = deck.states[id] ?? newCard(now);
    out.set(id, per === 0 ? 0 : per * (recallAt(grade(state, 3, now), examAt) - recallAt(state, examAt)));
  }
  return out;
}

/**
 * A card's other possible memory in a projection: with probability `p` she
 * missed it at a planned review, and `state` is its memory in that case.
 */
export type Doubt = { p: number; state: MemoryState };

/**
 * The forecast a projection expects, 0..100, not rounded: `deckForecast` with
 * each card's predicted recall on exam day replaced by its expected value,
 * `(1 - p) * recall(states[id]) + p * recall(doubt.state)`, for the cards that
 * have a doubt. With no doubts it is `deckForecast(deck, states)`.
 */
export function expectedForecast(
  deck: Deck,
  states: Readonly<Record<string, MemoryState>>,
  doubts: ReadonlyMap<string, Doubt>,
): number {
  const examAt = new Date(time(deck.examAt));
  const counted = countedCards(deck, states);
  let total = 0;
  let sum = 0;
  for (const concept of deck.concepts) {
    total += concept.weight;
    const cards = counted.get(concept.id) ?? [];
    if (cards.length === 0) continue;
    let recall = 0;
    for (const c of cards) {
      const state = states[c.id];
      const sure = state ? recallAt(state, examAt) : 0;
      const doubt = doubts.get(c.id);
      recall += doubt ? (1 - doubt.p) * sure + doubt.p * recallAt(doubt.state, examAt) : sure;
    }
    sum += (concept.weight * recall) / cards.length;
  }
  return total > 0 ? (100 * sum) / total : 0;
}

/** The deck's forecast, 0..100, not rounded, for the given card memories. */
export function deckForecast(deck: Deck, states: Readonly<Record<string, MemoryState>> = deck.states): number {
  const mastery = deckMasteries(deck, states);
  return forecastNow(deck.concepts.map((c) => ({ weight: c.weight, mastery: mastery[c.id] ?? 0 })));
}

/**
 * What a session is worth, in forecast points: the forecast if each of the
 * cards `ids` is recalled now (graded Good at `deck.now`), minus the forecast
 * now. Measured on the deck, so a 400-card deck gives a fraction of a point.
 */
export function gainOf(deck: Deck, ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  const now = new Date(time(deck.now));
  const after: Record<string, MemoryState> = { ...deck.states };
  for (const id of new Set(ids)) after[id] = grade(after[id] ?? newCard(now), 3, now);
  return deckForecast(deck, after) - deckForecast(deck);
}

/** A gain below this is not shown: it would read as "+0%". */
export const GAIN_SHOWN_FROM = 0.5;

/**
 * A gain as screens show it: "+0.5%", "+3.2%", from 10 points a whole number
 * ("+12%"). Null under half a point: the line is left out.
 */
export function gainLabel(gain: number | null | undefined): string | null {
  if (gain == null || !Number.isFinite(gain) || gain < GAIN_SHOWN_FROM) return null;
  return `+${gain < 9.95 ? gain.toFixed(1) : Math.round(gain)}%`;
}

/** The forecast as screens show it: `forecastNow` rounded to a whole percent. */
export function forecastShown(concepts: readonly WeightedConcept[]): number {
  return Math.round(forecastNow(concepts));
}

/**
 * Where a bite a day lands on exam day: `min(94, f + daysLeft * 5.5)`. Once
 * the exam day has passed (`daysLeft` below 0) no days are left, so the result
 * is `f` as on exam day, never below it.
 */
export function planEnd(f: number, daysLeft: number): number {
  return Math.min(PLAN_CAP, f + Math.max(0, daysLeft) * PLAN_GAIN_PER_DAY);
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

export type VerdictKey = "ready" | "on_track" | "reachable" | "not_reachable" | "before_start" | "tight";

export type Verdict = {
  key: VerdictKey;
  text: string;
  /** True only for `ready` and `on_track` (the prototype's `ok`). */
  ok: boolean;
};

export const VERDICTS: Readonly<Record<"ready" | "on_track" | "tight", Verdict>> = {
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
