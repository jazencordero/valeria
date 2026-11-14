"use client";

/**
 * Bar: a thin 4px progress bar whose fill grows from the left on first show.
 * Calm and instant modes show the final width at once.
 * Source: prototype main-flow.html CSS 367-368 (.bar, .bar span).
 */
import type { HTMLAttributes } from "react";
import { motion } from "motion/react";
import { useMotionMode } from "@/lib/motion/use-calm";
import { duration, ease } from "@/lib/motion/tokens";

export type BarProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  /** 0 to 1. Values outside are clamped. */
  value: number;
  /** Spoken name, for example "Exponential smoothing". */
  label?: string;
};

export function Bar({ value, label, className = "", ...rest }: BarProps) {
  const mode = useMotionMode();
  const v = Math.min(1, Math.max(0, value));
  const fill = "block h-full rounded-full bg-ink-2 origin-left";
  const width = `${v * 100}%`;

  return (
    <div
      {...rest}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      className={`h-1 overflow-hidden rounded-full bg-line ${className}`}
    >
      {mode === "full" ? (
        <motion.span
          className={fill}
          style={{ width }}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: duration.slow, ease: ease.out }}
        />
      ) : (
        <span className={fill} style={{ width }} />
      )}
    </div>
  );
}
