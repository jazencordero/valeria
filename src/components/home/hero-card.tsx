"use client";

/**
 * HeroCard: the "Do first" card on Home.
 * Source: prototype main-flow.html HTML 1439-1458 (#hero-a, #hero-c) and
 * CSS 331-345 (.hero, .hero-top, .hero-course, .hero-est, .hero .btn), 384 (.hero h3).
 *
 * Due tag plus time left, title, course and code, an estimate line (hidden when
 * there is no estimate) and a Start button linking to the assignment.
 * Tones: "urgent" (due colour, shows time left) and "soon" (calm ink, no time left).
 * Plain data in, no fetching.
 *
 * M4-13: the card is the source the assignment workspace opens out of. It
 * carries `workSource(href)` and Start calls `openWork` (both in
 * `@/lib/motion/shared`, which describes the whole transition); the
 * workspace's back arrow finds the card again by the same mark and shrinks
 * into it. A client component for that click only.
 */
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { DueTag, type DueTone } from "@/components/ui/due-tag";
import { dueLabel, minutesLabel, timeLeft, type DateInput } from "@/lib/dates";
import { WORK_TRANSITION_CSS, openWork, workSource } from "@/lib/motion/shared";
import { useMotionMode } from "@/lib/motion/use-calm";

export type HeroCardProps = {
  title: string;
  course: string;
  /** Course code, for example ISM-E1005. Empty hides it. */
  code: string;
  dueAt: DateInput;
  /** The current time; passed in so the card stays pure. */
  now: DateInput;
  tone?: DueTone;
  /** Show "5 h 12 min left" next to the due tag. Defaults to true for urgent. */
  showTimeLeft?: boolean;
  /** Estimated minutes of work. Missing or null hides the estimate line. */
  estimateMin?: number | null;
  /** Sentence after the estimate, for example "The brief and the data are ready." */
  estimateNote?: string;
  /** Where Start goes: the assignment page. */
  href: string;
  className?: string;
};

/** `about 90 min` becomes `About 90 min.` plus the optional note. */
function estimateLine(min: number, note?: string): string {
  const label = minutesLabel(min);
  const sentence = `${label.charAt(0).toUpperCase()}${label.slice(1)}.`;
  return note ? `${sentence} ${note}` : sentence;
}

export function HeroCard({
  title,
  course,
  code,
  dueAt,
  now,
  tone = "urgent",
  showTimeLeft,
  estimateMin,
  estimateNote,
  href,
  className = "",
}: HeroCardProps) {
  const titleId = useId();
  const mode = useMotionMode();
  const withTimeLeft = showTimeLeft ?? tone === "urgent";
  const hasEstimate = typeof estimateMin === "number" && estimateMin > 0;

  return (
    <article
      {...workSource(href)}
      aria-labelledby={titleId}
      className={
        "relative z-[1] rounded-[20px] border border-solid border-line bg-surface p-5 " +
        "shadow-[var(--shadow-card)] " +
        className
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <DueTag tone={tone}>{dueLabel(dueAt, now)}</DueTag>
        {withTimeLeft && <span className="mono ink-2">{timeLeft(dueAt, now)}</span>}
      </div>
      <h3 id={titleId} className="type-h22 mt-3 [overflow-wrap:anywhere]">
        {title}
      </h3>
      <p className="mt-1 text-[15px] text-ink-2">
        {course}
        {code ? (
          <>
            {" · "}
            <span className="mono-in">{code}</span>
          </>
        ) : null}
      </p>
      {hasEstimate && (
        <p className="mt-2 text-[13px] text-ink-3">{estimateLine(estimateMin, estimateNote)}</p>
      )}
      <Button href={href} block size="lg" className="mt-5" onClick={(e) => openWork(e, mode)}>
        Start
      </Button>
      <style href="ready-work-transition" precedence="default">
        {WORK_TRANSITION_CSS}
      </style>
    </article>
  );
}
