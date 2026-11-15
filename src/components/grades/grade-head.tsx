"use client";

/**
 * Course grade page top: a sticky "Back to grades", the course dot and name as
 * the heading, the code, the big trajectory number (or "–") with
 * "ON THIS TRAJECTORY" and the transcript line ("a 4 on your transcript" or
 * "Nothing graded yet"), and one plain verdict sentence ("Within reach. For
 * your 5 you need about 83% on what is left.").
 *
 * Plain data in: the grade maths lives in `@/lib/grades/model` (M6-03); this
 * file only words its results. Numbers roll when they change (static when
 * motion is calm or ?fast=1, via RollingNumber).
 * Source: prototype merged.html gxCard (JS 4088-4122), CSS .gp-head, .gx-name,
 * .gx-hv (1429-1465); verdict copy from inventory.md section 8 (b).
 */
import type { ReactNode } from "react";
import type { CourseColor } from "@/components/shell/side-nav";
import { fmt1 } from "@/components/grades/trajectory-chart";
import { Button } from "@/components/ui/button";
import { RollingNumber } from "@/components/ui/rolling-number";
import { StickyHeader } from "@/components/ui/sticky-header";
import type { Verdict } from "@/lib/grades/model";

export type VerdictTone = "on" | "within" | "out";

/** A piece of verdict copy: plain text, or a number that rolls when it changes. */
export type VerdictPart = string | { n: string };

export type VerdictCopy = {
  tone: VerdictTone;
  /** "On track", "Within reach." or "Out of reach.", shown in the tone colour. */
  lead: string;
  /** The rest of the sentence, starting with a space. */
  rest: VerdictPart[];
};

/** Percent shown for a "needed" value: never below 0, whole number. */
export const needPct = (need: number) => String(Math.round(Math.max(0, need)));

/**
 * The verdict line's words for `verdict` (from model.ts `verdict`) at
 * `target`. `null` when the course needs weights (no verdict to say).
 */
export function verdictCopy(v: Verdict, target: number): VerdictCopy | null {
  const t = String(target);
  switch (v.kind) {
    case "all_graded":
      return { tone: "on", lead: "On track.", rest: [" Everything is graded."] };
    case "on":
      return { tone: "on", lead: "On track", rest: [" for your ", { n: t }, "."] };
    case "within":
      return {
        tone: "within",
        lead: "Within reach.",
        rest: [" For your ", { n: t }, " you need about ", { n: needPct(v.need) }, "% on what is left."],
      };
    case "out": {
      const rest: VerdictPart[] = [" Best possible is ", { n: fmt1(v.best) }, "."];
      if (v.nextGrade > 0 && v.nextGradeNeed != null) {
        rest.push(" A ", { n: String(v.nextGrade) }, " needs about ", { n: needPct(v.nextGradeNeed) }, "%.");
      }
      return { tone: "out", lead: "Out of reach.", rest };
    }
    default:
      return null;
  }
}

/** The verdict as one plain sentence. */
export function verdictSentence(v: Verdict, target: number): string {
  const c = verdictCopy(v, target);
  if (!c) return "";
  return c.lead + c.rest.map((p) => (typeof p === "string" ? p : p.n)).join("");
}

/** Renders verdict parts, rolling the numbers. */
export function VerdictParts({ parts }: { parts: VerdictPart[] }): ReactNode {
  return parts.map((p, i) =>
    typeof p === "string" ? <span key={i}>{p}</span> : <RollingNumber key={i} value={p.n} />,
  );
}

export const TONE_TEXT: Record<VerdictTone, string> = {
  on: "text-accent",
  within: "text-ink",
  out: "text-due",
};

const DOT: Record<CourseColor, string> = {
  butter: "bg-butter",
  mint: "bg-mint",
  sky: "bg-sky",
  blush: "bg-accent-wash",
};

export type GradeHeadProps = {
  /** Course name, the page heading. */
  name: string;
  /** Course code, for example "CHEM-A1250". */
  code: string;
  dot: CourseColor;
  /** model.ts `trajectory`, 0..5. `null` shows "–". */
  trajectory: number | null;
  /** The whole grade on this trajectory. `null` shows "Nothing graded yet". */
  transcript: number | null;
  /** model.ts `verdict` at `target`. */
  verdict: Verdict;
  /** False hides the verdict line, for a page that states the verdict itself just below (M6-08's Overview). */
  showVerdict?: boolean;
  /** The grade she is aiming for, 1..5. */
  target: number;
  /** Back to the grades list. */
  onBack?: () => void;
  /** Or a link back to the grades list. */
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

export function GradeHead({
  name,
  code,
  dot,
  trajectory,
  transcript,
  verdict,
  target,
  onBack,
  backHref,
  showVerdict = true,
  className = "",
}: GradeHeadProps) {
  const copy = verdictCopy(verdict, target);
  const back = (
    <>
      <BackIcon />
      Back to grades
    </>
  );

  return (
    <div className={className}>
      <StickyHeader className="py-1">
        {backHref ? (
          <Button variant="text" size="sm" href={backHref} className="-ml-3 !px-3 !gap-1.5">
            {back}
          </Button>
        ) : (
          <Button variant="text" size="sm" onClick={onBack} className="-ml-3 !px-3 !gap-1.5">
            {back}
          </Button>
        )}
      </StickyHeader>

      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 tabIndex={-1} className="type-h26 flex items-center gap-2.5 outline-none">
            <i
              aria-hidden="true"
              className={`inline-block h-3 w-3 flex-none rounded-full shadow-[inset_0_0_0_1px_var(--line)] ${DOT[dot]}`}
            />
            <span className="min-w-0">{name}</span>
          </h1>
          <p className="mono mt-1 text-ink-3">{code}</p>
        </div>
        <div className="flex-none text-right">
          <p
            data-testid="grade-head-num"
            className={`font-display text-[44px] font-semibold leading-none [font-variation-settings:'SOFT'_100] ${
              trajectory == null ? "text-ink-3" : "text-ink"
            }`}
          >
            {trajectory == null ? "–" : <RollingNumber value={fmt1(trajectory)} />}
          </p>
          <p className="mono mt-1.5 text-ink-3">ON THIS TRAJECTORY</p>
          <p className="mt-0.5 text-[13px] text-ink-2">
            {transcript == null ? "Nothing graded yet" : `a ${transcript} on your transcript`}
          </p>
        </div>
      </div>

      {copy && showVerdict && (
        <p className="mt-2.5 text-[14px] text-ink-2" data-testid="grade-head-verdict">
          {copy.lead}
          <VerdictParts parts={copy.rest} />
        </p>
      )}
    </div>
  );
}
