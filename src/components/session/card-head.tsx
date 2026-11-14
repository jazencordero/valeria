"use client";

/**
 * Shared pieces of the session cards (M3-32): the card surface, its head
 * (section label, concept names, pips), the revealed-answer block, the source
 * chip, the Space-to-reveal key and the main front button.
 * Source: prototype main-flow.html JS 3181-3188 (srcChip, sc-head), 3212
 * (sc-ans), 3232-3250 (renderFrontActions, revealAnswer); CSS 694-715, 757-758
 * and 1169-1176 (.sc, .sc-head, .sc-sec, .sec-*, .sc-ans, .src-chip).
 */
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Doodle } from "@/components/doodle";
import { Pips } from "@/components/study/pips";
import { Button } from "@/components/ui/button";
import { SECTION_LABEL } from "@/components/session/frame";
import { calmDuration, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";
import type { SectionKind } from "@/lib/study/bite";

/** Footer hint for recall and fill-the-gap cards. `two`: the two-button grade mode. */
export function revealHint(two = false): string {
  return `Space to reveal · ${two ? "1 or 2" : "1–4"} to grade`;
}

/** What every front-side card takes besides its card body. */
export type SessionCardProps = {
  /** Which part of the bite the card is in; "boss" gets the crown and no pips. */
  section: SectionKind;
  /** Display names of the card's concepts, primary first. */
  conceptNames: readonly string[];
  /** The primary concept's ladder rung, 0 to 5. */
  rung: number;
  /** Called once, when the whole answer is showing: the parent shows grade buttons. */
  onRevealed: () => void;
  /** Listen for Space on the document (default true). Turn off when more than one card is on screen. */
  keyboard?: boolean;
  /** Focus the main button on mount, as the session does. */
  autoFocus?: boolean;
  /**
   * Where the main button goes, e.g. a node inside the frame's `actions`.
   * Omitted or null: right under the card.
   */
  actionsEl?: Element | null;
  className?: string;
};

export function CardHead({
  section,
  conceptNames,
  rung,
}: Pick<SessionCardProps, "section" | "conceptNames" | "rung">) {
  const boss = section === "boss";
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="mono flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-3" data-testid="sc-label">
        <span
          data-section={section}
          className={
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium " +
            (boss
              ? "bg-accent text-[var(--accent-ink)] [&_.doodle_path]:[stroke:var(--accent-ink)]"
              : section === "warm"
                ? "bg-butter text-ink"
                : "bg-sky text-ink")
          }
        >
          {boss ? <Doodle name="crown" size={18} /> : null}
          {SECTION_LABEL[section]}
        </span>
        {conceptNames.join(" + ").toUpperCase()}
      </p>
      {boss ? null : <Pips rung={rung} size="sm" />}
    </div>
  );
}

/** The card itself: a surface with the head on top. */
export function CardSurface({
  section,
  conceptNames,
  rung,
  className = "",
  children,
}: Pick<SessionCardProps, "section" | "conceptNames" | "rung" | "className"> & { children: ReactNode }) {
  const boss = section === "boss";
  return (
    <article
      aria-live="polite"
      data-section={section}
      className={
        "relative z-[2] min-h-[280px] rounded-[24px] px-6 py-7 min-[700px]:px-10 min-[700px]:py-9 " +
        (boss
          ? "border-2 border-solid border-accent bg-[linear-gradient(180deg,var(--accent-wash),var(--surface)_140px)] shadow-[var(--shadow-lift)] "
          : "border border-solid border-line bg-surface shadow-[var(--shadow-card)] ") +
        className
      }
    >
      <CardHead section={section} conceptNames={conceptNames} rung={rung} />
      {children}
    </article>
  );
}

/** Question type, shared by both cards. */
export const QUESTION_CLASS =
  "mt-3.5 font-display text-[24px] leading-[1.3] font-semibold tracking-[-0.01em] [font-variation-settings:'SOFT'_100] [text-wrap:pretty] min-[700px]:text-[26px]";

const FileIcon = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className="size-3.5 flex-none fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.75]"
  >
    <path d="M7 3.5h6.5L18 8v12.5H7z" />
    <path d="M13.5 3.5V8H18" />
  </svg>
);

/** Where the card comes from, e.g. "Lecture 5, slide 11". */
export function SourceChip({ source }: { source: string }) {
  return (
    <p
      className="mt-3.5 inline-flex items-center gap-1.5 rounded-full bg-paper px-2.5 py-1 text-ink-2"
      data-testid="src-chip"
    >
      <FileIcon />
      <span className="mono">{source}</span>
    </p>
  );
}

/** The answer block under the question: a divider that draws in, then the content. */
export function RevealedAnswer({ children }: { children: ReactNode }) {
  const mode = useMotionMode();
  const full = mode === "full";
  const instant = mode === "instant";
  return (
    <div className="mt-5" data-testid="sc-ans">
      <motion.span
        aria-hidden="true"
        className="block h-0.5 origin-left rounded-[2px] bg-line"
        initial={full ? { scaleX: 0 } : false}
        animate={{ scaleX: 1 }}
        transition={{ duration: 0.2, ease: ease.out }}
      />
      <motion.div
        className="pt-4"
        initial={instant ? false : full ? { opacity: 0, y: 8 } : { opacity: 0 }}
        animate={{ opacity: 1, y: 0 }}
        transition={full ? { duration: 0.24, delay: 0.2, ease: ease.out } : { duration: calmDuration }}
      >
        {children}
      </motion.div>
    </div>
  );
}

function isOtherControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("button, a[href], input, textarea, select, summary, [role='button'], [role='menuitem']")) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * Space reveals, unless focus is on a button, link or field (that control's
 * own Space wins, which also covers the main button itself).
 */
export function useSpaceToReveal(active: boolean, reveal: () => void): void {
  const latest = useRef(reveal);
  useEffect(() => {
    latest.current = reveal;
  });
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " || e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isOtherControl(e.target)) return;
      e.preventDefault();
      latest.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active]);
}

/** Calls `onRevealed` at most once per mounted card. */
export function useOnce(fn: () => void): () => void {
  const fired = useRef(false);
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  return useCallback(() => {
    if (fired.current) return;
    fired.current = true;
    latest.current();
  }, []);
}

/** The big primary button in the footer ("Show answer", "Show next word"). */
export function MainAction({
  label,
  onClick,
  buttonRef,
  actionsEl,
}: {
  label: string;
  onClick: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  actionsEl?: Element | null;
}) {
  const button = (
    <Button ref={buttonRef} variant="primary" size="lg" block onClick={onClick}>
      {label}
    </Button>
  );
  if (actionsEl) return createPortal(button, actionsEl);
  return <div className="mt-6">{button}</div>;
}
