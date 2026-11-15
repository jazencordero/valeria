"use client";

/**
 * M3-35: the "explain it" session card (an `explain` card from M3-49's format).
 * Source: prototype main-flow.html JS 3209-3210 (the textarea), 3236 (the
 * Check it button) and 3331-3344 (checkExplain); CSS 708 and 716-727
 * (.explain, .rubric, .rb-*, .sc-model).
 *
 *   <CardExplain cardId={id} card={card} section="learn" conceptNames={["Alignment"]} rung={3}
 *     onRevealed={() => …} onChecked={(r) => send({ type: "check", text: r.text, rubricResult: r.rubric })}
 *     gradeMode="four" next={preview} onGrade={grade} actionsEl={footer} />
 *
 * She writes from memory, then "Check it" (or Cmd/Ctrl + Enter in the
 * textarea) sends `{ cardId, text }` to `/api/ai/explain-check` once. Each
 * rubric point is then marked "You had this" or "Missing"; when she wrote
 * nothing no request is sent and the points show neutral, unmarked. "Quick
 * check only" shows when the answer came from the keyword fallback. A failed
 * request also shows the points neutral, with a short line. Then "MODEL
 * ANSWER", the why, the source, and the grade buttons: she decides, the check
 * never grades. `check` is injectable so tests and previews can mock it.
 * Cut: no highlighting of her text.
 */
import { motion } from "motion/react";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { calmDuration, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";
import type { ExplainCard } from "@/lib/study/card-schema";
import type { Grade } from "@/lib/study/memory";
import type { GradeMode } from "@/lib/study/session";
import {
  CardSurface,
  QUESTION_CLASS,
  RevealedAnswer,
  SourceChip,
  WhyLine,
  useOnce,
  type SessionCardProps,
} from "./card-head";
import { GradeButtons, type GradeButtonsProps } from "./grade-buttons";

export const EXPLAIN_PLACEHOLDER = "From memory. No peeking.";
export const CHECK_IT = "Check it";
export const HAD_TAG = "You had this";
export const MISSING_TAG = "Missing";
export const MODEL_ANSWER = "MODEL ANSWER";
export const QUICK_CHECK_NOTE = "Quick check only";
export const CHECK_FAILED = "Could not check it this time. Compare it with the model answer.";

/** What `/api/ai/explain-check` answers (M3-16). */
export type ExplainCheckResponse = { had: string[]; missing: string[]; fallback: boolean };
export type ExplainCheck = (cardId: string, text: string) => Promise<ExplainCheckResponse>;

export type RubricMark = "had" | "miss" | "neutral";

/** What the card reports once the rubric shows. `rubric` is true per point she had, in rubric order. */
export type ExplainOutcome = {
  text: string;
  marks: RubricMark[];
  rubric: boolean[];
  fallback: boolean;
  /** The request failed; the points show neutral. */
  failed: boolean;
};

/** The default check: POST to the M3-16 route. Throws on anything but a valid answer. */
export const fetchExplainCheck: ExplainCheck = async (cardId, text) => {
  const res = await fetch("/api/ai/explain-check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cardId, text }),
  });
  if (!res.ok) throw new Error(`explain-check ${res.status}`);
  const data = (await res.json()) as Partial<ExplainCheckResponse>;
  if (!Array.isArray(data.had) || !Array.isArray(data.missing)) throw new Error("explain-check: bad answer");
  return { had: data.had, missing: data.missing, fallback: data.fallback === true };
};

/** Marks per rubric point from the route's labels. Empty text: all neutral. */
export function rubricMarks(
  rubric: readonly (readonly [string, readonly string[]])[],
  res: Pick<ExplainCheckResponse, "had"> | null,
): RubricMark[] {
  if (!res) return rubric.map(() => "neutral");
  const had = new Set(res.had);
  return rubric.map(([label]) => (had.has(label) ? "had" : "miss"));
}

export type CardExplainHandle = {
  /** Same as pressing "Check it". Ignored after the first time. */
  check: () => void;
};

export type CardExplainProps = SessionCardProps & {
  cardId: string;
  card: Pick<ExplainCard, "q" | "rubric" | "model" | "source" | "why">;
  /** Defaults to `fetchExplainCheck`. */
  check?: ExplainCheck;
  /** Called once, with the marks, when the rubric shows (before `onRevealed`). */
  onChecked?: (outcome: ExplainOutcome) => void;
  /** Grade buttons after the check; shown when `onGrade` is given. */
  onGrade?: (g: Grade) => void;
  gradeMode?: GradeMode;
  next?: GradeButtonsProps["next"];
  /** Start with this text in the box (previews). */
  initialText?: string;
  ref?: Ref<CardExplainHandle>;
};

type Phase = "front" | "checking" | "checked";

