/**
 * Grade maths for one course and across courses (M6-03).
 *
 * Pure: no I/O, no clock, no randomness. Every formula is the prototype's
 * (context/tickets/prototype/main-flow.html, JS 3631 to 3703, plus the series
 * maths inside chartSVG at 3755-3768), on the one 0..5 scale from
 * `./scale` (`gradeFromPct`: 0 under 50%, then `(p - 40) / 10`, capped at 5).
 *
 * Conventions used throughout:
 * - Scores, fills, what-ifs and "needed" values are percentages 0..100.
 * - Grades (trajectory, swing, best possible, chart points) are on the
 *   continuous 0..5 scale, not rounded. Use `gradeStep` for a whole grade.
 * - A what-if is keyed by item id. It only counts for an ungraded item: a
 *   graded item always uses its real score, as in the prototype.
 * - Weights are fractions of the course grade. If they do not add up to 1
 *   they are scaled so they do (see `normaliseWeights`). If any weight is
 *   missing (null), not a finite number, negative, or they all add up to 0,
 *   the course cannot be computed and every course-level function returns
 *   `NEEDS_WEIGHTS` (the verdict returns `{ kind: "needs_weights" }`), so the
 *   screen can ask for weights instead of showing a wrong number.
 */

import { gradeFromPct, gradeStep } from "./scale";

/** One gradable piece of a course: an assignment, a quiz, the exam. */
export type GradeItem = {
  id: string;
  /** Fraction of the course grade. `null` when the course has not said. */
  weight: number | null;
  /** The real score in percent, or `null` while it is not graded. */
  score: number | null;
};

/** A course as the grades screen needs it. */
export type GradeCourse<T extends GradeItem = GradeItem> = {
  items: T[];
  /** What-if scores by item id; missing means "none set". */
  whatIfs?: WhatIfs;
};

/** What-if scores in percent, keyed by item id. `null` means "not set". */
export type WhatIfs = Readonly<Record<string, number | null | undefined>>;

/** Returned when any weight in the course is missing or unusable. */
export const NEEDS_WEIGHTS = "needs_weights" as const;
export type NeedsWeights = typeof NEEDS_WEIGHTS;

/** An item whose weight is known and normalised. */
type Weighted<T extends GradeItem> = T & { weight: number };

/** Float slack used where the prototype uses it (ties, sums that should be 1). */
const EPS = 1e-9;

/**
 * The items with weights that add up to 1, or `NEEDS_WEIGHTS`.
 *
 * Decisions:
 * - Any `null`, non-finite or negative weight means the course needs weights
 *   (a negative share of a grade has no meaning; silently dropping it would
 *   show a confident wrong number).
 * - Weights adding up to 0 cannot be scaled, so that also needs weights.
 * - Weights within 1e-9 of summing to 1 are left exactly as given, so the
 *   prototype's sample data (0.1 + 0.1 + ... which is not exactly 1 in
 *   floating point) gives the prototype's numbers bit for bit. Otherwise each
 *   weight is divided by the sum, so 10/10/80 means 0.1/0.1/0.8.
 * - Item order is kept; it is the chart's x order.
 */
export function normaliseWeights<T extends GradeItem>(
  items: readonly T[],
): Weighted<T>[] | NeedsWeights {
  let sum = 0;
  for (const it of items) {
    const w = it.weight;
    if (w == null || !Number.isFinite(w) || w < 0) return NEEDS_WEIGHTS;
    sum += w;
  }
  if (!(sum > 0)) return NEEDS_WEIGHTS;
  const scale = Math.abs(sum - 1) <= EPS ? 1 : 1 / sum;
  return items.map((it) => ({ ...it, weight: (it.weight as number) * scale }));
}

// ---------------------------------------------------------------------------
// Internal helpers on already-normalised items (prototype names in brackets).

function soFarN(items: readonly Weighted<GradeItem>[]): number | null {
  let w = 0;
  let ws = 0;
  for (const k of items) {
    if (k.score != null) {
      w += k.weight;
      ws += k.weight * k.score;
    }
  }
  return w > 0 ? ws / w : null;
}

