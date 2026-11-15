"use client";

/**
 * Top of the exam page's Progress tab: the big line "64% right if it were
 * today", the sentence "That is a 3 today. A bite a day gets you to about 88%
 * by Friday." (the plan part is the page's own sentence, `planLine`, when it
 * gives one), then the forecast chart under a hairline.
 *
 * The tab panels stay mounted while hidden, so the chart waits for `shown`:
 * it mounts (and draws) the first time the Progress tab is shown, and stays
 * after that. Pass `rollFrom` after a bite and the big number rolls up.
 * Source: prototype merged.html progressHTML (JS 5961-5968) and CSS .pg-big /
 * .pg-chart (1405-1408), .ed-sub, .fc-num.
 */
import { useEffect, useState } from "react";
import { ForecastChart, type ForecastChartData } from "@/components/study/forecast-chart";
import { RollingNumber } from "@/components/ui/rolling-number";

export type ProgressHeadProps = {
  /** Today's forecast, 0..100, already rounded by the page. */
  forecast: number;
  /** Today's grade, 0..5. */
  grade: number;
  /** Where a bite a day ends on exam day, 0..100, already rounded. */
  planEnd: number;
  /** Exam day as the sentence says it: "Friday" within six days, else "Mon 23 Nov". */
  dayName: string;
  /** The plan sentence, from the exam's plan (`planSentence`); it replaces the "A bite a day ..." built from `planEnd`. */
  planLine?: string;
  /** Data for the chart under the headline. */
  chart: ForecastChartData;
  /** True while the Progress tab is shown. The chart mounts the first time. */
  shown?: boolean;
  /** The old forecast, when coming back from a bite. The big number rolls from it. */
  rollFrom?: number;
  /** Said instead of the grade and plan sentence, and the chart left out, when there is no plan to promise. */
  note?: string;
  className?: string;
};

export function ProgressHead({
  forecast,
  grade,
  planEnd,
  dayName,
  planLine,
  chart,
  shown = true,
  rollFrom,
  note,
  className = "",
}: ProgressHeadProps) {
  const f = Math.round(Math.min(100, Math.max(0, forecast)));
  const [seen, setSeen] = useState(shown);
  if (shown && !seen) setSeen(true);

  const [num, setNum] = useState(rollFrom == null ? f : Math.round(rollFrom));
  useEffect(() => {
    if (num === f) return;
    const id = window.requestAnimationFrame(() => setNum(f));
    return () => window.cancelAnimationFrame(id);
  }, [f, num]);

  return (
    <div className={`[&>*+*]:mt-5 ${className}`}>
      <div>
        <p className="font-display text-[20px] font-semibold leading-[1.2] [font-variation-settings:'SOFT'_100]">
          <RollingNumber
            value={`${num}%`}
            className="text-[40px] leading-none tracking-[-0.02em]"
          />{" "}
          right if it were today
        </p>
        <p className="mt-0.5 text-[13px] text-ink-2">
          {note ??
            `That is a ${grade} today. ${planLine ?? `A bite a day gets you to about ${Math.round(planEnd)}% by ${dayName}.`}`}
        </p>
      </div>
      {/* With a note there is no plan, so no chart of where a plan would end either. */}
      {note == null && (
        <div className="border-t border-line pt-3.5">
          {seen ? <ForecastChart {...chart} /> : <div className="min-h-[176px]" aria-hidden="true" />}
        </div>
      )}
    </div>
  );
}
