"use client";

/**
 * Exam card on Home. Source: prototype main-flow.html JS 2869-2884 (examCard)
 * and CSS 597-666 (.title-btn), with the shared card rules it points at
 * (.ecard, .ecard-top, .ecard-title, .ec-fc, .ready-big, .ed-sub, .verdict,
 * .disc, .tps / .tp, .ed-foot, .lift).
 *
 * Top: the title as a button (opens the exam), course, when, and a 48 px
 * ring. Then "64% forecast" with the sparkline, "If it were today. A 4 needs
 * 80%." (or "The target is 80%." when no grade is known), the verdict, and a "Concepts" disclosure listing each concept with
 * its icon, rung pips and rung name, plus the foot line. Exams (not quizzes)
 * end with "Today's bite · 5 min", or "Open the exam" when there is no bite.
 *
 * `making` swaps the forecast block for "Making your cards from N lectures.
 * Usually ready within a day." while the cards are still being made, and
 * `starts` swaps it for "Starts Tue 24 Nov. Nothing to do here until then."
 * before the exam's study start.
 *
 * Plain props: the page works out the forecast, verdict, rungs and minutes.
 *
 * M4-14: the card is the box the exam page opens out of and closes back
 * into. It carries `workSource` (a name for this card, since it does not know
 * the exam's path) and the two buttons that open the exam go through
 * `openCardPage` (both in `@/lib/motion/shared`, which describes the whole
 * transition). Today's bite starts a session and is a plain button.
 */
