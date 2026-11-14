"use client";

/**
 * M3-34: the "match pairs" session card (a `match` card from M3-49's format).
 * Source: prototype main-flow.html CSS 1180-1186 (.mt-grid, .mt-b, .sel, .ok,
 * .bad), JS 3201-3207 (render), 3228 (entrance), 3237 (prompt), 3301-3325
 * (pickMatch).
 *
 *   <SessionFrame actions={result ? <FeedbackStrip grade={result.grade}
 *       sub={matchSub(result.slips)} … /> : <MatchPrompt />} …>
 *     <CardMatch card={card} head={<CardHead … />} onResult={setResult} />
 *   </SessionFrame>
 *
 * Terms sit on the left, meanings on the right in the card's `order`. Tap (or
 * Tab to and press Enter on) a term, then its meaning. A right pair turns mint,
 * bumps and is disabled; focus moves to the next open term. A wrong pair gets a
 * due border on blush, shakes, and clears after 420 ms; it counts a slip.
 * Tapping a meaning with no term picked wiggles it. When every pair is done,
 * `onResult` is called once: grade 3 with no slips, else grade 2, and the
 * parent shows the feedback strip with `matchSub(slips)`.
 *
 * Reduced motion: no shake, bump, wiggle or rise; colours still change. The
 * instant test switch (?fast=1) skips motion. Presentational: no fetching.
 */
