"use client";

/**
 * Forecast chart on the exam page: 13 days of history (solid), then two
 * futures to exam day: the plan (dashed accent; "a bite a day", or whatever
 * pace the exam's plan has) and "if you stop" (fainter, thinner). The plan
 * line is the page's projection (`plan`, one value per day from today to exam
 * day); without one, the previews' rule of thumb (`planCurve`). Grid at 0, 50, 100; the target line labelled
 * "target 80% · a 4" (the grade only when her bundle names one); axis labels "2 WEEKS AGO", "TODAY" and the exam day; a
 * flag at the exam; a now dot with a halo; end labels on both futures.
 * No band between the futures, no legend, no hover read-out.
 *
 * First show: history draws (700 ms), futures reveal (520 ms), the dot
 * springs. Static in calm and instant modes. Fills its box's width, 176 high
 * under 420 px, else 196; re-renders on resize and theme change.
 * Source: prototype merged.html fcChartSVG / renderFcCharts and CSS .fc-* /
 * .ch-*.
 */
import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import { motion } from "motion/react";
import { planCurve, stopCurve } from "@/lib/study/forecast";
import { useMotionMode } from "@/lib/motion/use-calm";
import { ease } from "@/lib/motion/tokens";

export type ForecastChartData = {
  /** Forecast on each day before today, oldest first (13 values), 0..100. */
  history: readonly number[];
  /** Forecast today, 0..100, not rounded. */
  forecast: number;
  /** Whole days until the exam (at least 1 for a useful chart). */
  daysLeft: number;
  /** Target percent, 0..100. */
  target: number;
  /** The grade she aims for, when one is known: "target 85% · a 4". Without it the percent stands alone. */
  targetGrade?: number | null;
  /** Exam day as the axis shows it, for example "DEC 12". */
  examDay: string;
  /** The plan's projection, one value per day from today to exam day (`Plan.curve`). */
  plan?: readonly number[];
  /** The plan's end as every screen shows it (`Plan.endShown`): the end label says this number, not its own rounding. */
  planEndShown?: number;
  /** The plan's pace inside the spoken summary: "a bite a day" (default), "two bites a day", "the plan". */
  planName?: string;
};


export type ForecastChartProps = ForecastChartData &
  Omit<HTMLAttributes<HTMLDivElement>, "children" | "role">;

const L = 30;
const R = 50;
const T = 22;
const B = 26;
const MIN_W = 260;

/** Rough advance width of Geist Mono (0.6em) plus letter-spacing. */
const textW = (s: string, size: number, spacing = 0) => s.length * size * (0.6 + spacing);

const clamp = (p: number) => Math.min(100, Math.max(0, p));

/** The plan line's points: the page's projection when it fits the days left, else the rule of thumb. */
function planPoints(data: ForecastChartData, f: number, D: number): number[] {
  return data.plan && data.plan.length === D + 1 ? data.plan.map(clamp) : planCurve(f, D);
}

export const chartHeight = (W: number) => (W < 420 ? 176 : 196);

