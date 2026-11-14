"use client";

/**
 * Ring: a progress ring with a centred mono label (the forecast percent).
 * Sizes 36, 48, 76 and 92 px. Draws from empty on first show; calm and
 * instant modes show the final value at once.
 * Source: prototype main-flow.html CSS 359-363 (.ring) and ringHTML
 * (viewBox 36, r 15, pathLength 100, starts at 12 o'clock).
 */
import type { HTMLAttributes, ReactNode } from "react";
import { motion } from "motion/react";
import { useMotionMode } from "@/lib/motion/use-calm";
import { ease } from "@/lib/motion/tokens";

export type RingSize = 36 | 48 | 76 | 92;

const LABEL_SIZE: Record<RingSize, string> = {
  36: "text-[12px]",
  48: "text-[13px]",
  76: "text-[20px]",
  92: "text-[24px]",
};

/** The prototype draws the ring in 600 ms with the out ease. */
const DRAW_S = 0.6;

export type RingProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  /** 0 to 100. Values outside are clamped. */
  value: number;
  size?: RingSize;
  /** Centred label. Defaults to the rounded value. */
  label?: ReactNode;
  /** Spoken text. Defaults to "<value> percent forecast". */
  ariaLabel?: string;
};

export function Ring({
  value,
  size = 36,
  label,
  ariaLabel,
  className = "",
  style,
  ...rest
}: RingProps) {
  const mode = useMotionMode();
  const v = Math.round(Math.min(100, Math.max(0, value)));
  const circle = {
    className: "stroke-accent",
    cx: 18,
    cy: 18,
    r: 15,
    pathLength: 100,
    strokeLinecap: "round" as const,
    strokeDasharray: `${v} 100`,
    transform: "rotate(-90 18 18)",
  };

  return (
    <span
      {...rest}
      role="img"
      aria-label={ariaLabel ?? `${v} percent forecast`}
      data-value={v}
      className={`relative inline-grid flex-none place-items-center ${className}`}
      style={{ width: size, height: size, ...style }}
    >
      <svg
        viewBox="0 0 36 36"
        aria-hidden="true"
        className="absolute inset-0 fill-none"
        style={{ width: size, height: size, strokeWidth: 3 }}
      >
        <circle className="stroke-line" cx={18} cy={18} r={15} />
        {v > 0 &&
          (mode === "full" ? (
            <motion.circle
              {...circle}
              initial={{ strokeDashoffset: v }}
              animate={{ strokeDashoffset: 0 }}
              transition={{ duration: DRAW_S, ease: ease.out }}
            />
          ) : (
            <circle {...circle} strokeDashoffset={0} />
          ))}
      </svg>
      <b
        aria-hidden="true"
        className={`relative font-mono font-medium leading-none tracking-normal tabular-nums ${LABEL_SIZE[size]}`}
      >
        {label ?? v}
      </b>
    </span>
  );
}
