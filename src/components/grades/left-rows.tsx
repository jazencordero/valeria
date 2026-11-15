"use client";

/**
 * "WHAT IS LEFT": one row per ungraded item with its name, the MATTERS MOST
 * tag on the item with the widest swing, "60% of the grade · Exam week", a
 * swing bar (the course grade if she scores 50% vs 100% on it: "grade 2.9 to
 * 5.0", or "needs a what-if first"), and a 0 to 100 what-if slider with the
 * reading "if you score 78%" / "drag to try a score".
 *
 * Live and on release: while a slider moves, this whole block recalculates
 * with the live value (every swing and MATTERS MOST); when it is let go
 * (pointer up, key up or the native change event) `onRelease(id, value)` is
 * called once, so the page can roll its summary. "Reset what-ifs" shows once
 * any what-if is set and calls `onReset`. What-ifs are not saved: the parent
 * keeps them in memory.
 *
 * Plain data in, no fetching. Maths: model.ts `swing`, `mattersMost`,
 * `soFar`, and `normaliseWeights` via `weightLabels` (M6-03).
 * Source: prototype main-flow.html CSS 519-546 (.lrow, .swing, .whatif,
 * .wi-read, .gx-reset) and JS 3837-3865 (renderCourse).
 */
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { fmt1 } from "@/components/grades/trajectory-chart";
import { SECTION_LABEL, weightLabels, type RowItem } from "@/components/grades/graded-list";
import { useMotionMode } from "@/lib/motion/use-calm";
import {
  mattersMost,
  NEEDS_WEIGHTS,
  soFar,
  swing,
  type GradeUnit,
  type WhatIfs,
} from "@/lib/grades/model";

export type LeftRowsProps = {
  /** Every item of the course, graded and not: the maths needs all of them. */
  items: RowItem[];
  /** The what-ifs the page holds (after each release). */
  whatIfs: WhatIfs;
  unit?: GradeUnit;
  /** Called once when a slider is let go, with its value in percent. */
  onRelease: (id: string, value: number) => void;
  /** "Reset what-ifs": the page clears its what-ifs. */
  onReset: () => void;
  className?: string;
};

const clampPct = (v: number) => Math.min(100, Math.max(0, Math.round(v)));

type Live = { id: string; value: number } | null;

export function LeftRows({
  items,
  whatIfs,
  unit = "share",
  onRelease,
  onReset,
  className = "",
}: LeftRowsProps) {
  const headId = useId();
  const [live, setLive] = useState<Live>(null);
  // The value waiting to be released. A ref, so the native listeners and a
  // pointerup in the same tick see it, and so one drag releases once.
  const pending = useRef<Live>(null);
  const onReleaseRef = useRef(onRelease);
  useEffect(() => {
    onReleaseRef.current = onRelease;
  }, [onRelease]);

  const opts = { unit };
  const eff: WhatIfs = live ? { ...whatIfs, [live.id]: live.value } : whatIfs;
  const left = items.filter((it) => it.score == null);
  if (!left.length) return null;

  const sfRaw = soFar(items, opts);
  const sf = sfRaw === NEEDS_WEIGHTS ? null : sfRaw;
  const needsWeights = sfRaw === NEEDS_WEIGHTS;
  const mm = mattersMost(items, eff, opts);
  const topId = mm && mm !== NEEDS_WEIGHTS ? mm.id : null;
  const weights = weightLabels(items, unit);
  const anySet = live != null || Object.values(whatIfs).some((v) => v != null);

  const move = (id: string, value: number) => {
    const v = clampPct(value);
    pending.current = { id, value: v };
    setLive({ id, value: v });
  };
  const release = () => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    setLive(null);
    onReleaseRef.current(p.id, p.value);
  };
  const reset = () => {
    pending.current = null;
    setLive(null);
    onReset();
  };

  return (
    <section className={className} aria-labelledby={headId}>
      <h3 id={headId} className={SECTION_LABEL}>
        What is left
      </h3>
      <ul className="list-none">
        {left.map((it) => {
          const set = eff[it.id] != null;
          const value = set ? (eff[it.id] as number) : sf != null ? clampPct(sf) : 50;
          const sw = needsWeights ? null : swing(it, items, eff, opts);
          const range = sw && sw !== NEEDS_WEIGHTS ? sw : null;
          const w = weights[it.id];
          const meta = [w && (unit === "points" ? w : `${w} of the grade`), it.when]
            .filter(Boolean)
            .join(" · ");
          return (
            <LeftRow
              key={it.id}
              item={it}
              top={topId === it.id}
              meta={meta}
              range={range}
              showSwing={!needsWeights}
              value={value}
              reading={sf == null && !set ? "drag to try a score" : `if you score ${value}%`}
              onMove={move}
              onRelease={release}
            />
          );
        })}
      </ul>
      {anySet && (
        <Button
          variant="text"
          size="sm"
          className="mt-2 px-0! text-[13px]"
          onClick={reset}
          data-testid="reset-whatifs"
        >
          Reset what-ifs
        </Button>
      )}
    </section>
  );
}

