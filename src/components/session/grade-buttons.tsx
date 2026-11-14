"use client";

/**
 * Grade buttons under a revealed card.
 * Source: prototype main-flow.html JS 3346-3356 (showGrades), CSS 730-739
 * (.grades, .gbtn, .g-*), 762 (two columns under 700 px) and 1196-1197.
 *
 *   <GradeButtons mode="two" next={{ 1: "1 min", 3: "3 d" }} onGrade={grade} />
 *   <GradeButtons mode="four" next={preview(state, now)} onGrade={grade} />
 *
 * Two-button mode: "Missed" (grade 1, "again in …") and "Got it" (grade 3,
 * "next in …"). Four-button mode: "Again", "Hard", "Good", "Easy", each
 * "next in …". `next` holds a ready label or an interval in ms (formatted with
 * `intervalLabel`). Focus lands on the passing button (Got it / Good) on mount.
 * Presentational: keys live in `useSessionKeys`.
 */
import { useEffect, useRef } from "react";
import type { GradeMode } from "@/lib/study/session";
import { intervalLabel, type Grade } from "@/lib/study/memory";

export const GRADE_GROUP_LABEL = "How well did you remember?";

/** The grade a passing answer gets; its button takes focus. */
export const PASS_GRADE: Grade = 3;

type Spec = { grade: Grade; label: string; prefix: string; tone: "again" | "hard" | "good" | "easy"; key: string };

export const GRADE_BUTTONS: Record<GradeMode, readonly Spec[]> = {
  two: [
    { grade: 1, label: "Missed", prefix: "again in", tone: "again", key: "1" },
    { grade: 3, label: "Got it", prefix: "next in", tone: "good", key: "2" },
  ],
  four: [
    { grade: 1, label: "Again", prefix: "next in", tone: "again", key: "1" },
    { grade: 2, label: "Hard", prefix: "next in", tone: "hard", key: "2" },
    { grade: 3, label: "Good", prefix: "next in", tone: "good", key: "3" },
    { grade: 4, label: "Easy", prefix: "next in", tone: "easy", key: "4" },
  ],
};

const BASE =
  "flex min-h-[60px] flex-col items-center justify-center gap-0.5 mb-[3px] rounded-2xl border-solid " +
  "text-[15px] font-semibold select-none " +
  "transition-[box-shadow,transform] duration-quick ease-out disabled:opacity-[0.32] disabled:cursor-default";

const TONE: Record<Spec["tone"], { button: string; ivl: string }> = {
  again: {
    button: "border-2 border-due bg-surface text-ink shadow-[0_2px_0_var(--line)] active:shadow-none",
    ivl: "text-ink-3",
  },
  hard: {
    button: "border border-line bg-surface text-ink shadow-[0_2px_0_var(--line)] active:shadow-none",
    ivl: "text-ink-3",
  },
  good: {
    button:
      "border border-[var(--btn)] bg-[var(--btn)] text-[var(--btn-ink)] shadow-[0_3px_0_var(--btn-ledge)] " +
      "active:shadow-none",
    ivl: "text-[var(--btn-ink)] opacity-75",
  },
  easy: {
    button: "border border-mint bg-mint text-ink shadow-[0_2px_0_var(--line)] active:shadow-none",
    ivl: "text-ink-3",
  },
};

export type GradeButtonsProps = {
  mode: GradeMode;
  /** Per grade: a label ("3 d") or the interval in ms. Two-button mode reads grades 1 and 3. */
  next: Readonly<Partial<Record<Grade, string | number>>>;
  onGrade: (g: Grade) => void;
  disabled?: boolean;
  /** Focus the passing button on mount. Default true. */
  autoFocus?: boolean;
};

function label(v: string | number | undefined): string {
  if (v == null) return "";
  return typeof v === "number" ? intervalLabel(v) : v;
}

export function GradeButtons({ mode, next, onGrade, disabled = false, autoFocus = true }: GradeButtonsProps) {
  const passRef = useRef<HTMLButtonElement>(null);
  const two = mode === "two";

  useEffect(() => {
    if (autoFocus) passRef.current?.focus({ preventScroll: true });
  }, [autoFocus, mode]);

  return (
    <div
      role="group"
      aria-label={GRADE_GROUP_LABEL}
      data-mode={mode}
      className={
        "grid gap-2 " + (two ? "grid-cols-2" : "grid-cols-2 min-[700px]:grid-cols-4")
      }
    >
      {GRADE_BUTTONS[mode].map((b) => {
        const ivl = label(next[b.grade]);
        return (
          <button
            key={b.grade}
            ref={b.grade === PASS_GRADE ? passRef : undefined}
            type="button"
            data-grade={b.grade}
            aria-keyshortcuts={b.key}
            disabled={disabled}
            onClick={() => onGrade(b.grade)}
            className={`${BASE} ${TONE[b.tone].button}`}
          >
            <span>{b.label}</span>
            {ivl ? (
              <span className={`mono text-[12px] font-normal ${TONE[b.tone].ivl}`}>
                {b.prefix} {ivl}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
