"use client";

/**
 * Exam card on the Exams tab. Source: prototype main-flow.html JS 2885-2896
 * (examTabCard) and CSS 597-666 (.ecard-btn, .ecard-foot, .go, .counts, .cnt,
 * .kd), with the shared card rules (.ecard, .ec-fc, .ph-chip, .pdots, .lift).
 *
 * The whole card is one link: phase chip, title, course, when, a 48 px ring,
 * "64% forecast" with the sparkline, one dot per concept coloured by rung and
 * "N concepts", then "N new · N learning · N due" and "Open".
 *
 * `making` swaps the forecast, dots and counts for "Making your cards from N
 * lectures. Usually ready within a day." while the cards are still being made.
 *
 * Plain props: the page works out the phase, forecast, rungs and counts.
 *
 * M4-14: the card is the box the exam page opens out of and closes back
 * into. It carries `workSource(href)` and its click goes through
 * `openCardLink` (both in `@/lib/motion/shared`, which describes the whole
 * transition). A client component for that click only.
 */
import { startsLine } from "@/lib/dates";
import Link from "next/link";
import type { ComponentProps } from "react";
import { WORK_TRANSITION_CSS, openCardLink, workSource } from "@/lib/motion/shared";
import { useMotionMode } from "@/lib/motion/use-calm";
import { RungDot } from "@/components/study/pips";
import { Sparkline } from "@/components/study/sparkline";
import { Ring } from "@/components/ui/ring";
import {
  CARD,
  Chevron,
  READY_BIG,
  TITLE,
  makingLine,
  plural,
  type ExamCardSpark,
} from "./exam-card";

export type ExamTabCardConcept = { id: string; name: string; rung: number };

export type ExamCounts = { new: number; learning: number; due: number };

export type ExamTabCardProps = Omit<
  ComponentProps<typeof Link>,
  "children" | "title" | "target"
> & {
  /** Phase name, for example "Strengthen". Shown upper-case in the chip. */
  phase: string;
  title: string;
  course: string;
  when: string;
  /** Forecast shown, a whole percent. */
  forecast: number;
  spark: ExamCardSpark;
  target: number;
  concepts: readonly ExamTabCardConcept[];
  counts: ExamCounts;
  /** Cards still being made from this many lectures. */
  making?: { lectures: number };
  /** Before the study start, the day it opens ("Tue 24 Nov"): one line, no forecast or counts. */
  starts?: string;
};

const KD = "inline-block size-[7px] rounded-full";

function Count({ n, label, dot }: { n: number; label: string; dot: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <i aria-hidden="true" className={`${KD} ${dot}`} />
      <span>{n}</span> {label}
    </span>
  );
}

export function Counts({ counts }: { counts: ExamCounts }) {
  const sep = <span className="text-ink-3"> · </span>;
  return (
    <span className="mono flex flex-wrap items-center gap-1 text-ink-2">
      <Count
        n={counts.new}
        label="new"
        dot="bg-sky shadow-[0_0_0_1px_color-mix(in_oklch,var(--ink)_30%,transparent)]"
      />
      {sep}
      <Count n={counts.learning} label="learning" dot="bg-due" />
      {sep}
      <Count n={counts.due} label="due" dot="bg-accent" />
    </span>
  );
}

export function ExamTabCard({
  phase,
  title,
  course,
  when,
  forecast,
  spark,
  target,
  concepts,
  counts,
  making,
  starts,
  className = "",
  ...rest
}: ExamTabCardProps) {
  const f = Math.round(forecast);
  const mode = useMotionMode();
  const { href, onClick } = rest;
  return (
    <Link
      {...(typeof href === "string" ? workSource(href) : {})}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        openCardLink(e, mode);
      }}
      className={`block w-full text-left no-underline ${CARD} ${className}`}
    >
      <style href="ready-work-transition" precedence="default">
        {WORK_TRANSITION_CSS}
      </style>
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="mono mb-1.5 inline-block rounded-full bg-accent-wash px-2 py-0.5 text-[10px] text-ink">
            {phase.toUpperCase()}
          </span>
          <span className={`block ${TITLE}`}>{title}</span>
          <span className="mt-0.5 block text-[13px] text-ink-3">{course}</span>
          <span className="mono mt-1 block text-ink-3">{when}</span>
        </span>
        {!making && !starts && <Ring value={f} size={48} />}
      </span>

      {making ? (
        <span className="mt-3.5 block text-[15px] text-ink-2">
          {makingLine(making.lectures)}
        </span>
      ) : starts ? (
        <span className="mt-3.5 block text-[15px] text-ink-2" data-testid="starts">
          {startsLine(starts)}
        </span>
      ) : (
        <>
          <span className="flex items-end justify-between gap-3">
            <span className={`mt-3.5 block ${READY_BIG}`}>
              <span>{f}%</span> forecast
            </span>
            <Sparkline
              history={spark.history}
              forecast={spark.forecast}
              daysLeft={spark.daysLeft}
              plan={spark.plan}
              target={target}
            />
          </span>
          <span className="mt-3 flex flex-wrap items-center gap-1" aria-hidden="true" data-testid="concept-dots">
            {concepts.map((c) => (
              <RungDot key={c.id} rung={c.rung} title={c.name} />
            ))}
            <span className="mono ml-1.5 text-[11px] text-ink-3">
              {plural(concepts.length, "concept", "concepts")}
            </span>
          </span>
        </>
      )}

      <span className="mt-3.5 flex items-center justify-between gap-3">
        {making || starts ? <span /> : <Counts counts={counts} />}
        <span className="inline-flex items-center gap-0.5 text-[13px] font-semibold">
          Open
          <Chevron d="M9.5 5.5L16 12l-6.5 6.5" />
        </span>
      </span>
    </Link>
  );
}
