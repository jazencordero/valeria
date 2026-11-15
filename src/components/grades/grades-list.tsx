"use client";

/**
 * The Grades tab's body (M6-08): "Pulled from <LMS>. Tap a course to plan
 * it.", the overall number in a butter pill with "where you are heading, on
 * average", then one row per course: dot, name, status (On track with a
 * check, Within reach, Out of reach, Too early), "aiming for 5", the
 * trajectory number (or a muted dash) and a chevron. Each row links to the
 * course's grade page.
 *
 * Plain data in (`getGradesList`, src/server/data/grades.ts), no fetching.
 * Client code only for the open (M9-18): a row carries `workSource(href)` and
 * its click goes through `openCardLink`, so the course's grade page reveals
 * from the row (360 ms) and its back link shrinks it into the row again
 * (320 ms), with the list's scroll put back (`@/lib/motion/shared`, the
 * exam page's timings, which are the prototype's merged.html JS 6021-6074). Source: prototype merged.html HTML 1827-1830, JS 6000-6014
 * (glRowHTML, renderGradeList), CSS 1429-1446 (.g-sum, .gl-*).
 *
 * Decision: a course that is missing a weight says "Needs weights" (muted,
 * like Too early); its page shows the weights card.
 */
import Link from "next/link";
import { EXAM_PAGE, WORK_TRANSITION_CSS, openCardLink, workSource } from "@/lib/motion/shared";
import { useMotionMode } from "@/lib/motion/use-calm";
import type { CourseColor } from "@/components/shell/side-nav";
import type { GradesList, GradeStatus } from "@/server/data/grades";

/** One decimal, as the prototype's fmt1 (kept here: this file renders on the server). */
const fmt1 = (g: number) => (Math.round(g * 10) / 10).toFixed(1);

export const STATUS_LABEL: Record<GradeStatus, string> = {
  on: "On track",
  within: "Within reach",
  out: "Out of reach",
  early: "Too early",
  needs_weights: "Needs weights",
};

const STATUS_TEXT: Record<GradeStatus, string> = {
  on: "text-accent",
  within: "text-ink",
  out: "text-due",
  early: "text-ink-3",
  needs_weights: "text-ink-3",
};

const DOT: Record<CourseColor, string> = {
  butter: "bg-butter",
  mint: "bg-mint",
  sky: "bg-sky",
  blush: "bg-accent-wash",
};

const ICON =
  "flex-none fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round]";

const Check = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={`h-3.5 w-3.5 ${ICON}`} style={{ strokeWidth: 2.2 }}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

const Chevron = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={`h-5 w-5 text-ink-3 ${ICON}`} style={{ strokeWidth: 1.5 }}>
    <path d="M9.5 5.5L16 12l-6.5 6.5" />
  </svg>
);

export type GradesListProps = GradesList & {
  /** What her school calls its Moodle (`lmsNameOf(user)`). */
  lmsName: string;
};

/** The grade page's types and timings (360 ms open, 320 ms close) are the exam page's. */
const GRADE_PAGE = EXAM_PAGE;

export function GradesListView({ overall, courses, lmsName }: GradesListProps) {
  const mode = useMotionMode();
  return (
    <>
      <style href="ready-work-transition" precedence="default">
        {WORK_TRANSITION_CSS}
      </style>
      <p className="mt-1.5 text-[15px] text-ink-2">Pulled from {lmsName}. Tap a course to plan it.</p>
      <p className="mt-[18px] flex flex-wrap items-baseline gap-x-3 gap-y-1" aria-live="polite">
        <span
          data-testid="grades-overall"
          className="inline-block rounded-xl bg-butter px-2.5 py-0.5 font-display text-[30px] font-semibold leading-none text-ink [font-variation-settings:'SOFT'_100]"
        >
          {overall == null ? "–" : fmt1(overall)}
        </span>
        <span className="text-[15px] text-ink-2">where you are heading, on average</span>
      </p>

      <ul className="mt-[18px] list-none border-t border-solid border-line">
        {courses.map((c) => (
          <li key={c.id}>
            <Link
              {...workSource(c.href)}
              href={c.href}
              onClick={(e) => openCardLink(e, mode, GRADE_PAGE)}
              data-testid={`grades-row-${c.id}`}
              data-status={c.status}
              className="grid min-h-[76px] w-full grid-cols-[12px_minmax(0,1fr)_auto_20px] items-center gap-x-3.5 border-b border-solid border-line py-3 text-left text-ink no-underline"
            >
              <i
                aria-hidden="true"
                className={`inline-block h-2.5 w-2.5 rounded-full shadow-[inset_0_0_0_1px_var(--line)] ${DOT[c.color]}`}
              />
              <span className="grid min-w-0 gap-[3px]">
                <span className="truncate text-[16px] font-semibold">{c.name}</span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                  <span className={`inline-flex items-center gap-1.5 font-medium ${STATUS_TEXT[c.status]}`}>
                    {c.status === "on" ? (
                      <Check />
                    ) : (
                      <i aria-hidden="true" className="inline-block h-[7px] w-[7px] rounded-full bg-current" />
                    )}
                    {STATUS_LABEL[c.status]}
                  </span>
                  <span className="mono text-ink-3">aiming for {c.target}</span>
                </span>
              </span>
              <span
                className={
                  "font-display font-semibold leading-none [font-variation-settings:'SOFT'_100] " +
                  (c.trajectory == null ? "text-[22px] text-ink-3" : "text-[30px]")
                }
              >
                {c.trajectory == null ? (
                  <>
                    <span aria-hidden="true">–</span>
                    <span className="sr-only">no trajectory yet</span>
                  </>
                ) : (
                  <>
                    {fmt1(c.trajectory)}
                    <span className="sr-only"> on this trajectory</span>
                  </>
                )}
              </span>
              <Chevron />
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[13px] text-ink-3">
        Estimates. They assume the weights from each course&apos;s syllabus and the usual 50/60/70/80/90% grade steps.
      </p>
    </>
  );
}
