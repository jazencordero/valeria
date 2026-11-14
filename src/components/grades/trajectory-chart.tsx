"use client";

/**
 * Trajectory chart on the grades page (M6-05).
 *
 * Grid at grades 0, 1, 3 and 5 (labels 1, 3, 5); x labels from the items'
 * short names; a solid line for the running grade over graded items; a
 * dashed projection over the rest; a faint band between worst case (all
 * remaining at 50%) and best case (all at 100%); a dashed rose target line
 * labelled "target 5"; an end dot with the trajectory value. Empty: "Too
 * early for a trajectory". No hover values (cut).
 *
 * The numbers come from `chartSeries` in `@/lib/grades/model` (M6-03); this
 * file only turns them into pixels.
 *
 * First show: the solid line draws (600 ms), the projection reveals, the end
 * fades in. A target change slides the target line. Static in calm and
 * instant modes. Fills its box's width (156 high); redraws on resize and
 * theme change. Source: prototype merged.html `chartSVG` and CSS .ch-*.
 */
import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import { motion } from "motion/react";
import type { ChartSeries, GradeItem } from "@/lib/grades/model";
import { useMotionMode } from "@/lib/motion/use-calm";
import { duration, ease } from "@/lib/motion/tokens";

/** One x position: the item's short name (axis) and full name (spoken). */
export type TrajectoryChartItem = Pick<GradeItem, "id"> & {
  /** Short axis label, for example "A1" or "Exam". */
  short: string;
  /** Full name, for the spoken summary. */
  name: string;
};

export type TrajectoryChartData = {
  /** The course's items in chart order (the same order given to `chartSeries`). */
  items: readonly TrajectoryChartItem[];
  /** `chartSeries(items, whatIfs)` for the course (not `NEEDS_WEIGHTS`). */
  series: ChartSeries;
  /** Target grade 0..5. */
  target: number;
};

export type TrajectoryChartProps = TrajectoryChartData &
  Omit<HTMLAttributes<HTMLDivElement>, "children" | "role">;

const H = 156;
const L = 22;
const R = 34;
const T = 14;
const B = 24;
const MIN_W = 200;
const GRID = [0, 1, 3, 5] as const;

/** The prototype's fmt1: one decimal. */
export const fmt1 = (g: number) => (Math.round(g * 10) / 10).toFixed(1);

const clampG = (g: number) => Math.min(5, Math.max(0, g));

/** Pure geometry for one width. Exported for tests and the dev page. */
export function trajectoryChartLayout(data: TrajectoryChartData, width: number) {
  const W = Math.max(MIN_W, Math.round(width));
  const iw = W - L - R;
  const ih = H - T - B;
  const n = data.items.length;
  const X = (i: number) => L + (n <= 1 ? iw / 2 : (i * iw) / (n - 1));
  const Y = (g: number) => T + ((5 - clampG(g)) / 5) * ih;
  const pt = (x: number, y: number) => `${x.toFixed(1)} ${y.toFixed(1)}`;
  const { running, projection, band, end } = data.series;

  const bandPts = band
    .map((b) => pt(X(b.index), Y(b.hi)))
    .concat([...band].reverse().map((b) => pt(X(b.index), Y(b.lo))))
    .map((s) => s.replace(" ", ","))
    .join(" ");

  const last = projection[projection.length - 1];
  const ty = Y(data.target);

  // Target label sits above its line, or below when the running line or the
  // projection passes through that spot (the label never covers the data).
  const line = [...running, ...projection.slice(running.length ? 1 : 0)].map((p) => ({
    x: X(p.index),
    y: Y(p.grade),
  }));
  const yAt = (x: number): number | null => {
    if (!line.length) return null;
    if (line.length === 1) return Math.abs(line[0].x - x) < 8 ? line[0].y : null;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      if (x >= a.x && x <= b.x) return b.x === a.x ? a.y : a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y);
    }
    return null;
  };
  const tlW = `target ${data.target}`.length * 10 * 0.62;
  const hits = (y0: number, y1: number) => {
    for (let x = L; x <= L + 4 + tlW + 4; x += 2) {
      const y = yAt(x);
      if (y != null && y >= y0 - 3 && y <= y1 + 3) return true;
    }
    return false;
  };
  const tlDy = hits(ty - 13, ty - 2) && !hits(ty + 4, ty + 15) ? 14 : -5;

  return {
    W,
    H,
    iw,
    ih,
    grid: GRID.map((g) => ({ g, y: Y(g) })),
    xLabels: data.items.map((it, i) => ({ id: it.id, x: X(i), text: it.short })),
    axisY: H - 6,
    ty,
    tlDy,
    bandPts: band.length > 1 ? bandPts : null,
    solidD:
      running.length > 1 ? "M" + running.map((p) => pt(X(p.index), Y(p.grade))).join(" L") : null,
    dots: running.map((p) => ({ index: p.index, x: X(p.index), y: Y(p.grade) })),
    dashD:
      projection.length > 1
        ? "M" + projection.map((p) => pt(X(p.index), Y(p.grade))).join(" L")
        : null,
    end: end != null && last ? { x: X(last.index), y: Y(end), text: fmt1(end) } : null,
    empty: { x: L + iw / 2, y: T + ih / 2 + 4 },
  };
}