type Box = { x0: number; x1: number; y0: number; y1: number };
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** Pure geometry for one width. Exported for tests and the dev page. */
export function forecastChartLayout(data: ForecastChartData, width: number) {
  const W = Math.max(MIN_W, Math.round(width));
  const H = chartHeight(W);
  const iw = W - L - R;
  const ih = H - T - B;
  const f = clamp(data.forecast);
  const hist = [...data.history, f].map(clamp);
  const nh = hist.length - 1;
  const D = Math.max(0, Math.floor(data.daysLeft));
  const span = Math.max(1, nh + D);
  const X = (d: number) => L + ((d + nh) / span) * iw;
  const Y = (p: number) => T + ((100 - clamp(p)) / 100) * ih;
  const pt = (x: number, y: number) => `${x.toFixed(1)} ${y.toFixed(1)}`;

  const plan = planPoints(data, f, D);
  const stop = stopCurve(f, D);
  const planEndPct = plan[plan.length - 1];
  const stopEndPct = stop[stop.length - 1];

  const xe = X(D);
  const x0 = X(0);
  const ny = Y(f);
  const ty = Y(data.target);

  // End labels sit right of the exam line; pull them apart when the two
  // futures end close together (12 and 11 px text).
  const GAP = 15;
  let lpY = Y(planEndPct) + 4;
  let lsY = Y(stopEndPct) + 4;
  if (Math.abs(lpY - lsY) < GAP) {
    const mid = (lpY + lsY) / 2;
    const planUp = lpY <= lsY;
    lpY = mid + (planUp ? -GAP / 2 : GAP / 2);
    lsY = mid + (planUp ? GAP / 2 : -GAP / 2);
  }
  const topLimit = T + 6;
  const bottomLimit = T + ih + 2;
  const shift = Math.max(0, topLimit - Math.min(lpY, lsY)) - Math.max(0, Math.max(lpY, lsY) - bottomLimit);
  lpY += shift;
  lsY += shift;

  // Now label: right-aligned, left of and above the dot (13 px).
  const nowText = `${Math.round(f)}%`;
  const nowX = x0 - 10;
  const nowY = Math.max(12, ny - 12);
  const nowBox: Box = { x0: nowX - textW(nowText, 13), x1: nowX, y0: nowY - 10, y1: nowY + 2 };

  // Target label above its line, or below it when it would hit the now label.
  const targetText = `target ${Math.round(data.target)}%${data.targetGrade == null ? "" : ` · a ${data.targetGrade}`}`;
  const tlX = L + 4;
  const tlW = textW(targetText, 10, 0.02);
  const boxAt = (y: number): Box => ({ x0: tlX, x1: tlX + tlW, y0: y - 8, y1: y + 2 });
  let tlY = ty - 6;
  if (overlaps(boxAt(tlY), nowBox) || tlY - 8 < 2) tlY = ty + 13;

  // Bottom axis: keep "TODAY" and the exam day apart and inside the frame.
  const axY = H - 6;
  const pad = 6;
  const startW = textW("2 WEEKS AGO", 10, 0.02);
  const todayW = textW("TODAY", 10, 0.02);
  const examW = textW(data.examDay, 10, 0.02);
  const examX = Math.min(xe, W - examW / 2);
  // With no history yet, today is the left edge: "2 WEEKS AGO" would label nothing
  // and push TODAY off its point, so the start label is left out.
  const showStart = nh > 0;
  let todayX = Math.min(x0, examX - examW / 2 - pad - todayW / 2);
  todayX = Math.max(todayX, showStart ? L + startW + pad + todayW / 2 : L + todayW / 2);
  const showToday = todayX + todayW / 2 + pad <= examX - examW / 2 || D === 0;

  return {
    W,
    H,
    L,
    R,
    T,
    ih,
    grid: [0, 50, 100].map((p) => ({ p, y: Y(p) })),
    ty,
    targetText,
    tl: { x: tlX, y: tlY },
    xe,
    x0,
    ny,
    nowText,
    now: { x: nowX, y: nowY },
    histD: "M" + hist.map((p, i) => pt(X(i - nh), Y(p))).join(" L"),
    planD: "M" + plan.map((p, i) => pt(X(i), Y(p))).join(" L"),
    stopD: "M" + stop.map((p, i) => pt(X(i), Y(p))).join(" L"),
    planEnd: { y: Y(planEndPct), label: `${data.planEndShown ?? Math.round(planEndPct)}%`, labelY: lpY },
    stopEnd: { y: Y(stopEndPct), label: `${Math.round(stopEndPct)}%`, labelY: lsY },
    axis: { y: axY, todayX, examX, showToday: showToday && D > 0, showStart },
    planEndPct,
    stopEndPct,
  };
}

