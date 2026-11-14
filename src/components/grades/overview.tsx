"use client";

/**
 * Course grade page, Overview tab: the verdict large in its tone (on track,
 * within reach, out of reach), "Aiming for" with a 1 to 5 control, and two
 * facts: what she needs ("You need about 83% on what is left" /
 * "Everything is graded." / "Out of reach: the best possible is 4.6.") and what
 * matters most ("Exam matters most (60% of the grade)" / "Nothing left to
 * grade"). Numbers roll when the target changes (static when motion is calm or
 * ?fast=1).
 *
 * Plain data in: the caller passes model.ts `verdict(items, target)` and
 * `mattersMost(items, whatIfs)` and recomputes them on `onTargetChange`.
 * Source: prototype merged.html gxCard Overview panel (JS 4088-4122),
 * gradeFacts (6015-6020), CSS .vbig, .facts, .gx-aim (1429-1465).
 */
import { useId } from "react";
import { fmt1 } from "@/components/grades/trajectory-chart";
import {
  needPct,
  TONE_TEXT,
  verdictCopy,
  VerdictParts,
} from "@/components/grades/grade-head";
import { RollingNumber } from "@/components/ui/rolling-number";
import { useMotionMode } from "@/lib/motion/use-calm";
import type { Verdict } from "@/lib/grades/model";

export type GradeTarget = 1 | 2 | 3 | 4 | 5;
const TARGETS: GradeTarget[] = [1, 2, 3, 4, 5];

export type OverviewProps = {
  /** model.ts `verdict(items, target)`. */
  verdict: Verdict;
  /** The grade she is aiming for. */
  target: GradeTarget;
  onTargetChange: (target: GradeTarget) => void;
  /** model.ts `mattersMost(items, whatIfs)`: its name and weight (fraction), or `null`. */
  mattersMost: { name: string; weight: number } | null;
  className?: string;
};

function NeedFact({ verdict }: { verdict: Verdict }) {
  switch (verdict.kind) {
    case "all_graded":
      return <>Everything is graded.</>;
    case "out":
      return (
        <>
          Out of reach: the best possible is <RollingNumber value={fmt1(verdict.best)} />.
        </>
      );
    case "on":
    case "within":
      return (
        <>
          You need about <RollingNumber value={needPct(verdict.need)} />% on what is left
        </>
      );
    default:
      return null;
  }
}

export function Overview({
  verdict,
  target,
  onTargetChange,
  mattersMost,
  className = "",
}: OverviewProps) {
  const aimId = useId();
  const mode = useMotionMode();
  const copy = verdictCopy(verdict, target);
  const fade = mode === "instant" ? "" : "transition-[background-color,color,box-shadow] duration-quick ease-out";

  return (
    <div className={className}>
      {copy && (
        <p
          data-testid="overview-verdict"
          data-tone={copy.tone}
          className="font-display text-[22px] font-semibold leading-[1.3] [font-variation-settings:'SOFT'_100]"
        >
          <span className={TONE_TEXT[copy.tone]}>{copy.lead}</span>
          <VerdictParts parts={copy.rest} />
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span id={aimId} className="text-[15px] text-ink-2">
          Aiming for
        </span>
        <div
          role="group"
          aria-labelledby={aimId}
          className="inline-flex items-center gap-0.5 rounded-full border border-solid border-line bg-surface p-[3px]"
        >
          {TARGETS.map((n) => {
            const on = n === target;
            return (
              <button
                key={n}
                type="button"
                aria-pressed={on}
                onClick={() => onTargetChange(n)}
                className={
                  "relative grid size-10 place-items-center rounded-full border-0 font-mono text-[14px] " +
                  "before:absolute before:-inset-0.5 before:content-[''] " +
                  (on
                    ? "bg-ink font-semibold text-surface "
                    : "bg-transparent text-ink-2 hover:bg-paper hover:text-ink ") +
                  fade
                }
              >
                {n}
              </button>
            );
          })}
        </div>
      </div>

      <ul className="mt-5 list-none border-t border-solid border-line">
        <li data-testid="overview-need" className="border-b border-solid border-line py-3.5 text-[15px]">
          <NeedFact verdict={verdict} />
        </li>
        <li data-testid="overview-mm" className="border-b border-solid border-line py-3.5 text-[15px]">
          {mattersMost
            ? `${mattersMost.name} matters most (${Math.round(mattersMost.weight * 100)}% of the grade)`
            : "Nothing left to grade"}
        </li>
      </ul>
    </div>
  );
}
