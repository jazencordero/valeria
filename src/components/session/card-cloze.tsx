"use client";

/**
 * Fill-the-gap card (type "cloze"): the sentence with each {{...}} as a button
 * reading "…"; "Show next word" opens one blank at a time, in order, each word
 * popping in underlined. After the last, the source chip.
 * Source: prototype main-flow.html JS 3189-3192, 3235 and 3257-3280
 * (renderCard, renderFrontActions, revealBasic, openBlank); CSS 697-699.
 *
 *   <CardCloze card={card} section="learn" conceptNames={["Elasticity"]} rung={1}
 *     onRevealed={() => setGrading(true)} />
 *
 * "Show next word" or Space (when focus is not on another button) opens the
 * next blank. Tapping a blank opens that one; focus then moves to the next
 * closed blank, or the main button. `onRevealed` fires once, after the last.
 * Tap to reveal only: no typed answers.
 */
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClozeCard } from "@/lib/study/card-schema";
import { calmDuration, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";
import {
  CardSurface,
  MainAction,
  QUESTION_CLASS,
  RevealedAnswer,
  SourceChip,
  useOnce,
  useSpaceToReveal,
  type SessionCardProps,
} from "./card-head";

export const SHOW_NEXT_WORD = "Show next word";
export const BLANK_LABEL = "Hidden word. Reveal";

export type ClozePart = { text: string } | { blank: string; index: number };

/** Splits "A {{b}} c" into text and blank parts; blanks are numbered in order. */
export function clozeParts(q: string): ClozePart[] {
  const parts: ClozePart[] = [];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let last = 0;
  let index = 0;
  for (const m of q.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: q.slice(last, at) });
    parts.push({ blank: m[1].trim(), index: index++ });
    last = at + m[0].length;
  }
  if (last < q.length) parts.push({ text: q.slice(last) });
  return parts;
}

export type CardClozeProps = SessionCardProps & { card: Pick<ClozeCard, "q" | "source"> };

export function CardCloze({
  card,
  section,
  conceptNames,
  rung,
  onRevealed,
  keyboard = true,
  autoFocus = false,
  actionsEl,
  className,
}: CardClozeProps) {
  const parts = useMemo(() => clozeParts(card.q), [card.q]);
  const total = parts.filter((p) => "blank" in p).length;
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const done = total > 0 && open.size >= total;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const blankRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const fire = useOnce(onRevealed);

  const openBlank = (i: number) => {
    if (open.has(i) || done) return;
    const next = new Set(open);
    next.add(i);
    // Focus follows if the opened blank had it: next closed blank, else the main button.
    if (typeof document !== "undefined" && document.activeElement === blankRefs.current[i]) {
      const after = Array.from({ length: total }, (_, k) => k).find((k) => !next.has(k));
      queueMicrotask(() => {
        const el = after === undefined ? buttonRef.current : blankRefs.current[after];
        el?.focus({ preventScroll: true });
      });
    }
    setOpen(next);
    if (next.size >= total) fire();
  };

  const openNext = () => {
    const i = Array.from({ length: total }, (_, k) => k).find((k) => !open.has(k));
    if (i !== undefined) openBlank(i);
  };

  useSpaceToReveal(keyboard && !done, openNext);

  useEffect(() => {
    if (autoFocus) buttonRef.current?.focus({ preventScroll: true });
    // Only on mount (and when the portal target arrives).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionsEl]);

  return (
    <>
      <CardSurface section={section} conceptNames={conceptNames} rung={rung} className={className}>
        <p className={QUESTION_CLASS}>
          {parts.map((p, k) =>
            "text" in p ? (
              <span key={k}>{p.text}</span>
            ) : open.has(p.index) ? (
              <OpenBlank key={k} phrase={p.blank} index={p.index} />
            ) : (
              <button
                key={k}
                ref={(el) => {
                  blankRefs.current[p.index] = el;
                }}
                type="button"
                data-blank={p.index}
                aria-label={BLANK_LABEL}
                onClick={() => openBlank(p.index)}
                className="mx-0.5 inline-block min-w-[72px] cursor-pointer rounded-t-lg border-0 border-b-2 border-dashed border-ink-3 bg-paper px-2.5 leading-[1.25] text-ink-3 [font:inherit]"
              >
                …
              </button>
            ),
          )}
        </p>
        {done ? (
          <RevealedAnswer>
            <SourceChip source={card.source} />
          </RevealedAnswer>
        ) : null}
      </CardSurface>
      {done ? null : (
        <MainAction label={SHOW_NEXT_WORD} onClick={openNext} buttonRef={buttonRef} actionsEl={actionsEl} />
      )}
    </>
  );
}

/** The phrase replaces the button and wraps like text; each word pops in underlined. */
function OpenBlank({ phrase, index }: { phrase: string; index: number }) {
  const mode = useMotionMode();
  const words = phrase.split(" ");
  return (
    <span data-blank={index} data-open="" className="inline">
      {words.map((w, k) => (
        <span key={k}>
          <motion.span
            className="inline-block border-b-2 border-solid border-accent leading-[1.15]"
            initial={
              mode === "instant" ? false : mode === "full" ? { opacity: 0, scale: 0.85 } : { opacity: 0 }
            }
            animate={{ opacity: 1, scale: 1 }}
            transition={
              mode === "full" ? { duration: 0.22, delay: k * 0.04, ease: ease.out } : { duration: calmDuration }
            }
          >
            {w}
          </motion.span>
          {k < words.length - 1 ? " " : null}
        </span>
      ))}
    </span>
  );
}
