"use client";

/**
 * Recall card (type "basic"): head, question, "Show answer", then the answer
 * with its source chip. Source: prototype main-flow.html JS 3188-3194,
 * 3234 and 3251-3256 (renderCard, renderFrontActions, revealBasic).
 *
 *   <CardBasic card={card} section="learn" conceptNames={["Supply"]} rung={2}
 *     onRevealed={() => setGrading(true)} />
 *
 * "Show answer" or Space (when focus is not on another button) reveals.
 * `onRevealed` fires once. The parent then shows the grade buttons.
 */
import { useEffect, useRef, useState } from "react";
import type { BasicCard } from "@/lib/study/card-schema";
import {
  CardSurface,
  MainAction,
  QUESTION_CLASS,
  RevealedAnswer,
  SourceChip,
  WhyLine,
  useOnce,
  useSpaceToReveal,
  type SessionCardProps,
} from "./card-head";

export const SHOW_ANSWER = "Show answer";

export type CardBasicProps = SessionCardProps & { card: Pick<BasicCard, "q" | "a" | "source" | "why"> };

export function CardBasic({
  card,
  section,
  conceptNames,
  rung,
  onRevealed,
  keyboard = true,
  autoFocus = false,
  actionsEl,
  className,
}: CardBasicProps) {
  const [revealed, setRevealed] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const fire = useOnce(onRevealed);

  const reveal = () => {
    setRevealed(true);
    fire();
  };
  useSpaceToReveal(keyboard && !revealed, reveal);

  useEffect(() => {
    if (autoFocus) buttonRef.current?.focus({ preventScroll: true });
    // Only on mount (and when the portal target arrives).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionsEl]);

  return (
    <>
      <CardSurface section={section} conceptNames={conceptNames} rung={rung} className={className}>
        <h2 className={QUESTION_CLASS}>{card.q}</h2>
        {revealed ? (
          <RevealedAnswer>
            <p className="text-[17px] leading-[1.5] whitespace-pre-line [overflow-wrap:anywhere]">{card.a}</p>
            <WhyLine why={card.why} />
            <SourceChip source={card.source} />
          </RevealedAnswer>
        ) : null}
      </CardSurface>
      {revealed ? null : (
        <MainAction label={SHOW_ANSWER} onClick={reveal} buttonRef={buttonRef} actionsEl={actionsEl} />
      )}
    </>
  );
}
