/**
 * Rung pips: five small bars, one per rung of the study ladder; the first
 * `rung` are filled. Also RungDot, the round per-concept dot coloured by rung.
 * Source: prototype main-flow.html CSS 1004-1009 (.pips), 1157-1160 (.pdot)
 * and 1230 (.pips i.new).
 *
 * Tones: "default" (accent on a faint ink track) and "inverse" (on a dark
 * button or toast). Sizes: "md" 12x6 and "sm" 8x5. `newFrom` marks the pips
 * above that rung as just climbed (ink), as on the session summary.
 */
import type { HTMLAttributes } from "react";

export const RUNG_NAMES = [
  "Not started",
  "Recognise",
  "Fill the gap",
  "Recall",
  "Explain it",
  "Exam-ready",
] as const;

export type Rung = 0 | 1 | 2 | 3 | 4 | 5;
export type PipsTone = "default" | "inverse";
export type PipsSize = "md" | "sm";

const SIZE: Record<PipsSize, string> = { md: "h-1.5 w-3", sm: "h-[5px] w-2" };

const TONE: Record<PipsTone, { off: string; on: string }> = {
  default: {
    off: "bg-[color-mix(in_oklch,var(--ink)_14%,transparent)]",
    on: "bg-accent",
  },
  inverse: {
    off: "bg-[color-mix(in_oklch,var(--btn-ink)_30%,transparent)]",
    on: "bg-[var(--btn-ink)]",
  },
};

function clampRung(n: number): Rung {
  return Math.min(5, Math.max(0, Math.round(n))) as Rung;
}

export type PipsProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  rung: number;
  tone?: PipsTone;
  size?: PipsSize;
  /** Rung before this session; pips above it up to `rung` show as new. */
  newFrom?: number;
};

export function Pips({
  rung,
  tone = "default",
  size = "md",
  newFrom,
  className = "",
  ...rest
}: PipsProps) {
  const r = clampRung(rung);
  const from = newFrom === undefined ? r : clampRung(newFrom);
  const t = TONE[tone];
  return (
    <span
      aria-hidden="true"
      {...rest}
      data-rung={r}
      className={`inline-flex gap-[3px] align-middle ${className}`}
    >
      {[1, 2, 3, 4, 5].map((k) => {
        const state = k <= from ? "on" : k <= r ? "new" : "off";
        const bg = state === "on" ? t.on : state === "new" ? "bg-ink" : t.off;
        return (
          <i
            key={k}
            data-state={state}
            className={`block rounded-[2px] ${SIZE[size]} ${bg}`}
          />
        );
      })}
    </span>
  );
}

const DOT: Record<Rung, string> = {
  0: "bg-paper border-[1.5px] border-dashed border-ink-3",
  1: "bg-sky border border-solid border-line",
  2: "bg-sky border border-solid border-line",
  3: "bg-butter border border-solid border-line",
  4: "bg-butter border border-solid border-line",
  5: "bg-mint border border-solid border-line",
};

export type RungDotProps = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  rung: number;
};

/** One concept's dot: dashed when not started, sky, butter, then mint. */
export function RungDot({ rung, className = "", ...rest }: RungDotProps) {
  const r = clampRung(rung);
  return (
    <i
      {...rest}
      data-rung={r}
      className={`block size-3.5 flex-none rounded-full ${DOT[r]} ${className}`}
    />
  );
}