type LeftRowProps = {
  item: RowItem;
  top: boolean;
  meta: string;
  range: { lo: number; hi: number } | null;
  showSwing: boolean;
  value: number;
  reading: string;
  onMove: (id: string, value: number) => void;
  onRelease: () => void;
};

const SLIDER =
  "block h-11 w-full cursor-pointer appearance-none bg-transparent " +
  "[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full " +
  "[&::-webkit-slider-runnable-track]:bg-line " +
  "[&::-webkit-slider-thumb]:-mt-2.5 [&::-webkit-slider-thumb]:size-6 " +
  "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full " +
  "[&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-[var(--btn)] " +
  "[&::-webkit-slider-thumb]:shadow-[0_2px_0_var(--btn-ledge)] " +
  "[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-line " +
  "[&::-moz-range-thumb]:size-6 [&::-moz-range-thumb]:rounded-full " +
  "[&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--btn)]";

function LeftRow({
  item,
  top,
  meta,
  range,
  showSwing,
  value,
  reading,
  onMove,
  onRelease,
}: LeftRowProps) {
  const mode = useMotionMode();
  const inputRef = useRef<HTMLInputElement>(null);
  const releaseRef = useRef(onRelease);
  useEffect(() => {
    releaseRef.current = onRelease;
  }, [onRelease]);

  // React's onChange is the input event; the native change event is the
  // release (end of a drag, or a keyboard step).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onChange = () => releaseRef.current();
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, []);

  const swingText = range ? `grade ${fmt1(range.lo)} to ${fmt1(range.hi)}` : "needs a what-if first";
  // The bar is moved with transforms only (no layout per frame): a full-width
  // window slid to the low end, and inside it a full-width fill slid back so
  // its right end sits on the high end. Both are pill-shaped and the window
  // clips, so both ends stay round at any width (scaleX would flatten them).
  const lo = range ? (range.lo / 5) * 100 : 0;
  const span = range ? Math.max(2, ((range.hi - range.lo) / 5) * 100) : 0;
  const glide = mode === "full" ? "transition-transform duration-quick ease-out" : "";

  return (
    <li data-testid={`left-${item.id}`} className="border-t border-solid border-line pb-1 pt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[15px] font-medium">{item.name}</span>
        {top && (
          <Tag tone="strong" data-testid="matters-most">
            MATTERS MOST
          </Tag>
        )}
      </div>
      {meta && <p className="mono mt-0.5 text-ink-3">{meta}</p>}
      {showSwing && (
        <div className="mt-2 flex items-center gap-2.5">
          <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
            <i
              data-testid={`swing-bar-${item.id}`}
              className={`absolute inset-0 overflow-hidden rounded-full ${glide}`}
              style={{ transform: `translateX(${lo}%)` }}
            >
              <i
                data-testid={`swing-fill-${item.id}`}
                className={`absolute inset-0 rounded-full bg-ink-2 ${glide}`}
                style={{ transform: `translateX(${span - 100}%)` }}
              />
            </i>
          </div>
          <span data-testid={`swing-${item.id}`} className="mono whitespace-nowrap text-ink-3">
            {swingText}
          </span>
        </div>
      )}
      <input
        ref={inputRef}
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        aria-label={`What-if score for ${item.name}`}
        aria-valuetext={`${value}%`}
        onChange={(e) => onMove(item.id, Number(e.currentTarget.value))}
        onPointerUp={() => onRelease()}
        onKeyUp={() => onRelease()}
        className={`${SLIDER} mt-0.5`}
      />
      <p data-testid={`reading-${item.id}`} className="mono -mt-1 text-ink-2">
        {reading}
      </p>
    </li>
  );
}