import { animate, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";
import type { MatchCard } from "@/lib/study/card-schema";

export const MATCH_PROMPT = "Tap a term, then what it means.";
/** How long a wrong pair stays marked. */
export const WRONG_MS = 420;
const SHAKE_MS = 240;
const BUMP_MS = 260;
const WIGGLE_MS = 400;

export type MatchResult = {
  /** Wrong pairs tried before all were matched. */
  slips: number;
  /** 3 with no slips, 2 with any. */
  grade: 2 | 3;
};

export function matchGrade(slips: number): 2 | 3 {
  return slips > 0 ? 2 : 3;
}

/** The feedback strip's sub line: "2 slips. Close enough to move on.", none without slips. */
export function matchSub(slips: number): string | undefined {
  if (slips <= 0) return undefined;
  return `${slips} ${slips === 1 ? "slip" : "slips"}. Close enough to move on.`;
}

export type CardMatchProps = {
  card: Pick<MatchCard, "q" | "pairs" | "order">;
  /** The shared card head (section label, concept, menu). */
  head?: ReactNode;
  /** Called once, when the last pair is matched. */
  onResult?: (result: MatchResult) => void;
  /** Previews: pairs already matched (pair indexes). A full set does not call `onResult`. */
  initialMatched?: readonly number[];
  /** Previews: slips so far. */
  initialSlips?: number;
  /** Previews: the term picked (pair index). */
  initialSelected?: number;
  /** Previews: a wrong pair held on screen, [term, meaning] as pair indexes. Clears on the next tap. */
  initialWrong?: readonly [number, number];
  className?: string;
};

/** Footer line before she is done. Goes in the session frame's `actions`. */
export function MatchPrompt() {
  return (
    <p className="grid min-h-[52px] place-items-center text-[13px] text-ink-3" data-testid="match-prompt">
      {MATCH_PROMPT}
    </p>
  );
}

type Wrong = { l: number; r: number };

export function CardMatch({
  card,
  head,
  onResult,
  initialMatched,
  initialSlips = 0,
  initialSelected,
  initialWrong,
  className = "",
}: CardMatchProps) {
  const mode = useMotionMode();
  const full = mode === "full";
  const n = card.pairs.length;
  const inRange = (i: number | undefined): i is number => i !== undefined && Number.isInteger(i) && i >= 0 && i < n;
  const order = card.order.length === n ? card.order : card.pairs.map((_, i) => i);

  const [matched, setMatched] = useState<ReadonlySet<number>>(() => new Set((initialMatched ?? []).filter(inRange)));
  const [selected, setSelected] = useState<number | null>(
    inRange(initialSelected) && !matched.has(initialSelected) ? initialSelected : null,
  );
  const [wrong, setWrong] = useState<Wrong | null>(
    initialWrong && inRange(initialWrong[0]) && inRange(initialWrong[1]) ? { l: initialWrong[0], r: initialWrong[1] } : null,
  );
  const startSlips = Math.max(0, Math.floor(initialSlips));
  const slips = useRef(startSlips);
  const [slipCount, setSlipCount] = useState(startSlips);
  const reported = useRef(matched.size === n);

  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  const terms = useRef(new Map<number, HTMLButtonElement>());
  const meanings = useRef(new Map<number, HTMLButtonElement>());
  const wrongTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (wrongTimer.current) clearTimeout(wrongTimer.current);
  }, []);

  const play = useCallback(
    (el: HTMLElement | undefined, kind: "shake" | "bump" | "wiggle") => {
      if (!el || !full) return;
      if (kind === "shake") {
        animate(el, { x: [0, -5, 5, -3, 0] }, { duration: SHAKE_MS / 1000, ease: "linear", times: [0, 0.25, 0.5, 0.75, 1] });
      } else if (kind === "bump") {
        animate(el, { scale: [1, 1.05, 1] }, { duration: BUMP_MS / 1000, ease: ease.out, times: [0, 0.4, 1] });
      } else {
        animate(el, { rotate: [0, -3, 3, 0] }, { duration: WIGGLE_MS / 1000, ease: ease.out, times: [0, 0.3, 0.65, 1] });
      }
    },
    [full],
  );

  const clearWrong = () => {
    if (wrongTimer.current) clearTimeout(wrongTimer.current);
    wrongTimer.current = null;
  };

  const pickTerm = (k: number) => {
    if (reported.current || matched.has(k)) return;
    if (wrong && !wrongTimer.current) setWrong(null); // a held preview state
    setSelected((s) => (s === k ? null : k));
  };

  const pickMeaning = (k: number) => {
    if (reported.current || matched.has(k)) return;
    if (wrong && !wrongTimer.current) setWrong(null);
    if (selected === null) {
      play(meanings.current.get(k), "wiggle");
      return;
    }
    const l = selected;
    setSelected(null);
    if (l === k) {
      const next = new Set(matched).add(k);
      setMatched(next);
      if (wrong && (wrong.l === k || wrong.r === k)) {
        clearWrong();
        setWrong(null);
      }
      play(terms.current.get(k), "bump");
      play(meanings.current.get(k), "bump");
      if (next.size === n) {
        reported.current = true;
        onResultRef.current?.({ slips: slips.current, grade: matchGrade(slips.current) });
      } else {
        // The matched buttons become disabled; keep keyboard users in the left column.
        const open = card.pairs.findIndex((_, i) => !next.has(i));
        terms.current.get(open)?.focus({ preventScroll: true });
      }
      return;
    }
    slips.current += 1;
    setSlipCount(slips.current);
    clearWrong();
    setWrong({ l, r: k });
    play(terms.current.get(l), "shake");
    play(meanings.current.get(k), "shake");
    wrongTimer.current = setTimeout(() => {
      wrongTimer.current = null;
      setWrong(null);
    }, WRONG_MS);
  };

  const done = matched.size === n;

  const buttonClass = (state: "ok" | "bad" | "sel" | undefined, left: boolean) =>
    "min-h-14 w-full rounded-[14px] px-3 py-2 text-left text-[14px] leading-[1.3] text-ink " +
    "[overflow-wrap:anywhere] disabled:cursor-default " +
    (mode === "instant" ? "" : "transition-[border-color,background-color] duration-quick ease-out motion-reduce:duration-150 ") +
    (left ? "font-semibold " : "") +
    (state === "ok"
      ? "border border-solid border-mint bg-mint"
      : state === "bad"
        ? "border-2 border-solid border-due bg-accent-wash px-[11px] py-[7px] shadow-[0_2px_0_var(--line)]"
        : state === "sel"
          ? "border-2 border-solid border-ink bg-paper px-[11px] py-[7px] shadow-[0_2px_0_var(--line)]"
          : "border border-solid border-line bg-surface shadow-[0_2px_0_var(--line)] hover:border-ink-3");

  const rise = (i: number) =>
    full
      ? {
          initial: { opacity: 0, y: 6 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.2, delay: 0.08 + (i % 4) * 0.05, ease: ease.out },
        }
      : {};

  return (
    <article
      data-testid="card-match"
      data-done={done || undefined}
      data-slips={slipCount}
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

      <div
        role="group"
        aria-label="Match pairs"
        className="mt-5 grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-2"
      >
        <div className="grid content-start gap-2" data-testid="match-terms">
          {card.pairs.map(([term], k) => {
            const state = matched.has(k) ? "ok" : wrong?.l === k ? "bad" : selected === k ? "sel" : undefined;
            return (
              <motion.button
                key={k}
                type="button"
                ref={(el: HTMLButtonElement | null) => {
                  if (el) terms.current.set(k, el);
                  else terms.current.delete(k);
                }}
                data-testid={`match-term-${k}`}
                data-state={state}
                aria-pressed={state === "sel"}
                disabled={matched.has(k) || done}
                onClick={() => pickTerm(k)}
                className={buttonClass(state, true)}
                {...rise(k)}
              >
                {term}
                {state === "ok" ? <span className="sr-only"> (matched)</span> : null}
              </motion.button>
            );
          })}
        </div>
        <div className="grid content-start gap-2" data-testid="match-meanings">
          {order.map((k, i) => {
            const state = matched.has(k) ? "ok" : wrong?.r === k ? "bad" : undefined;
            return (
              <motion.button
                key={k}
                type="button"
                ref={(el: HTMLButtonElement | null) => {
                  if (el) meanings.current.set(k, el);
                  else meanings.current.delete(k);
                }}
                data-testid={`match-meaning-${k}`}
                data-state={state}
                disabled={matched.has(k) || done}
                onClick={() => pickMeaning(k)}
                className={buttonClass(state, false)}
                {...rise(n + i)}
              >
                {card.pairs[k][1]}
                {state === "ok" ? <span className="sr-only"> (matched)</span> : null}
              </motion.button>
            );
          })}
        </div>
      </div>
    </article>
  );
}
