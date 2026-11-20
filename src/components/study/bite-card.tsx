"use client";

/**
 * Today's bite block on the exam page. Source: prototype merged.html JS
 * 5951-5960 (todayHTML) and 3115-3118 (biteBlock, the done state); CSS 609-611
 * (.ss-card, .ss-title, .ss-line), 1193-1198 (.bite-top, .gain-chip,
 * .bite-done) and 1401-1404 (.bite-h, .bite-then).
 *
 * One number, one sentence, one action:
 *  - "bite": "Today's bite" (or "One more bite" once one is done), the
 *    minutes / cards / focus line, the "+0.6% forecast" gain chip (measured;
 *    left out under half a point), "Start bite",
 *    and a mono "Then: bite 2 of 2, 4 min" line when another bite follows.
 *    A paced exam says its pace there instead: "3 bites today keeps you on
 *    track for Monday." With more than three bites left it says the time,
 *    "About 25 minutes today keeps you on track for Mon 23 Nov (7 bites).",
 *    and `onLong` adds "Do them in one go" beside "Start bite".
 *  - "done": "TODAY'S BITES", the cup doodle, "Today's plan is done", the next
 *    reviews sentence plus "Rest counts too.", and "Practise anyway".
 * Takes plain data: the page using it decides minutes and gain (the gain
 * comes from the forecast logic). The page must render <DoodleDefs /> once.
 */
import { useId } from "react";
import { Doodle } from "@/components/doodle";
import { Button } from "@/components/ui/button";
import { gainLabel } from "@/lib/study/forecast";

export type BiteCardNext = {
  /** 1-based number of the bite that follows. */
  number: number;
  /** Bites planned today. */
  of: number;
  /** Minutes the following bite takes. */
  minutes: number;
};

export type BiteCardProps =
  | {
      state: "bite";
      /** True once a bite is done today: the heading becomes "One more bite". */
      more?: boolean;
      /** Minutes this bite takes. */
      minutes: number;
      /** Cards in this bite. */
      cards: number;
      /** Forecast points the bite is worth, not rounded: "+0.6%". Under half a point (or null) the chip is left out. */
      gain: number | null;
      /** Name of the concept most of the cards are about. */
      focus: string;
      /** The bite after this one, if any. */
      next?: BiteCardNext;
      /** A paced exam: today's pace as one sentence, shown instead of `next`. */
      pace?: string;
      onStart?: () => void;
      /** Today's remaining plan as one longer session: shows "Do them in one go". */
      onLong?: () => void;
      className?: string;
    }
  | {
      state: "done";
      /** When the next reviews are due, as one sentence, e.g. "Next reviews tomorrow." */
      nextReviews: string;
      onPractise?: () => void;
      className?: string;
    };

const CARD =
  "rounded-[20px] border border-solid border-line bg-surface p-5 shadow-[var(--shadow-card)]";

export function BiteCard(props: BiteCardProps) {
  const labelId = useId();
  const cls = props.className ? `${CARD} ${props.className}` : CARD;

  if (props.state === "done") {
    return (
      <section className={cls} aria-labelledby={labelId}>
        <h2
          id={labelId}
          className="mono mb-2.5 font-medium uppercase tracking-[0.04em] text-ink-3 [font-variation-settings:normal]"
        >
          Today&rsquo;s bites
        </h2>
        <div className="mb-4 mt-1 flex items-center gap-3.5">
          <Doodle name="cup" size={64} className="flex-none" />
          <div className="min-w-0">
            <p className="font-display text-[22px] font-semibold leading-[1.2] tracking-[-0.01em] [font-variation-settings:'SOFT'_100]">
              Today&rsquo;s plan is done
            </p>
            <p className="mt-1.5 text-[15px] text-ink-2">
              {props.nextReviews} Rest counts too.
            </p>
          </div>
        </div>
        <Button variant="secondary" block className="mt-[18px]" onClick={props.onPractise}>
          Practise anyway
        </Button>
      </section>
    );
  }

  const { more = false, minutes, cards, gain, focus, next, pace, onStart, onLong } = props;
  const gainText = gainLabel(gain);
  return (
    <section className={cls} aria-labelledby={labelId}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={labelId} className="text-[24px] leading-[1.2]">
            {more ? "One more bite" : "Today’s bite"}
          </h2>
          <p className="mt-1.5 text-[15px] text-ink-2">
            {minutes} min · {cards} cards · mostly {focus}
          </p>
        </div>
        {gainText ? (
          <span className="grid flex-none justify-items-center rounded-2xl bg-mint px-3 py-2" data-testid="gain-chip">
            <b className="font-display text-[22px] font-semibold leading-none [font-variation-settings:'SOFT'_100]">
              {gainText}
            </b>
            <span className="text-[11px] text-ink-2">forecast</span>
          </span>
        ) : null}
      </div>
      {onLong ? (
        <div className="mt-[18px] grid gap-2 min-[480px]:grid-cols-2">
          <Button size="lg" block onClick={onStart}>
            Start bite
          </Button>
          <Button size="lg" variant="secondary" block onClick={onLong}>
            Do them in one go
          </Button>
        </div>
      ) : (
        <Button size="lg" block className="mt-[18px]" onClick={onStart}>
          Start bite
        </Button>
      )}
      {pace ? (
        <p className="mt-3 text-center text-[13px] text-ink-2" data-testid="bite-pace">
          {pace}
        </p>
      ) : next ? (
        <p className="mono mt-3 text-center text-ink-3">
          Then: bite {next.number} of {next.of}, {next.minutes} min
        </p>
      ) : null}
    </section>
  );
}
