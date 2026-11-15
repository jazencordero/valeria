"use client";

/**
 * Phase strip: "WHERE YOU ARE" on the exam page. A four-part track (Learn,
 * Strengthen, Final review, Exam day), past parts in ink-3, the current part
 * in accent, the tiny cap above the track as the "you" marker, and one
 * sentence: "<Phase>. <description> <what comes next>".
 * Source: prototype main-flow.html JS 2802-2809 (phaseHTML), 3010-3012 (cap
 * drop-in), CSS 1057-1068. Phases and the marker position come from
 * src/lib/study/ladder.ts (M3-06).
 *
 * Cut: the Final review sentence does not promise a mock exam until M8-15.
 */
import { useId } from "react";
import { motion } from "motion/react";
import { Vitonen } from "@/components/vitonen";
import { useMotionMode } from "@/lib/motion/use-calm";
import { PHASES, phaseOf, phasePosition, type Phase } from "@/lib/study/ladder";

/** ladder.ts says "Your weakest concepts and a mock exam."; the mock exam waits for M8-15. */
const FINAL_REVIEW_NOW = "Your weakest concepts, one more time.";

/**
 * ladder.ts says "A 10-card warm-up. Nothing new." for exam day. That is true where the plan
 * stops new cards before the exam (a paced exam); elsewhere an exam-day bite can still bring
 * new cards, so only the half that is true is said.
 */
const EXAM_DAY_WITH_NEW = "A short warm-up.";

function descriptionOf(phase: Phase, nothingNew: boolean): string {
  if (phase.index === 3 && !nothingNew) return EXAM_DAY_WITH_NEW;
  return phase.index === 2 ? FINAL_REVIEW_NOW : phase.description;
}

export type PhaseStripProps = {
  /** Whole days until the exam. 0 is exam day. */
  daysLeft: number;
  /** What comes next, for example "Final review starts Tue 17." Empty on exam day. */
  next?: string;
  /** False when exam-day bites can still bring new cards: the sentence then leaves "Nothing new." out. Default true. */
  nothingNewOnExamDay?: boolean;
  className?: string;
};

export function PhaseStrip({ daysLeft, next, nothingNewOnExamDay = true, className = "" }: PhaseStripProps) {
  const labelId = useId();
  const mode = useMotionMode();
  const animate = mode === "full";
  const phase = phaseOf(daysLeft);
  const pi = phase.index;
  const pos = phasePosition(daysLeft);

  return (
    <section aria-labelledby={labelId} className={className}>
      <h2
        id={labelId}
        className="mono mb-3 font-medium uppercase tracking-[0.04em] text-ink-3 [font-variation-settings:normal]"
      >
        WHERE YOU ARE
      </h2>
      <div className="rounded-[20px] border border-line p-4">
        <div
          className="relative flex gap-1 pt-[30px]"
          role="img"
          aria-label={`Four phases: Learn, Strengthen, Final review, Exam day. You are in ${phase.name}.`}
        >
          {PHASES.map((p, i) => {
            const now = i === pi;
            const past = i < pi;
            return (
              <span
                key={p.name}
                className="flex min-w-0 flex-col gap-1.5"
                style={{ flex: p.width }}
                aria-hidden="true"
              >
                <i
                  className={`block h-2 rounded-full ${
                    now ? "bg-accent" : past ? "bg-ink-3" : "bg-line"
                  }`}
                />
                <b
                  className={`mono overflow-hidden text-ellipsis whitespace-nowrap text-[10px] ${
                    now ? "font-semibold text-ink" : "font-normal text-ink-3"
                  }`}
                >
                  {p.name.toUpperCase()}
                </b>
              </span>
            );
          })}
          <span
            className="absolute top-0 -translate-x-1/2 leading-[0]"
            style={{ left: `${pos}%` }}
            aria-hidden="true"
            data-testid="phase-you"
          >
            <motion.span
              className="relative inline-block leading-[0] after:absolute after:bottom-[-6px] after:left-1/2 after:-ml-px after:h-1.5 after:w-0.5 after:rounded-[2px] after:bg-ink after:content-['']"
              initial={animate ? { opacity: 0, y: -14 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", bounce: 0.4, visualDuration: 0.36, delay: 0.3 }}
            >
              <Vitonen size={24} />
            </motion.span>
          </span>
        </div>
        <p className="mt-3 text-[13px] text-ink-2">
          <b className="text-ink">{phase.name}.</b> {descriptionOf(phase, nothingNewOnExamDay)}
          {next ? <span className="text-ink-3"> {next}</span> : null}
        </p>
      </div>
    </section>
  );
}
