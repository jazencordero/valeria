/**
 * Course path geometry (M9-06).
 *
 * Pure port of the prototype's `pathGeom` and `curvePath`
 * (context/tickets/prototype/merged.html, lines 5304-5324), plus
 * `doneFraction`, the share of the line that is coloured.
 *
 * The course page draws one stop per lecture, zig-zagging around a vertical
 * centre line, with optional flags (assignments, exams) between stops and a
 * finish mark at the bottom. All numbers are CSS pixels in the trail's own
 * SVG coordinate space (origin top left).
 */

/**
 * Where a lecture stands. Same four values as M9-02's lecture state:
 * done (read), cur (the one to read now), up (next, unlocked), soon (later).
 * Only `cur` changes the geometry.
 */
export type PathLectureState = "done" | "cur" | "up" | "soon";

/** The least a lecture needs for the path: its number and its state. */
export type PathLecture = {
  /** Lecture number as shown to the student (1-based). Flags point at it. */
  n: number;
  st: PathLectureState;
};

/**
 * A flag that sits on the centre line after a lecture, as in the prototype
 * (`{ after: l.n }`). `after` is the lecture number `n`, not the array index.
 * Any other fields (id, text, kind) ride along untouched.
 */
export type PathFlag = {
  after: number;
};

export type Point = { x: number; y: number };

export type PathStop<L extends PathLecture = PathLecture> = Point & { l: L };
export type PathFlagPos<F extends PathFlag = PathFlag> = Point & { f: F };

export type PathGeom<
  L extends PathLecture = PathLecture,
  F extends PathFlag = PathFlag,
> = {
  /** One stop per lecture, in order. */
  pts: PathStop<L>[];
  /** One entry per lecture that has a flag after it, in lecture order. */
  flags: PathFlagPos<F>[];
  /** The finish mark, on the centre line. */
  fin: Point;
  /** Centre line x. */
  cx: number;
  /** Where the stop labels start (also the trail SVG's width). */
  lx: number;
  /** Container height. */
  h: number;
};

/** Layout constants, wide screens first, phones second. */
export const PATH_LAYOUT = {
  wide: { cx: 96, off: 40, lx: 196 },
  phone: { cx: 54, off: 16, lx: 112 },
  /** y of the first stop. */
  top: 84,
  /** Gap between stops, and the gap when a flag sits between them. */
  step: 128,
  stepFlag: 164,
  /** A flag sits this far below the stop it follows. */
  flagDrop: 82,
  /** Extra room above the current stop, and below it. */
  beforeCur: 22,
  afterCur: 14,
  /** The finish sits this far above where the next stop would be. */
  finLift: 20,
  /** Room below the finish. */
  bottom: 56,
} as const;

/**
 * Stop, flag and finish positions for a course's path.
 *
 * Even-index stops sit `off` left of the centre, odd-index stops `off` right.
 * Only the first flag whose `after` matches a lecture is used, as in the
 * prototype. A flag pointing at a lecture that does not exist is ignored.
 */
export function pathGeom<L extends PathLecture, F extends PathFlag>(
  lectures: readonly L[],
  flags: readonly F[],
  wide: boolean,
): PathGeom<L, F> {
  const { cx, off, lx } = wide ? PATH_LAYOUT.wide : PATH_LAYOUT.phone;
  const pts: PathStop<L>[] = [];
  const flagPos: PathFlagPos<F>[] = [];
  let y: number = PATH_LAYOUT.top;

  lectures.forEach((l, i) => {
    pts.push({ x: cx + (i % 2 ? off : -off), y, l });
    const f = flags.find((fl) => fl.after === l.n);
    if (f) flagPos.push({ x: cx, y: y + PATH_LAYOUT.flagDrop, f });
    const next = lectures[i + 1];
    y +=
      (f ? PATH_LAYOUT.stepFlag : PATH_LAYOUT.step) +
      (next && next.st === "cur" ? PATH_LAYOUT.beforeCur : 0) +
      (l.st === "cur" ? PATH_LAYOUT.afterCur : 0);
  });

  const fin = { x: cx, y: y - PATH_LAYOUT.finLift };
  return { pts, flags: flagPos, fin, cx, lx, h: fin.y + PATH_LAYOUT.bottom };
}

/**
 * Number formatting for path strings: rounded to 2 decimals, trailing zeros
 * dropped, and -0 written as 0. So 84 -> "84", 12.5 -> "12.5",
 * 1/3 -> "0.33". The geometry above only ever makes whole numbers (every
 * spacing is even, so the half-gaps are whole too); rounding only matters for
 * points passed in from elsewhere.
 */
export function fmt(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(r === 0 ? 0 : r);
}

/**
 * SVG path through the points: starts with `M x y` at the first point, then
 * one cubic curve per pair whose control points sit straight above and below
 * the ends (half the vertical gap each way), so the line leaves and enters
 * every stop vertically. Empty input gives an empty string.
 */
export function curvePath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  let d = "M" + fmt(points[0].x) + " " + fmt(points[0].y);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const m = (b.y - a.y) / 2;
    d +=
      " C" +
      [a.x, a.y + m, b.x, b.y - m, b.x, b.y].map(fmt).join(" ");
  }
  return d;
}

/** Samples per curve for the length estimate; error is well under 0.1 px. */
const SAMPLES = 64;

function segmentLength(a: Point, b: Point): number {
  const m = (b.y - a.y) / 2;
  const p1 = { x: a.x, y: a.y + m };
  const p2 = { x: b.x, y: b.y - m };
  let len = 0;
  let px = a.x;
  let py = a.y;
  for (let s = 1; s <= SAMPLES; s++) {
    const t = s / SAMPLES;
    const u = 1 - t;
    const x =
      u * u * u * a.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * b.x;
    const y =
      u * u * u * a.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * b.y;
    len += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return len;
}

/** Length of the `curvePath` line through the points. */
export function curveLength(points: readonly Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += segmentLength(points[i - 1], points[i]);
  return len;
}

/**
 * How much of the line is coloured, 0 to 1: the length of the curve from the
 * first point to `points[capIndex]`, over the length of the whole curve.
 * Pass the full line (stops followed by the finish), and `capIndex` from
 * M9-02's cap index. The prototype draws the done line as its own path
 * through `pts[0..capIndex]`; this gives the same share as a number, for
 * a dash offset on the full line or for the advance animation.
 * capIndex is clamped to the points; fewer than two points gives 0.
 */
export function doneFraction(points: readonly Point[], capIndex: number): number {
  const total = curveLength(points);
  if (total === 0) return 0;
  const ci = Math.max(0, Math.min(points.length - 1, Math.floor(capIndex)));
  return curveLength(points.slice(0, ci + 1)) / total;
}
