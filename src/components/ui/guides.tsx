"use client";

/**
 * Guides: pencil-dashed outlines sketched around parts of a screen before
 * they appear (Home's first arrival, the Welcome screen).
 * Source: prototype main-flow.html JS 2200-2220 (drawGuides) and CSS 550-554
 * (.guides): a dashed, wobbly rounded rectangle 5 px wider and 4 px taller
 * than each part on every side, wiped in from the left over 300 ms, one
 * every 40 ms.
 *
 *   <div className="relative">
 *     <section data-guide>...</section>
 *     <Guides targets="[data-guide]" fadeAfterMs={900} onDone={...} />
 *   </div>
 *
 * - Put it inside the positioned element (`relative`) that holds the parts.
 *   It measures the parts when it mounts and draws over that element. It is
 *   absolutely placed and holds nothing until then, so nothing shifts.
 * - `fadeAfterMs`: the outlines fade over 300 ms after this long, then the
 *   drawing is gone and `onDone` is called. Or set `fade` when it is time.
 *   Leave both out to keep the outlines.
 * - Needs the #wobble filter on the page (`DoodleDefs`).
 * - Calm (reduced motion) and the test switch (?fast=1): draws nothing and
 *   calls `onDone` at once.
 */
import { motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

/** One outline wipes in over this long, the next one this much later. */
export const GUIDE_DRAW_MS = 300;
export const GUIDE_STAGGER_MS = 40;
/** The fade at the end. */
export const GUIDE_FADE_MS = 300;

/** How far the outline sits outside the part. */
const PAD_X = 5;
const PAD_Y = 4;

export type GuideBox = { x: number; y: number; width: number; height: number };

type Drawing = { width: number; height: number; boxes: GuideBox[] };

/**
 * Where `el` sits inside `container`, ignoring transforms (a part may be
 * mid-rise when it is measured). Falls back to the on-screen boxes when
 * `container` is not one of the part's offset parents.
 */
export function boxWithin(el: HTMLElement, container: HTMLElement): GuideBox {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== container) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  if (node !== container) {
    const r = el.getBoundingClientRect();
    const c = container.getBoundingClientRect();
    x = r.left - c.left + container.scrollLeft;
    y = r.top - c.top + container.scrollTop;
  }
  return { x: x - PAD_X, y: y - PAD_Y, width: el.offsetWidth + 2 * PAD_X, height: el.offsetHeight + 2 * PAD_Y };
}

export type GuidesProps = {
  /** CSS selector for the parts to outline, looked up inside the element that holds this drawing. */
  targets: string;
  /** Fade the outlines after this many ms, then remove them. Leave out to keep them. */
  fadeAfterMs?: number;
  /** Fade the outlines now, then remove them. */
  fade?: boolean;
  /** Called when the outlines are gone (or at once when motion is calm). */
  onDone?: () => void;
  className?: string;
};

const HIDDEN = { clipPath: "inset(0px 100% 0px 0px)" };
const DRAWN = { clipPath: "inset(0px 0% 0px 0px)" };

export function Guides({ targets, fadeAfterMs, fade = false, onDone, className = "" }: GuidesProps) {
  const mode = useMotionMode();
  const svgRef = useRef<SVGSVGElement>(null);
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [step, setStep] = useState<"drawn" | "fading" | "gone">("drawn");
  const state = step === "drawn" && fade ? "fading" : step;
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });

  const show = mode === "full" && state !== "gone";

  // Measure before the first paint.
  useLayoutEffect(() => {
    const container = svgRef.current?.parentElement;
    if (!show || !container) return;
    const parts = Array.from(container.querySelectorAll<HTMLElement>(targets));
    setDrawing({
      width: container.clientWidth,
      height: container.scrollHeight,
      boxes: parts.map((p) => boxWithin(p, container)),
    });
  }, [show, targets]);

  useEffect(() => {
    if (mode !== "full") {
      done.current?.();
      return;
    }
    if (fadeAfterMs === undefined) return;
    const t = window.setTimeout(() => setStep((s) => (s === "drawn" ? "fading" : s)), fadeAfterMs);
    return () => window.clearTimeout(t);
  }, [mode, fadeAfterMs]);

  if (!show) return null;

  return (
    <motion.svg
      ref={svgRef}
      aria-hidden="true"
      focusable="false"
      data-guides={state}
      width={drawing?.width ?? 0}
      height={drawing?.height ?? 0}
      className={`pointer-events-none absolute top-0 left-0 z-0 overflow-visible ${className}`.trim()}
      initial={false}
      animate={{ opacity: state === "fading" ? 0 : 1 }}
      transition={{ duration: GUIDE_FADE_MS / 1000, ease: "linear" }}
      onAnimationComplete={() => {
        if (state !== "fading") return;
        setStep("gone");
        done.current?.();
      }}
    >
      {drawing?.boxes.map((b, i) => (
        <motion.g
          key={i}
          filter="url(#wobble)"
          initial={HIDDEN}
          animate={DRAWN}
          transition={{ duration: GUIDE_DRAW_MS / 1000, delay: (i * GUIDE_STAGGER_MS) / 1000, ease: ease.out }}
        >
          <rect
            x={b.x}
            y={b.y}
            width={b.width}
            height={b.height}
            rx={10}
            className="fill-none stroke-ink-3 opacity-55 [stroke-dasharray:5_6] [stroke-linecap:round] [stroke-width:1.5]"
          />
        </motion.g>
      ))}
    </motion.svg>
  );
}
