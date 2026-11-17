"use client";

/**
 * M3-33: the "quiz me" session card (an `mcq` card from M3-49's card format).
 * Source: prototype main-flow.html CSS 700-714 (.sc-opts, .opt*, .sc-ans,
 * .sc-why, .src-chip), JS 3291-3300 (pickOpt: shake, reveal, feedback).
 *
 *   <SessionFrame actions={picked ? <FeedbackStrip … /> : <PickPrompt />} …>
 *     <CardMcq card={card} head={<CardHead … />} onResult={(r) => { … }} />
 *   </SessionFrame>
 *
 * Options are shown in a seeded order (`seed`; see src/lib/study/option-order.ts), never the
 * bundle's, whose right option comes first. They are labelled A to D in that order, and keys
 * 1 to 4 (or a tap) choose by it. The right one
 * turns mint with a drawn check; when she picked it, it also bumps. A wrong
 * pick gets a due-coloured border and shakes, and the right one is shown.
 * Then a divider draws and "Why." with the card's why and its source fades
 * up. A second pick is ignored and `onResult` is called once.
 *
 * Reduced motion: no shake, no bump, no slide; 150 ms fades. The instant test
 * switch (?fast=1) skips motion. Presentational: no fetching, no grading.
 */
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { calmDuration, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";
import type { McqCard } from "@/lib/study/card-schema";
import { shownOptions } from "@/lib/study/option-order";

export const PICK_TEXT = "Pick an answer.";
export const WHY_LABEL = "Why.";
export const OPTION_KEYS = ["A", "B", "C", "D"] as const;
export const SHAKE_MS = 220;

export type McqResult = {
  /** Index of the option she picked, in the shown order. */
  picked: number;
  /** Index of the right option, in the shown order. */
  right: number;
  correct: boolean;
  /** Grade for the session: 3 when right, 1 when missed (as the prototype). */
  grade: 1 | 3;
};

export type CardMcqProps = {
  card: Pick<McqCard, "q" | "opts" | "why" | "source">;
  /** The shared card head (section label, concept, menu). */
  head?: ReactNode;
  /** Called once, on the first pick. */
  onResult?: (result: McqResult) => void;
  /** Listen for keys 1 to 4 on the document. Default true; turn off when several cards share a page. */
  keys?: boolean;
  /** Start already answered (previews), as an index in the shown order. Does not call `onResult`. */
  initialPick?: number;
  /**
   * Seeds the order the options are shown in (the player passes card id plus session id, so the
   * order holds on reload and changes between sessions). Default: the question. `null` keeps the
   * file order (tests about one option's look, never a real card).
   */
  seed?: string | null;
  className?: string;
};

export function rightIndex(opts: readonly (readonly [string, boolean])[]): number {
  return opts.findIndex((o) => o[1]);
}

function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
}

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

/** Footer line before she picks. Goes in the session frame's `actions`. */
export function PickPrompt() {
  return (
    <p className="grid min-h-[52px] place-items-center text-[13px] text-ink-3" data-testid="mcq-pick">
      {PICK_TEXT}
    </p>
  );
}

/** "Lecture 5, slide 11" in a small paper pill with a file glyph. */
export function SourceLine({ source }: { source: string }) {
  return (
    <p className="mt-3.5 inline-flex max-w-full items-center gap-1.5 rounded-full bg-paper px-2.5 py-1 text-ink-2">
      <FileIcon />
      <span className="mono min-w-0 [overflow-wrap:anywhere]">{source}</span>
    </p>
  );
}

