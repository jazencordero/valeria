"use client";

/**
 * Button. Source: prototype main-flow.html CSS 172-204 (.btn, .btn-*, .icon-btn,
 * .swap, .spinner) and JS 1996-2018 (press physics).
 *
 * Press physics: scales to 0.97 on pointer down (90 ms, out) and springs back
 * (bounce 0.3, 180 ms). Off when calm or in the instant test mode.
 * Loading: the label cross-fades to a spinner plus `loadingLabel`, as on Connect.
 * Pass `href` to render a Next.js link that looks like the button.
 */
import Link from "next/link";
import { motion, type HTMLMotionProps } from "motion/react";
import type { ReactNode } from "react";
import { ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

export type ButtonVariant = "primary" | "secondary" | "text" | "icon";
export type ButtonSize = "sm" | "md" | "lg";

type Common = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full width. */
  block?: boolean;
  /** Swaps the label for a spinner plus `loadingLabel`; blocks clicks. */
  loading?: boolean;
  /** Text shown next to the spinner while loading. Defaults to the label. */
  loadingLabel?: ReactNode;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
  /** Required for the icon variant, which has no visible text. */
  "aria-label"?: string;
};

type AsButton = Common &
  Omit<HTMLMotionProps<"button">, keyof Common | "href"> & { href?: undefined };

type AsLink = Common & {
  href: string;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  target?: string;
  rel?: string;
  id?: string;
};

export type ButtonProps = AsButton | AsLink;

const MotionLink = motion.create(Link);

const BASE =
  "relative inline-flex select-none items-center justify-center gap-2 rounded-full border-0 " +
  "transition-[box-shadow,background-color,border-color,color,opacity] duration-quick ease-out " +
  "disabled:cursor-default aria-disabled:cursor-default";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "mb-[3px] bg-[var(--btn)] text-[var(--btn-ink)] font-semibold shadow-[0_3px_0_var(--btn-ledge)] " +
    "active:shadow-[0_1px_0_var(--btn-ledge)] " +
    "hover:not-disabled:not-aria-disabled:bg-[color-mix(in_oklch,var(--btn)_88%,var(--ink-2))] " +
    "disabled:opacity-[0.32] disabled:shadow-[0_3px_0_var(--btn-ledge)]",
  secondary:
    "mb-[2px] border border-solid border-line bg-surface text-ink font-semibold shadow-[0_2px_0_var(--line)] " +
    "active:shadow-[0_1px_0_var(--line)] hover:not-disabled:border-ink-3 " +
    "disabled:opacity-[0.32] disabled:shadow-[0_2px_0_var(--line)]",
  text:
    "bg-transparent text-ink-2 font-medium hover:not-disabled:text-ink disabled:opacity-[0.32]",
  icon:
    "flex-none bg-transparent text-ink hover:not-disabled:bg-paper disabled:opacity-[0.32] " +
    "[&_svg]:size-5",
};

// Text buttons. sm is visually 36 px; an invisible ring keeps the 44 px target.
const SIZE: Record<ButtonSize, string> = {
  sm: "min-h-9 px-4 text-[14px] before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']",
  md: "min-h-11 px-[22px] text-[15px]",
  lg: "min-h-[52px] px-[26px] text-[17px]",
};

const ICON_SIZE: Record<ButtonSize, string> = {
  sm: "size-9 before:absolute before:-inset-1 before:content-['']",
  md: "size-11",
  lg: "size-[52px]",
};

function Spinner({ calm }: { calm: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={
        "size-4 flex-none fill-none stroke-current [stroke-linecap:round] [stroke-width:1.5] " +
        (calm ? "animate-pulse" : "animate-spin [animation-duration:0.8s]")
      }
    >
      <circle cx="8" cy="8" r="6" strokeDasharray="26 40" />
    </svg>
  );
}

export function Button(props: ButtonProps) {
  const {
    variant = "primary",
    size = "md",
    block = false,
    loading = false,
    loadingLabel,
    disabled = false,
    className = "",
    children,
    ...rest
  } = props;
  const mode = useMotionMode();
  const press = mode === "full" && !disabled && !loading;

  const classes = [
    BASE,
    VARIANT[variant],
    variant === "icon" ? ICON_SIZE[size] : SIZE[size],
    block ? "w-full" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const motionProps = {
    whileTap: press
      ? { scale: 0.97, transition: { duration: 0.09, ease: ease.out } }
      : undefined,
    transition: { type: "spring" as const, bounce: 0.3, duration: 0.18 },
  };

  const fadeMs = mode === "instant" ? "duration-0" : mode === "calm" ? "duration-150" : "duration-quick";
  const content =
    variant === "icon" ? (
      loading ? <Spinner calm={mode !== "full"} /> : children
    ) : (
      <span className="grid place-items-center">
        <span
          className={`col-start-1 row-start-1 inline-flex items-center gap-2 whitespace-nowrap transition-opacity ease-out ${fadeMs} ${loading ? "opacity-0" : "opacity-100"}`}
          aria-hidden={loading || undefined}
        >
          {children}
        </span>
        <span
          className={`col-start-1 row-start-1 inline-flex items-center gap-2.5 whitespace-nowrap transition-opacity ease-out ${fadeMs} ${loading ? "opacity-100" : "opacity-0"}`}
          aria-hidden={!loading || undefined}
        >
          <Spinner calm={mode !== "full"} />
          {loadingLabel ?? children}
        </span>
      </span>
    );

  if (rest.href !== undefined && !disabled) {
    const { href, ...linkRest } = rest as AsLink;
    return (
      <MotionLink
        href={href}
        {...linkRest}
        {...motionProps}
        className={classes}
        aria-disabled={loading || undefined}
        aria-busy={loading || undefined}
        onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
          if (loading) {
            e.preventDefault();
            return;
          }
          linkRest.onClick?.(e);
        }}
      >
        {content}
      </MotionLink>
    );
  }

  const { onClick, type, ...buttonRest } = rest as AsButton;
  return (
    <motion.button
      type={type ?? "button"}
      {...buttonRest}
      {...motionProps}
      className={classes}
      disabled={disabled}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      onClick={(e) => {
        if (loading) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      {content}
    </motion.button>
  );
}