/** Spoken summary for the chart. */
export function forecastChartLabel(data: ForecastChartData): string {
  const f = clamp(data.forecast);
  const D = Math.max(0, Math.floor(data.daysLeft));
  const plan = planPoints(data, f, D);
  const stop = stopCurve(f, D);
  return (
    `Forecast chart. ${Math.round(f)}% today. ` +
    `With ${data.planName ?? "a bite a day"}, about ${data.planEndShown ?? Math.round(plan[plan.length - 1])}% on exam day. ` +
    `If you stop, about ${Math.round(stop[stop.length - 1])}%. ` +
    `Target ${Math.round(data.target)}%.`
  );
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
const AX_STRONG = { ...AX, fill: "var(--ink-2)" } as const;

export function ForecastChart({
  history,
  forecast,
  daysLeft,
  target,
  targetGrade,
  examDay,
  className = "",
  style,
  ...rest
}: ForecastChartProps) {
  const data = { history, forecast, daysLeft, target, targetGrade, examDay };
  const mode = useMotionMode();
  const [ref, width] = useWidth();
  const themeTick = useThemeTick();
  const animate = mode === "full";

  const g = width === null ? null : forecastChartLayout(data, width);

  return (
    <div
      {...rest}
      ref={ref}
      role="img"
      aria-label={forecastChartLabel(data)}
      data-theme-tick={themeTick}
      className={`min-h-[176px] w-full ${className}`}
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
          {g.grid.map(({ p, y }) => (
            <g key={p}>
              <line
                x1={g.L}
                x2={g.W - g.R}
                y1={y}
                y2={y}
                style={
                  p === 0
                    ? { stroke: "var(--ink-3)", strokeWidth: 1, opacity: 0.5 }
                    : { stroke: "var(--line)", strokeWidth: 1 }
                }
              />
              <text x={g.L - 8} y={y + 3.5} textAnchor="end" style={AX}>
                {p}
              </text>
            </g>
          ))}

          <line
            x1={g.L}
            x2={g.W - g.R}
            y1={g.ty}
            y2={g.ty}
            style={{ stroke: "var(--accent)", strokeWidth: 1.5, strokeDasharray: "5 4" }}
          />
          <text x={g.tl.x} y={g.tl.y} style={AX_STRONG}>
            {g.targetText}
          </text>

          <line
            x1={g.xe}
            x2={g.xe}
            y1={g.T - 10}
            y2={g.T + g.ih}
            style={{ stroke: "var(--ink-2)", strokeWidth: 1, strokeDasharray: "2 3" }}
          />
          <g transform={`translate(${g.xe} ${g.T - 12})`}>
            <path
              d="M0 -2 h11 l-3 4 l3 4 h-11 z"
              style={{ fill: "var(--accent)", stroke: "var(--ink)", strokeWidth: 1, strokeLinejoin: "round" }}
            />
          </g>
          <line
            x1={g.x0}
            x2={g.x0}
            y1={g.T}
            y2={g.T + g.ih}
            style={{ stroke: "var(--ink)", strokeWidth: 1, opacity: 0.18 }}
          />

          {g.axis.showStart && (
            <text x={g.L} y={g.axis.y} style={AX}>
              2 WEEKS AGO
            </text>
          )}
          {g.axis.showToday && (
            <text x={g.axis.todayX} y={g.axis.y} textAnchor="middle" style={AX_STRONG}>
              TODAY
            </text>
          )}
          <text x={g.axis.examX} y={g.axis.y} textAnchor="middle" style={AX_STRONG}>
            {examDay}
          </text>

          <motion.path
            d={g.histD}
            fill="none"
            style={{
              stroke: "var(--ink)",
              strokeWidth: 2.2,
              strokeLinecap: "round",
              strokeLinejoin: "round",
            }}
            initial={animate ? { pathLength: 0 } : false}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.7, ease: ease.out }}
          />

          <motion.g
            initial={animate ? { clipPath: "inset(0 100% 0 0)" } : false}
            animate={{ clipPath: "inset(0 0% 0 0)" }}
            transition={{ duration: 0.52, delay: 0.65, ease: ease.out }}
          >
            <path
              d={g.stopD}
              fill="none"
              style={{
                stroke: "var(--ink-3)",
                opacity: 0.45,
                strokeWidth: 1.4,
                strokeDasharray: "3 4",
                strokeLinecap: "round",
              }}
            />
            <path
              d={g.planD}
              fill="none"
              style={{
                stroke: "var(--accent)",
                strokeWidth: 2.4,
                strokeDasharray: "5 4",
                strokeLinecap: "round",
              }}
            />
            <circle cx={g.xe} cy={g.planEnd.y} r={4} style={{ fill: "var(--accent)" }} />
            <circle
              cx={g.xe}
              cy={g.stopEnd.y}
              r={3.5}
              style={{ fill: "var(--surface)", stroke: "var(--ink-3)", strokeWidth: 1.5 }}
            />
            <text
              x={g.xe + 8}
              y={g.planEnd.labelY}
              style={{ fill: "var(--accent)", fontFamily: "var(--mono)", fontSize: 12, fontWeight: 500 }}
            >
              {g.planEnd.label}
            </text>
            <text
              x={g.xe + 8}
              y={g.stopEnd.labelY}
              style={{ fill: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 11 }}
            >
              {g.stopEnd.label}
            </text>
          </motion.g>

          <motion.g
            style={{ transformBox: "fill-box", transformOrigin: "center" }}
            initial={animate ? { opacity: 0, scale: 0.4 } : false}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", bounce: 0.35, visualDuration: 0.32, delay: 0.6 }}
          >
            <circle cx={g.x0} cy={g.ny} r={11} style={{ fill: "var(--accent)", opacity: 0.18 }} />
            <circle
              cx={g.x0}
              cy={g.ny}
              r={5.5}
              style={{ fill: "var(--ink)", stroke: "var(--surface)", strokeWidth: 2.5 }}
            />
            <text
              x={g.now.x}
              y={g.now.y}
              textAnchor="end"
              style={{ fill: "var(--ink)", fontFamily: "var(--mono)", fontSize: 13, fontWeight: 500 }}
            >
              {g.nowText}
            </text>
          </motion.g>
        </svg>
      )}
    </div>
  );
}