export function CardMcq({ card, head, onResult, keys = true, initialPick, seed, className = "" }: CardMcqProps) {
  const mode = useMotionMode();
  const full = mode === "full";
  const instant = mode === "instant";
  // Bundles put the right option first: show them shuffled, the right one carried by identity.
  // Indexes below (picked, right, keys 1 to 4, A to D) are all in this shown order.
  const fileOpts = card.opts.slice(0, OPTION_KEYS.length);
  // Pure and cheap: the same card and seed give the same order on every render.
  const opts = seed === null ? fileOpts : shownOptions(fileOpts, seed ?? card.q);
  const right = rightIndex(opts);
  const valid = (i: number | undefined): i is number => i !== undefined && i >= 0 && i < opts.length;

  const [picked, setPicked] = useState<number | null>(valid(initialPick) ? initialPick : null);
  // Animate only a pick made here, not a preview's starting state.
  const [live, setLive] = useState(false);
  const reported = useRef(valid(initialPick));
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  const pick = useCallback(
    (i: number) => {
      if (reported.current || i < 0 || i >= opts.length) return;
      reported.current = true;
      setPicked(i);
      setLive(true);
      const correct = i === right;
      onResultRef.current?.({ picked: i, right, correct, grade: correct ? 3 : 1 });
    },
    [opts.length, right],
  );

  useEffect(() => {
    if (!keys || picked !== null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > opts.length) return;
      e.preventDefault();
      pick(n - 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [keys, picked, opts.length, pick]);

  const answered = picked !== null;
  const animate = live && !instant;
  const fade = { duration: calmDuration };

  return (
    <article
      data-testid="card-mcq"
      data-answered={answered || undefined}
      className={
        "relative min-h-[280px] rounded-[24px] border border-solid border-line bg-surface px-6 py-7 " +
        "shadow-[var(--shadow-card)] " +
        className
      }
    >
      {head}
      <h2 className="mt-3.5 font-display text-[24px] leading-[1.3] font-semibold tracking-[-0.01em] [font-variation-settings:'SOFT'_100] [text-wrap:pretty] [overflow-wrap:anywhere]">
        {card.q}
      </h2>

      <div role="group" aria-label="Options" className="mt-5 grid gap-2">
        {opts.map(([text], i) => {
          const isRight = answered && i === right;
          const isWrong = answered && i === picked && i !== right;
          const bump = animate && full && isRight && picked === right;
          const shake = animate && full && isWrong;
          return (
            <motion.button
              key={i}
              type="button"
              data-testid={`mcq-opt-${i}`}
              data-state={isRight ? "right" : isWrong ? "wrong" : undefined}
              disabled={answered}
              onClick={() => pick(i)}
              aria-keyshortcuts={String(i + 1)}
              animate={
                bump
                  ? { scale: [1, 1.035, 1], x: 0 }
                  : shake
                    ? { x: [0, -6, 6, -6, 6, 0], scale: 1 }
                    : undefined
              }
              transition={
                bump
                  ? { duration: 0.32, ease: [0.3, 1.4, 0.5, 1] }
                  : { duration: SHAKE_MS / 1000, ease: "linear", times: [0, 0.2, 0.4, 0.6, 0.8, 1] }
              }
              className={
                "grid min-h-[52px] w-full grid-cols-[28px_minmax(0,1fr)_20px] items-center gap-3 rounded-2xl " +
                "border border-solid px-3.5 py-2.5 text-left text-[15px] text-ink disabled:cursor-default " +
                (instant ? "" : "transition-[border-color,background-color] duration-quick ease-out motion-reduce:duration-150 ") +
                (isRight
                  ? "border-mint bg-mint"
                  : isWrong
                    ? "border-2 border-due bg-surface px-[13px] py-[9px]"
                    : "border-line bg-surface hover:not-disabled:border-ink-3")
              }
            >
              <span
                aria-hidden="true"
                className={
                  "grid size-7 place-items-center rounded-full text-[13px] font-medium text-ink-2 " +
                  (isRight ? "bg-surface" : "bg-paper")
                }
              >
                {OPTION_KEYS[i]}
              </span>
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="sr-only">{OPTION_KEYS[i]}. </span>
                {text}
                {isRight ? <span className="sr-only"> (right answer)</span> : null}
                {isWrong ? <span className="sr-only"> (your pick)</span> : null}
              </span>
              <span aria-hidden="true" className="grid size-5 place-items-center text-ink">
                {isRight ? (
                  <svg
                    viewBox="0 0 24 24"
                    data-testid="mcq-check"
                    className="size-5 fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:2]"
                  >
                    <motion.path
                      d="M6 12.5l4 4L18 8"
                      initial={animate ? (full ? { pathLength: 0 } : { opacity: 0 }) : false}
                      animate={full ? { pathLength: 1 } : { opacity: 1 }}
                      transition={full ? { duration: 0.26, ease: ease.out, delay: 0.06 } : fade}
                    />
                  </svg>
                ) : null}
              </span>
            </motion.button>
          );
        })}
      </div>

      {answered ? (
        <div className="mt-5" data-testid="mcq-why">
          <motion.i
            aria-hidden="true"
            className="block h-0.5 origin-left rounded-[2px] bg-line"
            initial={animate ? (full ? { scaleX: 0 } : { opacity: 0 }) : false}
            animate={full ? { scaleX: 1 } : { opacity: 1 }}
            transition={full ? { duration: 0.2, ease: ease.out } : fade}
          />
          <motion.div
            className="pt-4"
            initial={animate ? (full ? { opacity: 0, y: 8 } : { opacity: 0 }) : false}
            animate={full ? { opacity: 1, y: 0 } : { opacity: 1 }}
            transition={full ? { duration: 0.24, delay: 0.2, ease: ease.out } : fade}
          >
            {card.why ? (
              <p className="text-[15px] leading-normal whitespace-pre-line [overflow-wrap:anywhere]">
                <b className="font-semibold">{WHY_LABEL}</b> {card.why}
              </p>
            ) : null}
            <SourceLine source={card.source} />
          </motion.div>
        </div>
      ) : null}
    </article>
  );
}
