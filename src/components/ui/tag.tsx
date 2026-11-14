/**
 * Tag: a small outlined mono label such as NEW or MATTERS MOST.
 * Source: prototype main-flow.html CSS 467 (.tag) and 528 (.tag.mm).
 * Tones: "quiet" (NEW) and "strong" (MATTERS MOST, darker ink and border).
 */
import type { HTMLAttributes, ReactNode } from "react";

export type TagTone = "quiet" | "strong";

const TONE: Record<TagTone, string> = {
  quiet: "text-ink-2 border-line",
  strong: "text-ink border-ink-3",
};

export type TagProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  tone?: TagTone;
  children: ReactNode;
};

export function Tag({ tone = "quiet", className = "", children, ...rest }: TagProps) {
  return (
    <span
      {...rest}
      className={
        "inline-block rounded-full border border-solid px-1.5 py-0.5 font-mono text-[11px] " +
        "leading-[1.3] tracking-[0.02em] tabular-nums " +
        `${TONE[tone]} ${className}`
      }
    >
      {children}
    </span>
  );
}
