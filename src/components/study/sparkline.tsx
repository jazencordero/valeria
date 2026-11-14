/**
 * Sparkline: the small forecast line on exam cards. 132 by 40: history as a
 * solid ink line, the "a bite a day" plan as a dashed accent line, the target
 * as a faint dotted line, and a now dot. Static (no draw-in).
 * Source: prototype merged.html sparkSVG and CSS .spark / .sp-*.
 */
import type { SVGAttributes } from "react";
import { planCurve } from "@/lib/study/forecast";

export const SPARK_W = 132;
export const SPARK_H = 40;

export type SparklineProps = Omit<SVGAttributes<SVGSVGElement>, "children" | "target"> & {
  /** Forecast on each day before today, oldest first (0..100). */
  history: readonly number[];
  /** Forecast today, 0..100, not rounded. */
  forecast: number;
  /** Whole days until the exam. */
  daysLeft: number;
  /** Target percent, 0..100. */
  target: number;
};

const clamp = (p: number) => Math.min(100, Math.max(0, p));

export function Sparkline({
  history,
  forecast,
  daysLeft,
  target,
  className = "",
  ...rest
}: SparklineProps) {
  const W = SPARK_W;
  const H = SPARK_H;
  const hist = [...history, forecast].map(clamp);
  const nh = hist.length - 1;
  const D = Math.max(0, Math.floor(daysLeft));
  const span = Math.max(1, nh + D);
  const X = (d: number) => 2 + ((d + nh) / span) * (W - 8);
  const Y = (p: number) => 3 + ((100 - clamp(p)) / 100) * (H - 6);
  const pt = (x: number, y: number) => `${x.toFixed(1)} ${y.toFixed(1)}`;

  const histD = "M" + hist.map((p, i) => pt(X(i - nh), Y(p))).join(" L");
  const planD = "M" + planCurve(clamp(forecast), D).map((p, i) => pt(X(i), Y(p))).join(" L");
  const ty = Y(target);

  return (
    <svg
      {...rest}
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      aria-hidden="true"
      focusable="false"
      className={`mb-0.5 block flex-none overflow-visible ${className}`}
    >
      <line
        x1={0}
        x2={W}
        y1={ty}
        y2={ty}
        style={{ stroke: "var(--accent)", strokeWidth: 1, strokeDasharray: "2 3", opacity: 0.6 }}
      />
      <path
        d={histD}
        fill="none"
        style={{ stroke: "var(--ink)", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" }}
      />
      <path
        d={planD}
        fill="none"
        style={{ stroke: "var(--accent)", strokeWidth: 1.8, strokeDasharray: "3 3", strokeLinecap: "round" }}
      />
      <circle
        cx={X(0)}
        cy={Y(forecast)}
        r={3.2}
        style={{ fill: "var(--accent)", stroke: "var(--surface)", strokeWidth: 1.5 }}
      />
    </svg>
  );
}
