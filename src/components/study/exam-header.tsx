"use client";

/**
 * Exam page header: a back button ("Back to exams"), the course name as the
 * heading, a mono line under it ("EXAM · FRI 20 NOV 09:00"), and a chip with a
 * 44 px ring and one sentence: "64% right today. On track with a bite a day."
 *
 * After a bite, pass `rollFrom` (the old forecast) and the ring's number rolls
 * up from it to `forecast`. Calm motion shows the new number at once.
 * Source: prototype merged.html epHTML (JS 3213-3215), applyRollFrom, and CSS
 * .eh / .eh-t / .eh-h1 / .eh-sub / .eh-chip (1393-1400).
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Ring } from "@/components/ui/ring";
import { RollingNumber } from "@/components/ui/rolling-number";

export type ExamHeaderProps = {
  /** Course name, the page heading. */
  course: string;
  /** Mono line under the heading, for example "Exam · Fri 20 Nov 09:00". Shown in capitals. */
  sub: string;
  /** Today's forecast, 0..100, already rounded by the page. */
  forecast: number;
  /** The verdict sentence, for example "On track with a bite a day". A full stop is added if missing. */
  verdict: string;
  /** The old forecast, when coming back from a bite. The ring's number rolls from it. */
  rollFrom?: number;
  /** The exam is over: the chip says only the verdict ("This exam is over."), no ring and no "right today". */
  over?: boolean;
  /** Back to the exams list. */
  onBack?: () => void;
  /** Or a link back to the exams list. */
  backHref?: string;
  className?: string;
};

const BackIcon = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className="h-5 w-5 flex-none fill-none stroke-current"
    style={{ strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }}
  >
    <path d="M14.5 5.5L8 12l6.5 6.5" />
  </svg>
);

/** Shows `from` on the first paint, then `to`, so RollingNumber rolls between them. */
function useRolled(to: number, from: number | undefined) {
  const [shown, setShown] = useState(from ?? to);
  useEffect(() => {
    if (shown === to) return;
    const id = window.requestAnimationFrame(() => setShown(to));
    return () => window.cancelAnimationFrame(id);
  }, [to, shown]);
  return shown;
}

export function ExamHeader({
  course,
  sub,
  forecast,
  verdict,
  rollFrom,
  over = false,
  onBack,
  backHref,
  className = "",
}: ExamHeaderProps) {
  const f = Math.round(Math.min(100, Math.max(0, forecast)));
  const from = rollFrom == null ? undefined : Math.round(Math.min(100, Math.max(0, rollFrom)));
  const shown = useRolled(f, from);
  const sentence = verdict.replace(/\.?$/, ".");

  return (
    <div className={`flex flex-wrap items-center gap-x-3.5 gap-y-2.5 ${className}`}>
      {backHref ? (
        <Button variant="icon" href={backHref} aria-label="Back to exams" className="-ml-3">
          <BackIcon />
        </Button>
      ) : (
        <Button variant="icon" onClick={onBack} aria-label="Back to exams" className="-ml-3">
          <BackIcon />
        </Button>
      )}
      {/* At least 240 px for the title: a short chip line must wrap under it, never squeeze it to a word a line. */}
      <div data-testid="exam-header-title" className="min-w-0 flex-[1_1_240px]">
        <h1 tabIndex={-1} className="text-[24px] leading-[1.15] outline-none">
          {course}
        </h1>
        <p className="mono mt-0.5 text-ink-3">{sub.toUpperCase()}</p>
      </div>
      <div
        data-chip=""
        className="flex max-w-[340px] items-center gap-2.5 rounded-full border border-line bg-surface py-1.5 pl-1.5 pr-3.5"
      >
        {/* The ring has 36/48/76/92 sizes; the chip's is 44 px, so the 48 one is sized down. */}
        {!over && (
        <Ring
          value={f}
          size={48}
          ariaLabel={`${f} percent forecast`}
          label={<RollingNumber value={shown} />}
          style={{ width: 44, height: 44 }}
          className="[&>svg]:!h-[44px] [&>svg]:!w-[44px]"
        />
        )}
        <p className={`text-[13px] leading-[1.35] text-ink-2 ${over ? "py-1 pl-2" : ""}`}>
          {over ? sentence : `${f}% right today. ${sentence}`}
        </p>
      </div>
    </div>
  );
}
