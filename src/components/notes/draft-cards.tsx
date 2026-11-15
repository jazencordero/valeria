"use client";

/**
 * The notepad's draft cards (ticket M9-17).
 * Source: prototype merged.html JS 5815-5837 (draftCards).
 *
 * "DRAFT CARDS", then per line "CARD n · FRONT" and "BACK", both editable,
 * then "Add 3 cards" with the real count (`usableCards`: rows with an empty
 * front or back are not counted). With nothing written: "Write a few lines
 * first. Each line becomes a card." For a General note, "Which exam?" picks
 * one of her exams not yet past; with none, the no-exam line instead of the
 * button. `message` is what the last add said (no exam on the course, cards
 * she already had, a failure), shown above the button.
 *
 * Plain data in; the notepad owns the rows and calls the action.
 */
import Link from "next/link";
import { useId, type Ref } from "react";
import type { ExamChoice } from "@/app/(app)/notes/card-actions";
import { Button } from "@/components/ui/button";
import { addLabel, usableCards, type DraftCard } from "@/lib/notes/to-cards";

export const NOTHING_WRITTEN = "Write a few lines first. Each line becomes a card.";
export const COURSE_NO_EXAM = "This course has no exam in Ready yet. Add one and these become cards.";
export const NO_EXAM_AT_ALL = "You have no exam in Ready yet. Add one and these become cards.";
export const ADD_EXAM_HREF = "/exams";

export type DraftMessage =
  | { kind: "no_exam" }
  | { kind: "text"; text: string };

export type DraftCardsProps = {
  rows: DraftCard[];
  onRows: (rows: DraftCard[]) => void;
  /** General note: her exams to pick from (null while loading). Left out for a note with a course. */
  exams?: ExamChoice[] | null;
  examId?: string;
  onExam?: (id: string) => void;
  busy?: boolean;
  message?: DraftMessage | null;
  onAdd: () => void;
  /** The first FRONT field, focused when the drafts appear. */
  firstRef?: Ref<HTMLInputElement>;
};

const LABEL = "mono mt-3 mb-1 block text-[11px] tracking-[0.06em] text-ink-3";
const FIELD =
  "min-h-11 w-full rounded-xl border border-solid border-line bg-surface px-3 text-[16px] text-ink " +
  "focus-visible:border-ink-3 focus-visible:outline-none";

function NoExam({ text }: { text: string }) {
  return (
    <p className="mt-3 text-[14px] text-ink-2" data-testid="draft-no-exam">
      {text}{" "}
      <Link href={ADD_EXAM_HREF} className="font-medium text-ink underline underline-offset-2">
        Add an exam
      </Link>
    </p>
  );
}

export function DraftCards({
  rows,
  onRows,
  exams,
  examId = "",
  onExam,
  busy = false,
  message = null,
  onAdd,
  firstRef,
}: DraftCardsProps) {
  const base = useId();
  const selectId = `${base}-exam`;

  if (rows.length === 0) {
    return (
      <div className="mt-4" data-testid="draft-cards">
        <p className="text-[14px] text-ink-2">{NOTHING_WRITTEN}</p>
      </div>
    );
  }

  const count = usableCards(rows).length;
  const general = exams !== undefined;
  const noExams = general && exams !== null && exams.length === 0;
  const needsExam = general && examId === "";
  const set = (i: number, side: keyof DraftCard, value: string) =>
    onRows(rows.map((r, j) => (j === i ? { ...r, [side]: value } : r)));

  return (
    <div className="mt-4" data-testid="draft-cards">
      <p className="mono text-[11px] tracking-[0.08em] text-ink-3">DRAFT CARDS</p>
      {rows.map((r, i) => (
        <div key={i} className="mt-2 rounded-[14px] border border-line bg-paper px-3 pt-0.5 pb-3">
          <label className={LABEL} htmlFor={`${base}-f${i}`}>
            CARD {i + 1} · FRONT
          </label>
          <input
            ref={i === 0 ? firstRef : undefined}
            id={`${base}-f${i}`}
            className={FIELD}
            type="text"
            autoComplete="off"
            value={r.front}
            onChange={(e) => set(i, "front", e.target.value)}
          />
          <label className={LABEL} htmlFor={`${base}-b${i}`}>
            BACK
          </label>
          <input
            id={`${base}-b${i}`}
            className={FIELD}
            type="text"
            autoComplete="off"
            value={r.back}
            onChange={(e) => set(i, "back", e.target.value)}
          />
        </div>
      ))}

      {general && !noExams ? (
        <div className="mt-3">
          <label htmlFor={selectId} className="mb-1.5 block text-[14px] font-medium text-ink">
            Which exam?
          </label>
          <select
            id={selectId}
            className={FIELD}
            value={examId}
            disabled={exams === null}
            onChange={(e) => onExam?.(e.target.value)}
          >
            <option value="" disabled>
              {exams === null ? "Loading your exams" : "Pick an exam"}
            </option>
            {(exams ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div aria-live="polite">
        {noExams ? <NoExam text={NO_EXAM_AT_ALL} /> : null}
        {message?.kind === "no_exam" ? <NoExam text={COURSE_NO_EXAM} /> : null}
        {message?.kind === "text" ? (
          <p className="mt-3 text-[14px] text-ink-2" data-testid="draft-message">
            {message.text}
          </p>
        ) : null}
      </div>

      {noExams || message?.kind === "no_exam" ? null : (
        <Button
          variant="primary"
          block
          className="mt-3"
          disabled={count === 0 || needsExam || busy}
          loading={busy}
          loadingLabel="Adding"
          onClick={onAdd}
        >
          {addLabel(count)}
        </Button>
      )}
    </div>
  );
}
