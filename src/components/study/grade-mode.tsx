"use client";

/**
 * How you grade: the exam page rail card with a two-option control, "Missed ·
 * Got it" or "Anki, 4 buttons", and the note under it.
 * Source: prototype main-flow.html, the rail part of JS 2903-2949 (.rcard
 * "HOW YOU GRADE"), setGradeMode 3030-3033, CSS 461 (.rcard) and 1135-1138
 * (.seg2, .gm-b, .gm-note).
 *
 * Controlled: the page owns the value and saves it. Each option is a button
 * with aria-pressed inside a labelled group, as in the prototype.
 */
import { useId } from "react";

export type GradeModeValue = "two" | "anki";

export type GradeModeProps = {
  value: GradeModeValue;
  onChange: (next: GradeModeValue) => void;
  className?: string;
};

const OPTIONS: { value: GradeModeValue; label: string }[] = [
  { value: "two", label: "Missed · Got it" },
  { value: "anki", label: "Anki, 4 buttons" },
];

const CARD = "rounded-[20px] border border-solid border-line bg-surface p-4";

const LABEL =
  "mono mb-2.5 font-medium uppercase tracking-[0.04em] text-ink-3 [font-variation-settings:normal]";

export function GradeMode({ value, onChange, className }: GradeModeProps) {
  const labelId = useId();
  return (
    <section className={className ? `${CARD} ${className}` : CARD} aria-labelledby={labelId}>
      <h2 id={labelId} className={LABEL}>
        How you grade
      </h2>
      <div
        role="group"
        aria-label="Grading buttons"
        className="grid grid-cols-2 rounded-full border border-solid border-line bg-paper p-0.5"
      >
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => {
              if (value !== o.value) onChange(o.value);
            }}
            className={
              "min-h-10 whitespace-nowrap rounded-full border-0 bg-transparent px-2 text-[12px] font-medium " +
              "text-ink-2 transition-[background-color,color] duration-quick ease-out motion-reduce:duration-150 " +
              "aria-pressed:bg-[var(--btn)] aria-pressed:text-[var(--btn-ink)]"
            }
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="fine mt-2">Quiz and match cards grade themselves.</p>
    </section>
  );
}
