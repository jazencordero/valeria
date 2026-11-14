/**
 * Badge: a small count pill, as on the side nav (Assignments 3).
 * Source: prototype main-flow.html CSS 407 (.badge).
 * Cut: no rolling digits yet (M3-20 adds the number roller).
 */
import type { HTMLAttributes } from "react";

export type BadgeProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  count: number;
  /** Spoken text, for example "3 open". Defaults to the number alone. */
  label?: string;
};

export function Badge({ count, label, className = "", ...rest }: BadgeProps) {
  return (
    <span
      {...rest}
      aria-label={label}
      className={
        "inline-grid h-5 min-w-[22px] flex-none place-items-center overflow-hidden rounded-full " +
        "bg-line px-1.5 font-mono text-[11px] font-medium leading-none text-ink-2 tabular-nums " +
        className
      }
    >
      {count}
    </span>
  );
}
