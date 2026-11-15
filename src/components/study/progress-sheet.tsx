"use client";

/**
 * Progress sheet (M3-48): the button "More: phases, path and study days" on the
 * Progress tab, and the sheet it opens, "How it is going". The sheet holds
 * ALL CONCEPTS (name, rose bar, percent), WHERE YOU ARE (phase strip), YOUR
 * PATH (concept path with its ladder detail; it draws in each time the sheet
 * opens, because the body mounts on open) and STUDY DAYS.
 * Source: prototype merged-2.html HTML 2091-2096 (#sheet-prog), JS 6029-6047
 * (progressHTML, progSheetHTML), 6111-6125 (openProg) and CSS 1409-1413,
 * 1493-1495, 1506 (560 px wide from 700 px).
 *
 * Closes by its X, Escape or the scrim (the Sheet handles the last two). A
 * lecture link or "Practise this" in the concept detail closes it first, then
 * the link navigates or `onPractise` runs.
 *
 * Plain props: the page decides every number (mastery, minutes, phase sentence,
 * week). Pass `open` and `onOpenChange` to control it; otherwise it keeps its
 * own state.
 */
import { useId, useState, type MouseEvent } from "react";
import type { ConceptIconName } from "@/components/exams/concept-icons";
import { ConceptDetail } from "@/components/study/concept-detail";
import { ConceptPath } from "@/components/study/concept-path";
import { PhaseStrip } from "@/components/study/phase-strip";
import { StudyDays } from "@/components/study/study-days";
import { Bar } from "@/components/ui/bar";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import type { Week } from "@/lib/study/week";

export type ProgressConcept = {
  id: string;
  name: string;
  /** Lecture the concept belongs to; the path is drawn in lecture order. */
  lecture: number;
  /** How much it counts on the exam. */
  weight: number;
  /** 0..1 */
  mastery: number;
  icon?: ConceptIconName;
  /** Minutes "Practise this" takes, or null when there are no cards yet. */
  minutes: number | null;
  /** When there are no cards yet: the lecture they come with. */
  cardsLecture?: number | null;
  /** Link to the concept's lecture page. */
  lectureHref?: string;
};

export type ProgressSheetProps = {
  /** In the caller's order (the ALL CONCEPTS list keeps it). */
  concepts: readonly ProgressConcept[];
  /** The NEXT concept on the path (focusConcept in lib/study/ladder). */
  focusId?: string | null;
  /** Whole days until the exam, for the phase strip. */
  daysLeft: number;
  /** What comes next, for example "Final review starts Tue 17." */
  phaseNext?: string;
  /** False when exam-day bites can still bring new cards (see `PhaseStrip`). Default true. */
  nothingNewOnExamDay?: boolean;
  /** From weekOf. */
  week: Week;
  weeksInARow: number;
  freeSkipsLeft: number;
  /** "Practise this" in the detail; runs after the sheet has closed. */
  onPractise?: (conceptId: string) => void;
  /** Controlled open state. Leave out to let the component keep it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
};

const LABEL =
  "mono mb-2.5 font-medium uppercase tracking-[0.04em] text-ink-3 [font-variation-settings:normal]";

function CloseIcon() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

export function ProgressSheet({
  concepts,
  focusId = null,
  daysLeft,
  phaseNext,
  nothingNewOnExamDay,
  week,
  weeksInARow,
  freeSkipsLeft,
  onPractise,
  open: openProp,
  onOpenChange,
  className = "",
}: ProgressSheetProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean) => {
    if (openProp === undefined) setOpenState(v);
    onOpenChange?.(v);
  };
  const close = () => setOpen(false);

  return (
    <div className={className}>
      <Button variant="secondary" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        More: phases, path and study days
      </Button>
      <Sheet
        open={open}
        onClose={close}
        aria-label="How it is going"
        className="min-[700px]:max-w-[560px]!"
        data-testid="progress-sheet"
      >
        <ProgressBody
          concepts={concepts}
          focusId={focusId}
          daysLeft={daysLeft}
          phaseNext={phaseNext}
          nothingNewOnExamDay={nothingNewOnExamDay}
          week={week}
          weeksInARow={weeksInARow}
          freeSkipsLeft={freeSkipsLeft}
          onClose={close}
          onPractise={onPractise}
        />
      </Sheet>
    </div>
  );
}

type BodyProps = Pick<
  ProgressSheetProps,
  "concepts" | "focusId" | "daysLeft" | "phaseNext" | "nothingNewOnExamDay" | "week" | "weeksInARow" | "freeSkipsLeft" | "onPractise"
> & { onClose: () => void };

/** Mounts when the sheet opens, so the path draws in and nothing stays selected. */
function ProgressBody({
  concepts,
  focusId,
  daysLeft,
  phaseNext,
  nothingNewOnExamDay,
  week,
  weeksInARow,
  freeSkipsLeft,
  onClose,
  onPractise,
}: BodyProps) {
  const allId = useId();
  const detailsId = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const path = concepts.slice().sort((a, b) => a.lecture - b.lecture);
  const sel = concepts.find((c) => c.id === selected) ?? null;

  // A lecture link inside the detail closes the sheet first, then navigates.
  const onDetailClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest("a[href]")) onClose();
  };

  return (
    <>
      <div className="-mt-1 mb-[22px] flex items-center justify-between gap-3">
        <h2 className="type-h22">How it is going</h2>
        <Button variant="icon" aria-label="Close" className="-mr-2.5" onClick={onClose}>
          <CloseIcon />
        </Button>
      </div>

      <div className="space-y-[22px]">
        <section aria-labelledby={allId}>
          <h3 id={allId} className={LABEL}>
            ALL CONCEPTS
          </h3>
          <ul className="grid list-none gap-2.5 p-0" data-all-concepts="">
            {concepts.map((c) => (
              <li
                key={c.id}
                className="grid grid-cols-[minmax(0,1fr)_96px_40px] items-center gap-3 text-sm"
              >
                <span className="min-w-0">{c.name}</span>
                <Bar value={c.mastery} label={c.name} className="[&>span]:bg-accent" />
                <span className="mono text-right text-ink-2">{Math.round(c.mastery * 100)}%</span>
              </li>
            ))}
          </ul>
        </section>

        {daysLeft >= 0 && <PhaseStrip daysLeft={daysLeft} next={phaseNext} nothingNewOnExamDay={nothingNewOnExamDay} />}

        <div>
          <ConceptPath
            concepts={path}
            focusId={focusId}
            selectedId={selected}
            detailsId={detailsId}
            onSelect={(id) => setSelected((s) => (s === id ? null : id))}
          />
          <div onClickCapture={onDetailClick}>
            <ConceptDetail
              id={detailsId}
              concept={sel}
              minutes={sel?.minutes ?? null}
              cardsLecture={sel?.cardsLecture}
              lectureHref={sel?.lectureHref}
              onPractise={(id) => {
                onClose();
                onPractise?.(id);
              }}
            />
          </div>
        </div>

        <StudyDays week={week} weeksInARow={weeksInARow} freeSkipsLeft={freeSkipsLeft} />
      </div>
    </>
  );
}