import { useId, useState, type HTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { WORK_SOURCE_ATTR, WORK_TRANSITION_CSS, openCardPage, workSource } from "@/lib/motion/shared";
import { startsLine } from "@/lib/dates";
import { useMotionMode } from "@/lib/motion/use-calm";
import { Ring } from "@/components/ui/ring";
import { Button } from "@/components/ui/button";
import { Pips, RUNG_NAMES } from "@/components/study/pips";
import { Sparkline } from "@/components/study/sparkline";

export type ExamKind = "exam" | "quiz";

export type ExamCardConcept = {
  id: string;
  name: string;
  /** Rung 0..5 on the study ladder. */
  rung: number;
  /** The concept's icon, drawn at 16 px inside a 26 px tile. */
  icon?: ReactNode;
};

export type ExamCardSpark = {
  /** Forecast on each day before today, oldest first (0..100). */
  history: readonly number[];
  /** Forecast today, not rounded. */
  forecast: number;
  daysLeft: number;
  /** The plan's projection, one value per day from today to exam day; left out, a rule of thumb is drawn. */
  plan?: readonly number[];
};

export type ExamCardVerdict = {
  text: string;
  /** False draws it calm (ink, no check), as for "Tight. ...". */
  ok: boolean;
};

/** Shared by both exam cards. */
export const CARD =
  "rounded-[20px] border border-solid border-line bg-surface p-[18px] text-ink shadow-[var(--shadow-card)] " +
  "transition-[transform,box-shadow] duration-quick ease-out " +
  "hover:-translate-y-0.5 hover:shadow-[var(--shadow-lift)] motion-reduce:hover:translate-y-0";

export const TITLE =
  "font-display text-[20px] font-semibold leading-[1.2] tracking-[-0.01em] [font-variation-settings:'SOFT'_100]";

export const READY_BIG =
  "font-display text-[22px] font-semibold leading-[1.2] tracking-[-0.01em] [font-variation-settings:'SOFT'_100]";

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Making your cards from 3 lectures. Usually ready within a day." */
export function makingLine(lectures: number): string {
  return `Making your cards from ${plural(lectures, "lecture", "lectures")}. Usually ready within a day.`;
}

export function Chevron({
  d,
  className = "",
}: {
  d: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={
        "size-4 flex-none fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.5] " +
        className
      }
    >
      <path d={d} />
    </svg>
  );
}

function Check() {
  return <Chevron d="M6 12.5l4 4L18 8" />;
}

export type ExamCardProps = Omit<
  HTMLAttributes<HTMLElement>,
  "children" | "title"
> & {
  kind: ExamKind;
  title: string;
  course: string;
  /** Mono "when" line, for example "MON 15 DEC · 9:00 · 12 DAYS". */
  when: string;
  /** Forecast shown, a whole percent. */
  forecast: number;
  spark: ExamCardSpark;
  /** Target percent for the aimed grade. */
  target: number;
  /** The grade she aims for ("A 4 needs 80%"); null when none is known: "The target is 80%." */
  grade: number | string | null;
  verdict: ExamCardVerdict;
  concepts: readonly ExamCardConcept[];
  /** Minutes of today's bite; null or undefined shows "Open the exam". Exams only. */
  biteMinutes?: number | null;
  /** Cards still being made from this many lectures. */
  making?: { lectures: number };
  /** Before the study start, the day it opens ("Tue 24 Nov"): one line, no forecast, verdict or plan. */
  starts?: string;
  /** Concepts open on first show (uncontrolled). */
  defaultOpen?: boolean;
  /** Controlled disclosure. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The title button. */
  onOpenExam?: () => void;
  /** The bite / "Open the exam" button. */
  onSession?: () => void;
};

export function ExamCard({
  kind,
  title,
  course,
  when,
  forecast,
  spark,
  target,
  grade,
  verdict,
  concepts,
  biteMinutes,
  making,
  starts,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  onOpenExam,
  onSession,
  className = "",
  ...rest
}: ExamCardProps) {
  const id = useId();
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const toggle = () => {
    const next = !open;
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };
  const f = Math.round(forecast);
  const conceptsId = `${id}-concepts`;
  const mode = useMotionMode();
  /** Opens the exam page out of this card. */
  const openOut = (e: MouseEvent<HTMLElement>, go: (() => void) | undefined) => {
    if (!go) return;
    const card = e.currentTarget.closest<HTMLElement>(`[${WORK_SOURCE_ATTR}]`);
    if (card) openCardPage(card, mode, go);
    else go();
  };
  const opensExam = biteMinutes == null;

  return (
    <article {...workSource(`exam-card|${kind}|${course}|${title}`)} {...rest} className={`${CARD} ${className}`}>
      <style href="ready-work-transition" precedence="default">
        {WORK_TRANSITION_CSS}
      </style>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={(e) => openOut(e, onOpenExam)}
            className={
              "inline-flex min-h-11 cursor-pointer items-center border-0 bg-transparent p-0 text-left text-ink " +
              "underline decoration-transparent underline-offset-4 transition-[text-decoration-color] " +
              "duration-quick ease-out hover:decoration-accent " +
              TITLE
            }
          >
            {title}
          </button>
          <p className="mt-0.5 text-[13px] text-ink-3">{course}</p>
          <p className="mono mt-1 text-ink-3">{when}</p>
        </div>
        {!making && !starts && <Ring value={f} size={48} />}
      </div>

      {making ? (
        <p className="mt-3.5 text-[15px] text-ink-2">
          {makingLine(making.lectures)}
        </p>
      ) : starts ? (
        <p className="mt-3.5 text-[15px] text-ink-2" data-testid="starts">
          {startsLine(starts)}
        </p>
      ) : (
        <>
          <div className="flex items-end justify-between gap-3">
            <p className={`mt-3.5 ${READY_BIG}`}>
              <span data-pct={f}>{f}%</span> forecast
            </p>
            <Sparkline
              history={spark.history}
              forecast={spark.forecast}
              daysLeft={spark.daysLeft}
              plan={spark.plan}
              target={target}
            />
          </div>
          <p className="mt-0.5 text-[13px] text-ink-2">
            If it were today. {grade == null ? `The target is ${target}%.` : `A ${grade} needs ${target}%.`}
          </p>
          <p
            className={
              "mt-2 inline-flex items-center gap-1.5 text-[13px] font-semibold " +
              (verdict.ok ? "text-accent" : "text-ink-2")
            }
          >
            {verdict.ok && <Check />}
            {verdict.text}
          </p>

          <div>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={conceptsId}
              onClick={toggle}
              className="mt-1 inline-flex min-h-11 items-center gap-1 border-0 bg-transparent p-0 text-[13px] font-semibold text-ink"
            >
              Concepts
              <Chevron
                d="M7 10l5 5 5-5"
                className={
                  "transition-transform duration-base ease-out motion-reduce:transition-none " +
                  (open ? "rotate-180" : "")
                }
              />
            </button>
          </div>
          <div id={conceptsId} hidden={!open}>
            <ul className="mt-1 grid list-none gap-2.5 p-0">
              {concepts.map((c) => (
                <li
                  key={c.id}
                  className="grid grid-cols-[26px_minmax(0,1fr)_auto] items-center gap-x-2.5 [grid-template-areas:'ic_n_pips'_'ic_r_r']"
                >
                  <span className="grid size-[26px] place-items-center rounded-lg bg-paper text-ink [grid-area:ic] [&_svg]:size-4">
                    {c.icon}
                  </span>
                  <span className="text-[13px] [grid-area:n]">{c.name}</span>
                  <Pips rung={c.rung} size="sm" className="[grid-area:pips]" />
                  <span className="mono text-[11px] text-ink-3 [grid-area:r]">
                    {RUNG_NAMES[Math.min(5, Math.max(0, Math.round(c.rung)))]}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3.5 text-[12px] text-ink-3">
              Each concept climbs five rungs, from recognising it to exam-ready.
            </p>
          </div>
        </>
      )}

      {kind === "exam" && !making && (
        <Button
          variant="secondary"
          className="mt-3"
          onClick={opensExam ? (e) => openOut(e, onSession) : onSession}
        >
          {opensExam ? "Open the exam" : `Today’s bite · ${biteMinutes} min`}
        </Button>
      )}
    </article>
  );
}
