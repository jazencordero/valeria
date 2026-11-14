"use client";

/**
 * Chip: a toggle pill with aria-pressed, for filters, sources and choices.
 * Source: prototype main-flow.html CSS 773-776 (.filters, .chip.filt), 828-829
 * (.chip.cal) and 854-861 (.chip, .pill, .chip.src).
 *
 * The button is 44 px tall for the touch target; the visible pill is 32 px.
 * Kinds:
 *  - "filter": course filters. Pressed fills with ink.
 *  - "source": mono file chips with an icon. Pressed darkens the border and text.
 *  - "choice": pick-one options such as calendars. Pressed gets an ink border.
 * A long label wraps inside the pill instead of running off a narrow screen.
 * `ChipRow` is the side-scrolling `.filters` row.
 */
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export type ChipKind = "filter" | "source" | "choice";

export type ChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onChange"> & {
  kind?: ChipKind;
  pressed: boolean;
  onPressedChange?: (next: boolean) => void;
  /** Leading icon, for example a file glyph on source chips. */
  icon?: ReactNode;
  children: ReactNode;
};

const PILL_KIND: Record<ChipKind, string> = {
  filter:
    "text-[13px] group-aria-pressed:border-ink group-aria-pressed:bg-ink group-aria-pressed:text-surface",
  source:
    "font-mono text-[12px] tracking-[0.02em] group-aria-pressed:border-ink-3 group-aria-pressed:text-ink " +
    "group-hover:text-ink",
  choice:
    "text-[13px] group-aria-pressed:border-ink group-aria-pressed:bg-paper group-aria-pressed:text-ink " +
    "group-aria-pressed:font-medium",
};

export function Chip({
  kind = "filter",
  pressed,
  onPressedChange,
  icon,
  className = "",
  children,
  onClick,
  type,
  ...rest
}: ChipProps) {
  return (
    <button
      type={type ?? "button"}
      {...rest}
      aria-pressed={pressed}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onPressedChange?.(!pressed);
      }}
      className={
        "group inline-flex min-h-11 max-w-full flex-none items-center rounded-full border-0 bg-transparent p-0 " +
        "text-left disabled:opacity-[0.32] " +
        className
      }
    >
      <span
        className={
          "inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full border border-solid border-line " +
          "bg-surface px-3 py-1 leading-[1.3] text-ink-2 " +
          "transition-[border-color,color,background-color] duration-quick ease-out " +
          "motion-reduce:duration-150 " +
          PILL_KIND[kind]
        }
      >
        {icon}
        <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
      </span>
    </button>
  );
}

export type ChipRowProps = HTMLAttributes<HTMLDivElement> & {
  /** Side padding the row bleeds into, so chips scroll edge to edge. Default 16 px. */
  bleed?: number;
};

export function ChipRow({ bleed = 16, className = "", style, children, ...rest }: ChipRowProps) {
  return (
    <div
      {...rest}
      style={{ marginInline: -bleed, paddingInline: bleed, ...style }}
      className={
        "flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden " + className
      }
    >
      {children}
    </div>
  );
}