function fillForN(
  item: GradeItem,
  items: readonly Weighted<GradeItem>[],
  whatIfs: WhatIfs,
): number | null {
  const own = whatIfs[item.id];
  if (own != null) return own;
  const sf = soFarN(items);
  if (sf != null) return sf;
  const vals = Object.keys(whatIfs)
    .map((id) => whatIfs[id])
    .filter((v): v is number => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/** [trajectoryPct] Σ w · (score or fill), or null when any fill is missing. */
function trajectoryPctN(
  items: readonly Weighted<GradeItem>[],
  whatIfs: WhatIfs,
): number | null {
  let t = 0;
  for (const k of items) {
    const v = k.score != null ? k.score : fillForN(k, items, whatIfs);
    if (v == null) return null;
    t += k.weight * v;
  }
  return t;
}

function trajectoryN(
  items: readonly Weighted<GradeItem>[],
  whatIfs: WhatIfs,
): number | null {
  const p = trajectoryPctN(items, whatIfs);
  return p == null ? null : gradeFromPct(p);
}

function gradedSumN(items: readonly Weighted<GradeItem>[]): number {
  return items.reduce((a, k) => a + (k.score != null ? k.weight * k.score : 0), 0);
}

function ungradedWeightN(items: readonly Weighted<GradeItem>[]): number {
  return items.reduce((a, k) => a + (k.score == null ? k.weight : 0), 0);
}

function neededN(items: readonly Weighted<GradeItem>[], target: number): number | null {
  const uw = ungradedWeightN(items);
  if (uw <= 0) return null;
  return (40 + 10 * target - gradedSumN(items)) / uw;
}

function swingN(
  item: GradeItem,
  items: readonly Weighted<GradeItem>[],
  whatIfs: WhatIfs,
): Swing | null {
  const sf = soFarN(items);
  const base: Record<string, number | null | undefined> = { ...whatIfs };
  for (const x of items) {
    if (x.score == null && x.id !== item.id) {
      const f = whatIfs[x.id] != null ? (whatIfs[x.id] as number) : sf;
      if (f == null) return null;
      base[x.id] = f;
    }
  }
  const lo = trajectoryN(items, { ...base, [item.id]: 50 });
  const hi = trajectoryN(items, { ...base, [item.id]: 100 });
  if (lo == null || hi == null) return null;
  return { lo, hi, size: hi - lo };
}

// ---------------------------------------------------------------------------
// Public API.

/**
 * [soFar] Weighted average percentage of the graded items: Σ(w·s) / Σw over
 * graded items only. `null` when nothing is graded yet.
 */
export function soFar(items: readonly GradeItem[]): number | null | NeedsWeights {
  const n = normaliseWeights(items);
  return n === NEEDS_WEIGHTS ? n : soFarN(n);
}

/**
 * [fillFor] The score an ungraded item is assumed to get, in percent:
 * its own what-if, else the course average so far, else (nothing graded) the
 * mean of all what-ifs that are set, else `null`.
 *
 * As in the prototype it does not look at `item.score`; callers use the real
 * score for graded items and the fill only for ungraded ones. The mean of
 * what-ifs counts every set value in `whatIfs`, as the prototype does.
 */
export function fillFor(
  item: GradeItem,
  items: readonly GradeItem[],
  whatIfs: WhatIfs = {},
): number | null | NeedsWeights {
  const n = normaliseWeights(items);
  return n === NEEDS_WEIGHTS ? n : fillForN(item, n, whatIfs);
}

/**
 * [trajectory] The grade 0..5 the course is heading for:
 * `gradeFromPct(Σ w · (score, or fill when ungraded))`. `null` when any
 * ungraded item has no fill (nothing graded and no what-if set).
 */
export function trajectory(
  items: readonly GradeItem[],
  whatIfs: WhatIfs = {},
): number | null | NeedsWeights {
  const n = normaliseWeights(items);
  return n === NEEDS_WEIGHTS ? n : trajectoryN(n, whatIfs);
}

/**
 * [needed] The average percentage needed on everything still ungraded to end
 * on `target` (0..5): `(40 + 10 · target − gradedSum) / ungradedWeight`, where
 * `40 + 10 · target` is the course percentage for that grade. It can be
 * below 0 (target already secured) or above 100 (out of reach); it is not
 * clamped. `null` when nothing is left to grade.
 */
export function needed(
  items: readonly GradeItem[],
  target: number,
): number | null | NeedsWeights {
  const n = normaliseWeights(items);
  return n === NEEDS_WEIGHTS ? n : neededN(n, target);
}

/** How a course stands against its target. */
export type Verdict =
  /** Nothing is left to grade (the prototype shows "On track · Everything is graded."). */
  | { kind: "all_graded" }
  /** `need` is at most the average so far plus 2 points. */
  | { kind: "on"; need: number }
  /** `need` is at most 100%. */
  | { kind: "within"; need: number }
  /**
   * Even 100% on everything left misses the target. `best` is the grade
   * 0..5 that 100% on everything left gives; `nextGrade` is that floored
   * (the best whole grade still possible); `nextGradeNeed` is what that grade
   * needs, or `null` when `nextGrade` is 0.
   */
  | {
      kind: "out";
      need: number;
      best: number;
      nextGrade: 0 | 1 | 2 | 3 | 4 | 5;
      nextGradeNeed: number | null;
    }
  | { kind: "needs_weights" };

/**
 * [verdictOf] Where the course stands for `target` (0..5).
 *
 * - No ungraded items: `all_graded` (the prototype's "on" with no need).
 * - Something graded and `need ≤ soFar + 2`: `on`.
 * - `need ≤ 100`: `within` (this is also where a course with nothing graded
 *   lands, since it has no average to compare with).
 * - Otherwise `out`, with `best = gradeFromPct(gradedSum + ungradedWeight · 100)`,
 *   `nextGrade = floor(best + 1e-9)` and `nextGradeNeed = needed(nextGrade)`.
 *
 * `whatIfs` is accepted so every course function takes the same inputs, but
 * it does not change the verdict: as in the prototype, the verdict is about
 * real grades only (what is needed from here), never about what-ifs.
 */
export function verdict(
  items: readonly GradeItem[],
  target: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- see JSDoc: the prototype's verdict ignores what-ifs.
  whatIfs: WhatIfs = {},
): Verdict {
  const n = normaliseWeights(items);
  if (n === NEEDS_WEIGHTS) return { kind: "needs_weights" };
  const need = neededN(n, target);
  if (need == null) return { kind: "all_graded" };
  const sf = soFarN(n);
  if (sf != null && need <= sf + 2) return { kind: "on", need };
  if (need <= 100) return { kind: "within", need };
  const bestPct = gradedSumN(n) + ungradedWeightN(n) * 100;
  const best = gradeFromPct(bestPct);
  const nextGrade = gradeStep(bestPct);
  return {
    kind: "out",
    need,
    best,
    nextGrade,
    nextGradeNeed: nextGrade > 0 ? neededN(n, nextGrade) : null,
  };
}

/** The grade range one item can still move the course across. */
export type Swing = { lo: number; hi: number; size: number };

/**
 * [swingOf] The course grade with this item at 50% (`lo`) and at 100%
 * (`hi`), every other ungraded item held at its what-if or else the average
 * so far; `size = hi − lo`. `null` when another ungraded item has neither
 * (nothing graded and no what-if: the prototype's "needs a what-if first").
 *
 * Note the prototype's hold value differs from `fillFor`: it does not fall
 * back to the mean of the what-ifs. Kept as is. The item's own what-if is
 * replaced by 50 and 100. Meant for ungraded items; for a graded item the
 * real score wins and the size is 0.
 */
export function swing(
  item: GradeItem,
  items: readonly GradeItem[],
  whatIfs: WhatIfs = {},
): Swing | null | NeedsWeights {
  const n = normaliseWeights(items);
  return n === NEEDS_WEIGHTS ? n : swingN(item, n, whatIfs);
}

/**
 * [mattersMost] The ungraded item with the widest swing. Where an item has
 * no swing (`null`), its weight stands in for the size, exactly as the
 * prototype does (it compares a grade span with a weight; with nothing
 * graded and no what-ifs every swing is null, so the heaviest item wins).
 * Ties go to the earlier item (a later one must beat it by more than 1e-9).
 * `null` when nothing is left to grade.
 */
export function mattersMost<T extends GradeItem>(
  items: readonly T[],
  whatIfs: WhatIfs = {},
): T | null | NeedsWeights {
  const n = normaliseWeights(items);
  if (n === NEEDS_WEIGHTS) return n;
  let best: T | null = null;
  let size = -1;
  n.forEach((k, i) => {
    if (k.score != null) return;
    const sw = swingN(k, n, whatIfs);
    const sz = sw ? sw.size : k.weight;
    if (sz > size + EPS) {
      size = sz;
      best = items[i];
    }
  });
  return best;
}

/**
 * [overall] The mean trajectory over the courses that have graded work.
 * `null` when no course has. Decision: a course that needs weights is left
 * out (it cannot be computed), and so is any course whose trajectory is
 * `null` (cannot happen once something is graded, but kept safe).
 */
export function overall(courses: readonly GradeCourse[]): number | null {
  const vals: number[] = [];
  for (const c of courses) {
    const n = normaliseWeights(c.items);
    if (n === NEEDS_WEIGHTS || soFarN(n) == null) continue;
    const t = trajectoryN(n, c.whatIfs ?? {});
    if (t != null) vals.push(t);
  }
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** One point on the chart: `index` is the item's position (the x axis). */
export type ChartPoint = { index: number; grade: number };

/** The series the trajectory chart draws, in grades 0..5. */
export type ChartSeries = {
  /**
   * The solid line: the running grade after each graded item,
   * `gradeFromPct(cumulative Σ w·v / cumulative Σ w)`. As in the prototype,
   * the cumulative sum also includes the fills of ungraded items before it.
   */
  running: ChartPoint[];
  /**
   * The dashed line: starts at the last running point (when there is one)
   * and continues through every ungraded item using its fill. Empty when any
   * fill is missing, or when nothing is left to grade.
   */
  projection: ChartPoint[];
  /**
   * The band between "all remaining at 50%" (`lo`) and "all remaining at
   * 100%" (`hi`), as running grades, from the last graded item (or the first
   * item when nothing is graded) to the end.
   */
  band: { index: number; lo: number; hi: number }[];
  /** The projection's last grade (the chart's "Trajectory x.x"), or null. */
  end: number | null;
  /** True when the chart shows "Too early for a trajectory". */
  empty: boolean;
};

/**
 * [chartSVG series maths] The running grade, the projection and the 50-100%
 * band for the trajectory chart, without any pixels. Mirrors the prototype
 * step by step, including that a graded item after an ungraded one adds to
 * a running sum that already holds that item's fill.
 */
export function chartSeries(
  items: readonly GradeItem[],
  whatIfs: WhatIfs = {},
): ChartSeries | NeedsWeights {
  const n = normaliseWeights(items);
  if (n === NEEDS_WEIGHTS) return n;
  let cw = 0;
  let cs = 0;
  let cl = 0;
  let ch = 0;
  let lastG = -1;
  let canProject = true;
  const running: ChartPoint[] = [];
  const dash: ChartPoint[] = [];
  const lo: number[] = [];
  const hi: number[] = [];
  n.forEach((k, i) => {
    cw += k.weight;
    if (k.score != null) {
      cs += k.weight * k.score;
      cl += k.weight * k.score;
      ch += k.weight * k.score;
      lastG = i;
      running.push({ index: i, grade: gradeFromPct(cs / cw) });
    } else {
      cl += k.weight * 50;
      ch += k.weight * 100;
      const f = fillForN(k, n, whatIfs);
      if (f == null) canProject = false;
      else cs += k.weight * f;
      if (canProject) dash.push({ index: i, grade: gradeFromPct(cs / cw) });
    }
    // cw is 0 only while every item so far has weight 0; draw those at 0.
    lo.push(cw > 0 ? gradeFromPct(cl / cw) : 0);
    hi.push(cw > 0 ? gradeFromPct(ch / cw) : 0);
  });
  const showProjection = dash.length > 0 && canProject;
  const projection = showProjection
    ? (running.length ? [running[running.length - 1]] : []).concat(dash)
    : [];
  const bandFrom = Math.max(0, lastG);
  const band = lo
    .map((l, i) => ({ index: i, lo: l, hi: hi[i] }))
    .slice(bandFrom);
  return {
    running,
    projection,
    band,
    end: showProjection ? dash[dash.length - 1].grade : null,
    empty: lastG < 0 && !showProjection,
  };
}
