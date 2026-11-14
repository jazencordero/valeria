/**
 * The mastery ladder, the exam phases and the focus concept.
 *
 * Pure: no clock, no storage. Copy and numbers are the prototype's
 * (main-flow.html: RUNG_NAMES / RUNG_DESC / RUNG_T, PHASES / phaseIdx /
 * phasePos, focusConcept). Thresholds are not tuned.
 */
import { recallAt, type MemoryState } from "./memory";

export type Rung = {
  /** 1..5 */
  level: 1 | 2 | 3 | 4 | 5;
  name: string;
  /** One-line description of what she does on this rung. */
  description: string;
  /** Mastery (0..1) needed to reach this rung. */
  threshold: number;
};

/** The five rungs, lowest first. Below the first threshold is rung 0. */
export const RUNGS: readonly Rung[] = [
  { level: 1, name: "Recognise", description: "Pick it out of four", threshold: 0.3 },
  { level: 2, name: "Fill the gap", description: "Type the missing words", threshold: 0.45 },
  { level: 3, name: "Recall", description: "Say it before you flip", threshold: 0.6 },
  { level: 4, name: "Explain it", description: "In your own words", threshold: 0.75 },
  { level: 5, name: "Exam-ready", description: "Exam-style questions", threshold: 0.9 },
];

/** Name shown for rung 0. */
export const NOT_STARTED = "Not started";

export type RungLevel = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Rung 0..5 for a mastery value. A value exactly at a threshold reaches that
 * rung (prototype: `m >= t - 1e-9`, the epsilon absorbs float noise such as
 * 0.1 + 0.2).
 */
export function rungOf(mastery: number): RungLevel {
  let r = 0;
  for (const rung of RUNGS) if (mastery >= rung.threshold - 1e-9) r++;
  return r as RungLevel;
}

/** Name of a rung level, including 0 ("Not started"). */
export function rungName(level: RungLevel): string {
  return level === 0 ? NOT_STARTED : RUNGS[level - 1].name;
}

export type Phase = {
  index: 0 | 1 | 2 | 3;
  name: string;
  /** Share of the phase bar, in percent (all four add to 100). */
  width: number;
  description: string;
};

export const PHASES: readonly Phase[] = [
  { index: 0, name: "Learn", width: 38, description: "New concepts, first rungs of the ladder." },
  { index: 1, name: "Strengthen", width: 34, description: "More reviews and exam-style questions." },
  { index: 2, name: "Final review", width: 20, description: "Your weakest concepts and a mock exam." },
  { index: 3, name: "Exam day", width: 8, description: "A 10-card warm-up. Nothing new." },
];

function phaseIndex(daysLeft: number): Phase["index"] {
  return daysLeft > 10 ? 0 : daysLeft >= 4 ? 1 : daysLeft >= 1 ? 2 : 3;
}

/**
 * Phase for the days left until the exam: Learn (over 10), Strengthen (4 to 10),
 * Final review (1 to 3), Exam day (0).
 * Anything below 1, including negative values (exam already past), is
 * Exam day, as in the prototype's phaseIdx. Fractions fall where the
 * comparisons put them (10.5 is Learn, 3.5 is Final review, 0.5 is Exam day).
 */
export function phaseOf(daysLeft: number): Phase {
  return PHASES[phaseIndex(daysLeft)];
}

/**
 * Where the "you are here" marker sits on the phase bar, 0..100 (percent of
 * the bar's width). Prototype phasePos: the phase's start plus its width times
 * a fraction clamped to 0.1..0.9, so the marker never touches a phase edge.
 * Learn counts down from 24 days over 14 days; Strengthen from 10 over 7;
 * Final review from 3 over 3; Exam day sits in the middle of its segment.
 */
export function phasePosition(daysLeft: number): number {
  const i = phaseIndex(daysLeft);
  let start = 0;
  for (let k = 0; k < i; k++) start += PHASES[k].width;
  const frac =
    i === 0
      ? (24 - daysLeft) / 14
      : i === 1
        ? (10 - daysLeft) / 7
        : i === 2
          ? (3 - daysLeft) / 3
          : 0.5;
  return start + PHASES[i].width * Math.max(0.1, Math.min(0.9, frac));
}

/** The minimum a concept needs for focusConcept. */
export type WeightedConcept = {
  /** How much the concept counts on the exam (any non-negative scale). */
  weight: number;
  /** 0..1 */
  mastery: number;
};

/**
 * The concept to study next: largest `weight * (1 - mastery)`.
 * Ties go to the earliest in the list (strict `>`, as in the prototype), so the
 * caller's order decides. Null for an empty list.
 */
export function focusConcept<T extends WeightedConcept>(
  concepts: readonly T[],
): T | null {
  let best: T | null = null;
  let score = -Infinity;
  for (const c of concepts) {
    const v = c.weight * (1 - c.mastery);
    if (v > score) {
      score = v;
      best = c;
    }
  }
  return best;
}

/**
 * One card of a concept for conceptMastery. `active` is false for a card she
 * has suspended or removed from the deck; those do not count toward mastery.
 * The caller decides which cards are active.
 */
export type ConceptCard = {
  state: MemoryState;
  active: boolean;
};

/**
 * Mastery of one concept: the mean predicted recall on exam day over its
 * active cards. 0 when it has no active cards. A never-graded active card
 * counts as 0 (recallAt), so unseen material pulls mastery down.
 */
export function conceptMastery(
  cards: readonly ConceptCard[],
  examAt: Date,
): number {
  let sum = 0;
  let n = 0;
  for (const c of cards) {
    if (!c.active) continue;
    sum += recallAt(c.state, examAt);
    n++;
  }
  return n === 0 ? 0 : sum / n;
}