/** Spoken summary for the chart. */
export function trajectoryChartLabel(data: TrajectoryChartData): string {
  const { series, target } = data;
  if (series.empty) return `Trajectory chart. Too early for a trajectory. Target ${target}.`;
  const lastRun = series.running[series.running.length - 1];
  const value = series.end ?? lastRun?.grade;
  const head = value != null ? `Trajectory ${fmt1(value)}. ` : "";
  const graded = series.running
    .map((p) => `After ${data.items[p.index]?.name ?? "item"}: ${fmt1(p.grade)}`)
    .join(", ");
  return `Trajectory chart. ${head}Target ${target}.${graded ? ` ${graded}.` : ""}`;
}

/** Width of the box, kept current with a ResizeObserver. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(Math.round(el.clientWidth || 320));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Bumps on a theme change (data-theme on <html>, or the system scheme). */
function useThemeTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", bump);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", bump);
    };
  }, []);
  return tick;
}

const AX = {
  fill: "var(--ink-3)",
  fontFamily: "var(--mono)",
  fontSize: 10,
  letterSpacing: "0.02em",
} as const;

/** Motion timeline (seconds). */
const DRAW = 0.6;
const REVEAL = duration.slow;
const END_AT = DRAW + REVEAL - 0.1;

export function TrajectoryChart({
  items,
  series,
  target,
  className = "",
  style,
  ...rest
}: TrajectoryChartProps) {
  const data = { items, series, target };
  const mode = useMotionMode();
  const [ref, width] = useWidth();
  const themeTick = useThemeTick();
  const animate = mode === "full";

  const g = width === null ? null : trajectoryChartLayout(data, width);
  const lastDot = g && g.dots.length ? g.dots[g.dots.length - 1].x : 0;
  const firstDot = g && g.dots.length ? g.dots[0].x : 0;
  const dotDelay = (x: number) =>
    lastDot > firstDot ? ((x - firstDot) / (lastDot - firstDot)) * (DRAW - 0.12) : 0;
  const hasSolid = !!g?.solidD;
  const revealAt = hasSolid ? DRAW : 0;

  return (
    <div
      {...rest}
      ref={ref}
      role="img"
      aria-label={trajectoryChartLabel(data)}
      data-theme-tick={themeTick}
      className={`min-h-[156px] w-full ${className}`}
      style={style}
    >
      {g && (
        <svg
          viewBox={`0 0 ${g.W} ${g.H}`}
          width={g.W}
          height={g.H}
          aria-hidden="true"
          focusable="false"
          className="block h-auto w-full overflow-visible"
        >
          {g.grid.map(({ g: grade, y }) => (
            <g key={grade}>
              <line
                x1={L}
                x2={g.W - R}
                y1={y}
                y2={y}
                style={
                  grade === 0
                    ? { stroke: "var(--ink-3)", strokeWidth: 1, opacity: 0.5 }
                    : { stroke: "var(--line)", strokeWidth: 1 }
                }
              />
              {grade > 0 && (
                <text x={L - 8} y={y + 3.5} textAnchor="end" style={AX}>
                  {grade}
                </text>
              )}
            </g>
          ))}

          {g.xLabels.map((lb) => (
            <text key={lb.id} x={lb.x} y={g.axisY} textAnchor="middle" style={AX}>
              {lb.text}
            </text>
          ))}

          {g.bandPts && (
            <motion.polygon
              points={g.bandPts}
              style={{ fill: "var(--accent-wash)" }}
              initial={animate ? { opacity: 0 } : false}
              animate={{ opacity: 0.5 }}
              transition={{ duration: REVEAL, delay: revealAt, ease: ease.out }}
            />
          )}

          <motion.g
            style={{ transformBox: "view-box" }}
            initial={false}
            animate={{ y: g.ty }}
            transition={animate ? { duration: duration.slow, ease: ease.inout } : { duration: 0 }}
          >
            <line
              x1={L}
              x2={g.W - R}
              y1={0}
              y2={0}
              style={{ stroke: "var(--accent)", strokeWidth: 1.5, strokeDasharray: "5 4" }}
            />
            <text x={L + 4} y={g.tlDy} style={{ ...AX, fill: "var(--ink-2)" }}>
              target {target}
            </text>
          </motion.g>

          {g.dashD && (
            <motion.g
              initial={animate ? { clipPath: "inset(0 100% 0 0)" } : false}
              animate={{ clipPath: "inset(0 0% 0 0)" }}
              transition={{ duration: REVEAL, delay: revealAt, ease: ease.out }}
            >
              <path
                d={g.dashD}
                fill="none"
                style={{
                  stroke: "var(--ink-2)",
                  strokeWidth: 2,
                  strokeDasharray: "4 4",
                  strokeLinecap: "round",
                }}
              />
            </motion.g>
          )}

          {g.end && (
            <motion.g
              initial={animate ? { opacity: 0 } : false}
              animate={{ opacity: 1 }}
              transition={{ duration: duration.base, delay: hasSolid ? END_AT : REVEAL, ease: ease.out }}
            >
              <circle
                cx={g.end.x}
                cy={g.end.y}
                r={5}
                style={{ fill: "var(--surface)", stroke: "var(--ink)", strokeWidth: 2.5 }}
              />
              <text
                x={g.end.x + 8}
                y={g.end.y + 4}
                style={{ fill: "var(--ink)", fontFamily: "var(--mono)", fontSize: 12, fontWeight: 500 }}
              >
                {g.end.text}
              </text>
            </motion.g>
          )}

          {g.solidD && (
            <motion.path
              d={g.solidD}
              fill="none"
              style={{
                stroke: "var(--ink)",
                strokeWidth: 2,
                strokeLinecap: "round",
                strokeLinejoin: "round",
              }}
              initial={animate ? { pathLength: 0 } : false}
              animate={{ pathLength: 1 }}
              transition={{ duration: DRAW, ease: ease.out }}
            />
          )}

          {g.dots.map((d) => (
            <motion.circle
              key={d.index}
              cx={d.x}
              cy={d.y}
              r={4}
              style={{ fill: "var(--ink)", stroke: "var(--surface)", strokeWidth: 2 }}
              initial={animate ? { opacity: 0 } : false}
              animate={{ opacity: 1 }}
              transition={{ duration: duration.quick, delay: dotDelay(d.x), ease: ease.out }}
            />
          ))}

          {series.empty && (
            <text
              x={g.empty.x}
              y={g.empty.y}
              textAnchor="middle"
              style={{ fill: "var(--ink-3)", fontFamily: "var(--font)", fontSize: 13 }}
            >
              Too early for a trajectory
            </text>
          )}
        </svg>
      )}
    </div>
  );
}
