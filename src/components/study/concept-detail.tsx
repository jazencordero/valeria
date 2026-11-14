"use client";

/**
 * Concept detail (M3-27): the card that opens under the concept path for the
 * selected node. Source: prototype main-flow.html JS 2855-2866 (detailHTML),
 * 3017-3029 (toggleNode) and CSS 1099-1120 (.pd-*, .ladder, .ld).
 *
 * Shows the concept icon, name, "LECTURE N · W% OF THE EXAM", the exam-day
 * percent, the five-rung ladder (rows done, "YOU ARE HERE" on the next rung,
 * or still to come) and "Practise this · N min". With no cards the button is
 * disabled and says when the cards come. An optional link reads the lecture.
 *
 * Pass `concept={null}` to close it. Opening grows the card in; picking
 * another concept while open cross-fades it; the ladder rows fade in one
 * after another each time. Calm: 150 ms fades, no stagger, no slide.
 *
 * Plain props: the page decides the minutes and the lecture the cards come
 * with (`practiseMinutes` below is the prototype's rule for the minutes).
 */
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { ConceptIcon, iconFor, type ConceptIconName } from "@/components/exams/concept-icons";
import { Button } from "@/components/ui/button";
import { RUNGS, rungOf } from "@/lib/study/ladder";
import { calmDuration, duration, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

export type DetailConcept = {
  id: string;
  name: string;
  /** Lecture number, 1-based. */
  lecture: number;
  /** Share of the exam, 0..1. */
  weight: number;
  /** Mastery on exam day, 0..1. The rung comes from it. */
  mastery: number;
  /** Defaults to iconFor(name). */
  icon?: ConceptIconName;
};

export type ConceptDetailProps = {
  /** The open concept; null closes the card. */
  concept: DetailConcept | null;
  /** Minutes of practice; null when the concept has no cards yet. */
  minutes: number | null;
  /**
   * With no cards: the lecture whose cards bring this concept
   * ("Cards for this come with lecture 6"). Left out: "are still being made".
   */
  cardsLecture?: number | null;
  /** That lecture's page; shows "Read lecture N" for the concept's lecture. */
  lectureHref?: string;
  onPractise?: (conceptId: string) => void;
  /** Id of the panel, for the path nodes' aria-controls. */
  id?: string;
  className?: string;
};

/** Prototype rule: about 0.6 min a card, at most four cards, at least 1 min. */
export function practiseMinutes(cardCount: number): number | null {
  if (cardCount <= 0) return null;
  return Math.max(1, Math.round(Math.min(4, cardCount) * 0.6));
}

function Check() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-3.5 fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:2]"
    >
      <path d="M6 12.5l4 4L18 8" />
    </svg>
  );
}

type RowState = "done" | "now" | "next";

const ROW: Record<RowState, string> = {
  done: "",
  now: "bg-accent-wash",
  next: "",
};

const DOT: Record<RowState, string> = {
  done: "border-mint bg-mint text-accent",
  now: "border-[var(--btn)] bg-[var(--btn)] text-[var(--btn-ink)]",
  next: "border-line bg-paper text-ink-3",
};

