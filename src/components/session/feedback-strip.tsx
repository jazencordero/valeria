"use client";

/**
 * M3-33: the feedback strip a self-marking card shows after an answer, with
 * Continue. Source: prototype main-flow.html CSS 1187-1195 (.fb*), JS 3359-3373
 * (showFeedback).
 *
 *   <SessionFrame actions={<FeedbackStrip grade={3} concept="Price elasticity"
 *     passed={passedSoFar} boss={card.boss} onContinue={next} />} …>
 *
 * Heading (`feedbackCopy`):
 *   grade 3, boss         "Boss down."
 *   grade 3               "Nice." / "Exactly." / "Yes." / "Spot on." by `passed` % 4
 *   grade 2               "Got there."   (a pass with slips)
 *   grade 1               "Not quite."
 * Sub line: a pass on a boss card "That is how the exam asks it.", another
 * pass "+ <concept>", a miss "It comes back in a minute."; `sub` overrides it.
 *
 * Slides up in 180 ms, mint when passed and blush when missed; on a pass the
 * check bumps in. Continue (or Enter or Space anywhere) calls `onContinue`,
 * once. Continue takes focus. No auto-advance. Reduced motion: a 150 ms fade,
 * no slide, no bump; the instant switch: no motion.
 */
import { motion } from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { calmDuration, duration, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

export const PASS_HEADS = ["Nice.", "Exactly.", "Yes.", "Spot on."] as const;
export const BOSS_HEAD = "Boss down.";
export const SLIPS_HEAD = "Got there.";
export const MISS_HEAD = "Not quite.";
export const BOSS_SUB = "That is how the exam asks it.";
export const MISS_SUB = "It comes back in a minute.";
export const CONTINUE_TEXT = "Continue";
export const CONTINUE_HINT = "Enter to continue";

/** 3 right first time, 2 right with slips, 1 missed. */
export type FeedbackGrade = 1 | 2 | 3;

export type FeedbackInput = {
  grade: FeedbackGrade;
  /** Concept name for "+ <concept>". */
  concept: string;
  /** Cards passed so far in this session; picks which pass heading shows. */
  passed?: number;
  boss?: boolean;
  /** Overrides the sub line. */
  sub?: string;
};

export function feedbackCopy({ grade, concept, passed = 0, boss = false, sub }: FeedbackInput): {
  ok: boolean;
  head: string;
  line: string;
} {
  const ok = grade >= 2;
  const n = Math.max(0, Math.floor(passed));
  const head = ok ? (grade === 3 ? (boss ? BOSS_HEAD : PASS_HEADS[n % PASS_HEADS.length]) : SLIPS_HEAD) : MISS_HEAD;
  const line = sub ?? (ok ? (boss ? BOSS_SUB : `+ ${concept}`) : MISS_SUB);
  return { ok, head, line };
}

export type FeedbackStripProps = FeedbackInput & {
  onContinue: () => void;
  /** Listen for Enter and Space on the document. Default true. */
  keys?: boolean;
  /** Move focus to Continue on mount. Default true. */
  autoFocus?: boolean;
  /** Show "Enter to continue" under the button. The session frame has its own hint row; default false. */
  hint?: boolean;
  className?: string;
};

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[18px] fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:2.2]">
    <path d="M6 12.5l4 4L18 8" />
  </svg>
);

const CrossIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[18px] fill-none stroke-current [stroke-linecap:round] [stroke-width:2.2]">
    <path d="M8 8l8 8M16 8l-8 8" />
  </svg>
);

function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
}

export function FeedbackStrip({
  onContinue,
  keys = true,
  autoFocus = true,
  hint = false,
  className = "",
  ...input
}: FeedbackStripProps) {
  const mode = useMotionMode();
  const full = mode === "full";
  const instant = mode === "instant";
  const { ok, head, line } = feedbackCopy(input);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const done = useRef(false);
  const onContinueRef = useRef(onContinue);
  useEffect(() => {
    onContinueRef.current = onContinue;
  }, [onContinue]);

  const go = useCallback(() => {
    if (done.current) return;
    done.current = true;
    onContinueRef.current();
  }, []);

  useEffect(() => {
    if (autoFocus) buttonRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return;
      // Another button with focus (the card menu, say) keeps its own Enter and Space.
      if (e.target instanceof HTMLElement && e.target !== buttonRef.current && e.target.closest("button, a[href]")) return;
      e.preventDefault();
      go();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [keys, go]);

  return (
    <div className={className} data-testid="feedback">
      <motion.div
        role="status"
        data-testid="fb-strip"
        data-ok={ok || undefined}
        className={"mb-2.5 flex items-center gap-3 rounded-[18px] px-3.5 py-3 " + (ok ? "bg-mint" : "bg-accent-wash")}
        initial={instant ? false : full ? { opacity: 0, y: 14 } : { opacity: 0 }}
        animate={full ? { opacity: 1, y: 0 } : { opacity: 1 }}
        transition={full ? { duration: duration.quick, ease: ease.out } : { duration: calmDuration }}
      >
        <motion.span
          className={"grid size-9 flex-none place-items-center rounded-full bg-surface " + (ok ? "text-accent" : "text-due")}
          initial={ok && full ? { scale: 0.4 } : false}
          animate={{ scale: 1 }}
          transition={{ type: "spring", bounce: 0.45, duration: 0.3, delay: 0.08 }}
        >
          {ok ? <CheckIcon /> : <CrossIcon />}
        </motion.span>
        <div className="min-w-0">
          <p
            data-testid="fb-head"
            className="font-display text-[18px] leading-[1.2] font-semibold [font-variation-settings:'SOFT'_100]"
          >
            {head}
          </p>
          <p data-testid="fb-sub" className="text-[13px] text-ink-2 [overflow-wrap:anywhere]">
            {line}
          </p>
        </div>
      </motion.div>
      <Button ref={buttonRef} size="lg" block onClick={go} data-testid="fb-continue">
        {CONTINUE_TEXT}
      </Button>
      {hint ? <p className="mt-2 hidden text-center text-[13px] text-ink-3 min-[700px]:block">{CONTINUE_HINT}</p> : null}
    </div>
  );
}
