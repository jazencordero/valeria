/**
 * DueTag: a dot plus a mono label, for example DUE TODAY 21:00.
 * Source: prototype main-flow.html CSS 339-340 (.due-tag, .due-dot) and 434-435 (.soon).
 * Tones: "urgent" (due colour) and "soon" (calm ink).
 */
import type { HTMLAttributes, ReactNode } from "react";

export type DueTone = "urgent" | "soon";

const TEXT: Record<DueTone, string> = { urgent: "text-due", soon: "text-ink-2" };
const DOT: Record<DueTone, string> = { urgent: "bg-due", soon: "bg-ink-3" };

export type DueTagProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  tone?: DueTone;
  children: ReactNode;
};

export function DueTag({ tone = "urgent", className = "", children, ...rest }: DueTagProps) {
  return (
    <span
      {...rest}
      className={
        "inline-flex items-center gap-2 font-mono text-[12px] font-medium tracking-[0.02em] tabular-nums " +
        `${TEXT[tone]} ${className}`
      }
    >
      <span aria-hidden="true" className={`size-1.5 flex-none rounded-full ${DOT[tone]}`} />
      <span className="min-w-0">{children}</span>
    </span>
  );
}
