"use client";

/**
 * Study days: the exam page rail card with this week's seven day dots, the
 * sentence from `weekOf`, and the weeks-in-a-row line.
 * Source: prototype main-flow.html JS 2792-2801 (weekHTML), the rail part of
 * 2903-2949 (.rcard "STUDY DAYS"), CSS 461 (.rcard), 1123-1134 (.wk-*), and
 * 3499-3500 (today's dot pops in after a session).
 *
 * Plain props: the page passes the `Week` from `weekOf` plus the numbers from
 * `weeksInARow` and `freeSkipsLeft` (src/lib/study/week.ts). Dots:
 *  - done: accent fill with a check; today done keeps the ink ring.
 *  - today: empty dot with the ink ring and a bold label.
 *  - future: dashed dot.
 *  - missed: plain empty dot (as in the prototype).
 * `popToday` springs today's dot in from 20 %. Calm: a 150 ms fade. Instant:
 * nothing. Change the component's `key` to play it again.
 */
import { motion, type MotionProps } from "motion/react";
import { useId } from "react";
import { calmDuration } from "@/lib/motion/tokens";
import { useMotionMode, type MotionMode } from "@/lib/motion/use-calm";
import { streakLine, type DayDot, type Week } from "@/lib/study/week";

export type StudyDaysProps = {
  week: Week;
  /** From `weeksInARow`. */
  weeksInARow: number;
  /** From `freeSkipsLeft`. */
  freeSkipsLeft: number;
  /** Spring today's dot in (after a session that counted today). */
  popToday?: boolean;
  /** Seconds before the pop starts. Default 0. */
  popDelay?: number;
  className?: string;
};

const CARD = "rounded-[20px] border border-solid border-line bg-surface p-4";

const LABEL =
  "mono mb-2.5 font-medium uppercase tracking-[0.04em] text-ink-3 [font-variation-settings:normal]";

function popProps(mode: MotionMode, delay: number): MotionProps {
  if (mode === "instant") return { initial: false };
  if (mode === "calm") {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      transition: { duration: calmDuration, ease: "linear", delay },
    };
  }
  return {
    initial: { scale: 0.2 },
    animate: { scale: 1 },
    transition: { type: "spring", bounce: 0.55, visualDuration: 0.38, delay },
  };
}

function dotClass(d: DayDot): string {
  const base =
    "grid size-[30px] place-items-center rounded-full border text-[var(--accent-ink)]";
  const fill = d.state === "done" ? "border-accent bg-accent" : "border-line bg-paper";
  const dashed = d.state === "future" ? " border-dashed" : " border-solid";
  const ring = d.isToday ? " shadow-[0_0_0_2px_var(--surface),0_0_0_3.5px_var(--ink)]" : "";
  return `${base} ${fill}${dashed}${ring}`;
}

function Check() {
  return (
    <svg className="ic !size-3.5 [stroke-width:2.2]" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 12.5l4 4L18 8" />
    </svg>
  );
}

export function StudyDays({
  week,
  weeksInARow,
  freeSkipsLeft,
  popToday = false,
  popDelay = 0,
  className,
}: StudyDaysProps) {
  const labelId = useId();
  const mode = useMotionMode();
  const pop = popToday ? popProps(mode, popDelay) : { initial: false as const };

  return (
    <section className={className ? `${CARD} ${className}` : CARD} aria-labelledby={labelId}>
      <h2 id={labelId} className={LABEL}>
        Study days
      </h2>
      <div
        className="grid grid-cols-7 gap-1"
        role="img"
        aria-label={`Studied ${week.count} of ${week.goal} days this week`}
      >
        {week.days.map((d, i) => {
          const inner = d.state === "done" ? <Check /> : null;
          return (
            <span key={i} className="flex flex-col items-center gap-1">
              {d.isToday ? (
                <motion.span className={dotClass(d)} {...pop}>
                  {inner}
                </motion.span>
              ) : (
                <span className={dotClass(d)}>{inner}</span>
              )}
              <b
                className={
                  "mono !text-[10px] " +
                  (d.isToday ? "font-semibold text-ink" : "font-normal text-ink-3")
                }
              >
                {d.label}
              </b>
            </span>
          );
        })}
      </div>
      <p className="mt-3 text-[13px] text-ink">{week.sentence}</p>
      {streakLine(weeksInARow, freeSkipsLeft) ? (
        <p className="mono mt-1.5 flex items-center gap-1.5 !text-[11px] text-ink-3">
          <svg className="ic !size-3.5 text-accent" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2.2 1-3.6 2.2-4.6.2 1.6 1 2.6 2.3 3.1C11 9 10.6 6 12 3z" />
          </svg>
          {streakLine(weeksInARow, freeSkipsLeft)}
        </p>
      ) : null}
    </section>
  );
}