export function ConceptDetail({
  concept,
  minutes,
  cardsLecture,
  lectureHref,
  onPractise,
  id,
  className = "",
}: ConceptDetailProps) {
  const mode = useMotionMode();
  const full = mode === "full";
  const ref = useRef<HTMLDivElement>(null);

  // Was another concept open just before this one? Then cross-fade, not grow.
  const cid = concept?.id ?? null;
  const [shown, setShown] = useState<string | null>(cid);
  const [swapped, setSwapped] = useState(false);
  if (cid !== shown) {
    setSwapped(shown !== null && cid !== null);
    setShown(cid);
  }

  // Bring the card into view once it has opened (prototype: after T_B).
  useEffect(() => {
    if (!cid) return;
    const t = window.setTimeout(
      () => {
        try {
          ref.current?.scrollIntoView({ block: "nearest", behavior: full ? "smooth" : "auto" });
        } catch {
          // Older browsers without options: skip.
        }
      },
      mode === "instant" ? 0 : duration.base * 1000,
    );
    return () => window.clearTimeout(t);
  }, [cid, full, mode]);

  const fadeT = { duration: mode === "instant" ? 0 : calmDuration, ease: "linear" as const };
  const grow = full
    ? {
        initial: { height: 0, opacity: 0 },
        animate: { height: "auto", opacity: 1 },
        exit: { height: 0, opacity: 0 },
        transition: { duration: duration.base, ease: ease.out },
      }
    : { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: fadeT };
  const swap = full
    ? {
        initial: { opacity: swapped ? 0.4 : 1 },
        animate: { opacity: 1 },
        transition: { duration: duration.quick, ease: "linear" as const },
      }
    : { initial: { opacity: swapped ? 0 : 1 }, animate: { opacity: 1 }, transition: fadeT };
  const rowAnim = (i: number) =>
    full
      ? {
          initial: { opacity: 0, x: -6 },
          animate: { opacity: 1, x: 0 },
          transition: { duration: 0.22, ease: ease.out, delay: 0.08 + i * 0.06 },
        }
      : { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: fadeT };

  const r = concept ? rungOf(concept.mastery) : 0;

  return (
    <div
      ref={ref}
      id={id}
      className={className}
      data-concept-detail=""
      data-open={concept ? "" : undefined}
    >
      <AnimatePresence initial={false}>
        {concept && (
          // Side and bottom padding keep the card's shadow out of the clip.
          <motion.div key="pd" className="-mx-3 -mb-4 overflow-hidden px-3 pb-4" {...grow}>
            <motion.div
              key={concept.id}
              className="mt-4 rounded-[20px] border border-solid border-line bg-surface p-[18px] text-ink shadow-[var(--shadow-card)]"
              data-concept={concept.id}
              data-rung={r}
              {...swap}
            >
              <div className="flex items-center gap-3">
                <span className="grid size-11 flex-none place-items-center rounded-[14px] bg-butter">
                  <ConceptIcon name={concept.icon ?? iconFor(concept.name)} size={22} />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="font-display text-[20px] leading-[1.2] font-semibold [font-variation-settings:'SOFT'_100]">
                    {concept.name}
                  </h3>
                  <p className="mono mt-0.5 text-ink-3">
                    LECTURE {concept.lecture} · {Math.round(concept.weight * 100)}% OF THE EXAM
                  </p>
                </div>
                <p className="grid justify-items-end text-right">
                  <b className="font-display text-[26px] leading-none font-semibold [font-variation-settings:'SOFT'_100]">
                    {Math.round(concept.mastery * 100)}%
                  </b>
                  <span className="text-[11px] text-ink-3">on exam day</span>
                </p>
              </div>

              <ol className="my-4 grid list-none gap-0.5 p-0" aria-label="Your ladder">
                {RUNGS.map((rung, i) => {
                  const k = rung.level;
                  const st: RowState = k <= r ? "done" : k === r + 1 ? "now" : "next";
                  return (
                    <motion.li
                      key={`${concept.id}-${k}`}
                      data-state={st}
                      aria-current={st === "now" ? "step" : undefined}
                      className={`relative grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-[14px] px-2.5 py-2 [grid-template-areas:'dot_n_here'_'dot_d_here'] ${ROW[st]}`}
                      {...rowAnim(i)}
                    >
                      <span
                        className={`grid size-7 place-items-center rounded-full border border-solid [grid-area:dot] ${DOT[st]}`}
                      >
                        {st === "done" ? (
                          <>
                            <Check />
                            <span className="sr-only">Done:</span>
                          </>
                        ) : (
                          <b className="mono text-[12px] font-medium" aria-hidden="true">
                            {k}
                          </b>
                        )}
                      </span>
                      <span
                        className={`text-[15px] [grid-area:n] ${st === "next" ? "font-medium text-ink-3" : "font-semibold"}`}
                      >
                        {rung.name}
                      </span>
                      <span className="text-[12px] text-ink-3 [grid-area:d]">{rung.description}</span>
                      {st === "now" && (
                        <span className="mono text-[10px] text-accent [grid-area:here]">YOU ARE HERE</span>
                      )}
                    </motion.li>
                  );
                })}
              </ol>

              <Button
                block
                disabled={minutes === null}
                onClick={() => onPractise?.(concept.id)}
                data-practise={concept.id}
              >
                {minutes !== null
                  ? `Practise this · ${minutes} min`
                  : cardsLecture
                    ? `Cards for this come with lecture ${cardsLecture}`
                    : "Cards for this are still being made"}
              </Button>
              {lectureHref && (
                <Button variant="text" size="sm" block href={lectureHref} className="mt-2">
                  Read lecture {concept.lecture}
                </Button>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