export function CardExplain({
  cardId,
  card,
  section,
  conceptNames,
  rung,
  onRevealed,
  onChecked,
  check = fetchExplainCheck,
  onGrade,
  gradeMode = "four",
  next = {},
  initialText = "",
  autoFocus = false,
  actionsEl,
  className,
  ref,
}: CardExplainProps) {
  const [text, setText] = useState(initialText);
  const [phase, setPhase] = useState<Phase>("front");
  const [outcome, setOutcome] = useState<ExplainOutcome | null>(null);
  const sent = useRef(false);
  const alive = useRef(true);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fire = useOnce(onRevealed);
  const latest = useRef({ text, cardId, check, onChecked, rubric: card.rubric });
  useEffect(() => {
    latest.current = { text, cardId, check, onChecked, rubric: card.rubric };
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const finish = (o: ExplainOutcome) => {
    if (!alive.current) return;
    setOutcome(o);
    setPhase("checked");
    latest.current.onChecked?.(o);
    fire();
  };

  const runCheck = () => {
    if (sent.current) return;
    sent.current = true;
    const { text: t, cardId: id, check: send, rubric } = latest.current;
    const base = { text: t, fallback: false, failed: false };
    if (t.trim() === "") {
      const marks = rubricMarks(rubric, null);
      finish({ ...base, marks, rubric: marks.map(() => false) });
      return;
    }
    setPhase("checking");
    send(id, t).then(
      (res) => {
        const marks = rubricMarks(rubric, res);
        finish({ ...base, marks, rubric: marks.map((m) => m === "had"), fallback: res.fallback });
      },
      () => {
        const marks = rubricMarks(rubric, null);
        finish({ ...base, marks, rubric: marks.map(() => false), failed: true });
      },
    );
  };

  useImperativeHandle(ref, () => ({ check: runCheck }));

  useEffect(() => {
    if (autoFocus) areaRef.current?.focus({ preventScroll: true });
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const footer =
    phase === "checked" ? (
      onGrade ? (
        <GradeButtons mode={gradeMode} next={next} onGrade={onGrade} />
      ) : null
    ) : (
      <Button variant="primary" size="lg" block onClick={runCheck} loading={phase === "checking"} data-check="">
        {CHECK_IT}
      </Button>
    );

  return (
    <>
      <CardSurface section={section} conceptNames={conceptNames} rung={rung} className={className}>
        <h2 className={QUESTION_CLASS}>{card.q}</h2>
        <textarea
          ref={areaRef}
          aria-label={EXPLAIN_PLACEHOLDER}
          placeholder={EXPLAIN_PLACEHOLDER}
          rows={4}
          value={text}
          readOnly={phase !== "front"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
            if (e.nativeEvent.isComposing || e.repeat) return;
            // Prevented here, so the session's own key hook leaves it alone: one send.
            e.preventDefault();
            runCheck();
          }}
          className={
            "mt-4 block min-h-[116px] w-full resize-y rounded-2xl border border-solid border-line bg-paper px-4 py-3 " +
            "text-[16px] leading-normal text-ink placeholder:text-ink-3 [font:inherit] " +
            "focus-visible:border-ink-3 focus-visible:outline-none read-only:text-ink-2"
          }
        />
        {outcome ? (
          <RevealedAnswer>
            <Rubric labels={card.rubric.map(([label]) => label)} marks={outcome.marks} />
            {outcome.fallback ? (
              <p className="mono mt-3 text-ink-3" data-testid="quick-check">
                {QUICK_CHECK_NOTE}
              </p>
            ) : null}
            {outcome.failed ? (
              <p className="mt-3 text-[13px] text-ink-3" data-testid="check-failed">
                {CHECK_FAILED}
              </p>
            ) : null}
            <p className="mt-4 text-[15px] leading-normal whitespace-pre-line [overflow-wrap:anywhere]" data-testid="sc-model">
              <span className="mono mb-1 block text-ink-3">{MODEL_ANSWER}</span>
              {card.model}
            </p>
            <WhyLine why={card.why} />
            <SourceChip source={card.source} />
          </RevealedAnswer>
        ) : null}
      </CardSurface>
      {footer ? actionsEl ? createPortal(footer, actionsEl) : <div className="mt-6">{footer}</div> : null}
    </>
  );
}

const CheckIcon = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className="size-3.5 fill-none stroke-current text-accent [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:2]"
  >
    <path d="M6 12.5l4 4L18 8" />
  </svg>
);

function Rubric({ labels, marks }: { labels: string[]; marks: RubricMark[] }) {
  const mode = useMotionMode();
  return (
    <ul className="grid list-none gap-2.5 p-0" data-testid="rubric">
      {labels.map((label, k) => {
        const mark = marks[k] ?? "neutral";
        return (
          <motion.li
            key={k}
            data-mark={mark}
            className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-2.5 text-[15px] leading-normal"
            initial={mode === "instant" ? false : mode === "full" ? { opacity: 0, x: -6 } : { opacity: 0 }}
            animate={{ opacity: 1, x: 0 }}
            transition={
              mode === "full"
                ? { duration: 0.22, delay: 0.24 + k * 0.09, ease: ease.out }
                : { duration: calmDuration }
            }
          >
            <span
              aria-hidden="true"
              className={"grid size-[22px] place-items-center rounded-full " + (mark === "had" ? "bg-mint" : "")}
            >
              {mark === "had" ? (
                <CheckIcon />
              ) : (
                <i className={"block size-2 rounded-full " + (mark === "miss" ? "bg-due" : "bg-ink-3")} />
              )}
            </span>
            <span className="[overflow-wrap:anywhere]">{label}</span>
            {mark === "neutral" ? (
              <span />
            ) : (
              <span className={"mono pt-[3px] whitespace-nowrap " + (mark === "miss" ? "text-due" : "text-ink-3")}>
                {mark === "had" ? HAD_TAG : MISSING_TAG}
              </span>
            )}
          </motion.li>
        );
      })}
    </ul>
  );
}
