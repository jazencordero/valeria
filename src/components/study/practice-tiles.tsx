"use client";

/**
 * "Ways to practise": four tiles, each a doodle on a pastel ground.
 * Copied from the prototype (main-flow.html JS 2905-2911, 1985-1995,
 * 2019-2028, CSS 628-640).
 *
 * A tile whose type has no cards shows "No <type> for this one yet." under
 * the grid instead of starting. Doodles wiggle once when scrolled into view,
 * and on hover on wide screens with a pointer. Two columns, four from 900 px
 * of available width (a container query, so it follows the space it is given).
 *
 * Put <DoodleDefs /> once on the page.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Doodle } from "@/components/doodle";
import { useMotionMode } from "@/lib/motion/use-calm";
import { durationMs, ease } from "@/lib/motion/tokens";

export const PRACTICE_TYPES = ["basic", "cloze", "explain", "mcq"] as const;
export type PracticeType = (typeof PRACTICE_TYPES)[number];

const NAMES: Record<PracticeType, string> = {
  basic: "Recall cards",
  cloze: "Fill the gap",
  explain: "Explain it",
  mcq: "Quiz me",
};

const DESCS: Record<PracticeType, string> = {
  basic: "Question, think, flip, grade yourself.",
  cloze: "Sentences with the key words missing.",
  explain: "Write it from memory. See what you missed.",
  mcq: "Exam-style questions with the why.",
};

const GROUNDS: Record<PracticeType, string> = {
  basic: "bg-accent-wash",
  cloze: "bg-butter",
  explain: "bg-mint",
  mcq: "bg-sky",
};

const HOVER_WIDE = "(hover: hover) and (min-width: 700px)";
const WIGGLE_MS = 400;

export function emptyNote(type: PracticeType): string {
  return `No ${NAMES[type].toLowerCase()} for this one yet.`;
}

function wiggle(node: HTMLElement | null) {
  if (!node || typeof node.animate !== "function") return;
  node.animate(
    [
      { transform: "rotate(0deg)" },
      { offset: 0.3, transform: "rotate(-3deg)" },
      { offset: 0.65, transform: "rotate(3deg)" },
      { transform: "rotate(0deg)" },
    ],
    { duration: WIGGLE_MS, easing: `cubic-bezier(${ease.out.join(",")})` },
  );
}

export type PracticeTilesProps = {
  /** Card count per type. A type with 0 shows the empty note when pressed. */
  counts: Record<PracticeType, number>;
  /** Called when a tile with cards is pressed. */
  onStart?: (type: PracticeType) => void;
  /** Show this type's empty note from the start (previews). */
  initialNote?: PracticeType;
  className?: string;
};

export function PracticeTiles({ counts, onStart, initialNote, className }: PracticeTilesProps) {
  const labelId = useId();
  const mode = useMotionMode();
  const moving = mode === "full";
  const [note, setNote] = useState<PracticeType | null>(initialNote ?? null);
  const [noteShown, setNoteShown] = useState(0);
  const doodles = useRef<(HTMLSpanElement | null)[]>([]);
  const noteRef = useRef<HTMLParagraphElement>(null);

  // Wiggle each doodle once as it scrolls into view.
  useEffect(() => {
    if (!moving || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) {
            io.unobserve(en.target);
            wiggle(en.target as HTMLElement);
          }
        }
      },
      { threshold: 0.6 },
    );
    for (const d of doodles.current) if (d) io.observe(d);
    return () => io.disconnect();
  }, [moving]);

  // The note rises in each time it is (re)shown by a press.
  useEffect(() => {
    if (!noteShown || !moving) return;
    noteRef.current?.animate(
      [
        { opacity: 0, transform: "translateY(4px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: durationMs.base, easing: `cubic-bezier(${ease.out.join(",")})` },
    );
  }, [noteShown, moving]);

  function hover(i: number) {
    if (!moving || !window.matchMedia(HOVER_WIDE).matches) return;
    wiggle(doodles.current[i]);
  }

  function press(type: PracticeType) {
    if (counts[type] > 0) {
      setNote(null);
      onStart?.(type);
      return;
    }
    if (note !== type) setNoteShown((n) => n + 1);
    setNote(type);
  }

  return (
    <section
      aria-labelledby={labelId}
      className={className ? `@container ${className}` : "@container"}
    >
      <h2
        id={labelId}
        className="mono mb-3 font-medium uppercase tracking-[0.04em] text-ink-3 [font-variation-settings:normal]"
      >
        Ways to practise
      </h2>
      <div className="grid grid-cols-2 gap-3 @[900px]:grid-cols-4">
        {PRACTICE_TYPES.map((type, i) => (
          <button
            key={type}
            type="button"
            data-type={type}
            onClick={() => press(type)}
            onPointerEnter={() => hover(i)}
            className="group flex flex-col gap-1 rounded-2xl pb-1 text-left text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            <span
              className={`relative grid h-24 place-items-center rounded-2xl transition-transform duration-quick ease-out group-active:scale-[0.98] ${GROUNDS[type]}`}
            >
              <span
                ref={(el) => {
                  doodles.current[i] = el;
                }}
                className="block origin-[50%_90%]"
              >
                <Doodle name={type} size={120} />
              </span>
            </span>
            <span className="mt-1 text-[15px] font-semibold">{NAMES[type]}</span>
            <span className="text-[13px] text-ink-2">{DESCS[type]}</span>
          </button>
        ))}
      </div>
      <p ref={noteRef} aria-live="polite" className="mt-3 text-[13px] text-ink-2">
        {note ? emptyNote(note) : ""}
      </p>
    </section>
  );
}
