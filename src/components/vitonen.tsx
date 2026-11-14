"use client";

/**
 * Vitonen, the talking cap. Source: prototype main-flow.html template
 * 1239-1261 (the SVG), CSS 206-241 and 550-584 (parts, loops, reactions).
 *
 * Decoration only: always aria-hidden. Under 28 px it draws the simplified
 * "tiny" cap (no face, thicker lines).
 *
 *   const cap = useRef<VitonenHandle>(null);
 *   <Vitonen ref={cap} size={44} state="talking" />
 *   cap.current?.react("nod");
 *
 * When calm (reduced motion, or the instant test switch) the loops are off
 * and react() does nothing.
 */
import "./vitonen.css";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { durationMs, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

export type VitonenState = "idle" | "talking" | "thinking";
export type VitonenReaction = "nod" | "wince" | "cheer" | "peek" | "blink" | "swing";

export type VitonenHandle = {
  /** Plays one reaction. Does nothing when calm. */
  react: (reaction: VitonenReaction) => void;
};

export type VitonenProps = {
  /** Width in px, 20 to 120. Under 28 uses the tiny drawing. */
  size?: number;
  state?: VitonenState;
  className?: string;
  ref?: Ref<VitonenHandle>;
};

export const VITONEN_MIN = 20;
export const VITONEN_MAX = 120;
export const VITONEN_TINY_BELOW = 28;

/** Reactions done by toggling a prototype CSS class, with how long it stays. */
const CLASS_REACTIONS = { blink: 300, wince: 600, swing: 550 } as const;
type ClassReaction = keyof typeof CLASS_REACTIONS;

const cubic = (e: readonly number[]) => `cubic-bezier(${e.join(",")})`;

/** Reactions done with the Web Animations API on the whole cap. */
const MOVES: Record<Exclude<VitonenReaction, ClassReaction>, [Keyframe[], KeyframeAnimationOptions]> = {
  nod: [
    [
      { transform: "translateY(0) rotate(0deg)" },
      { transform: "translateY(4%) rotate(5deg)", offset: 0.3 },
      { transform: "translateY(0) rotate(0deg)", offset: 0.6 },
      { transform: "translateY(2.5%) rotate(3deg)", offset: 0.8 },
      { transform: "translateY(0) rotate(0deg)" },
    ],
    { duration: durationMs.slow, easing: cubic(ease.inout) },
  ],
  cheer: [
    [
      { transform: "translateY(0) scale(1) rotate(0deg)" },
      { transform: "translateY(4%) scale(1.04, 0.94) rotate(0deg)", offset: 0.15 },
      { transform: "translateY(-16%) scale(1.06) rotate(-6deg)", offset: 0.45 },
      { transform: "translateY(0) scale(0.98, 1.02) rotate(3deg)", offset: 0.75 },
      { transform: "translateY(0) scale(1) rotate(0deg)" },
    ],
    { duration: 640, easing: cubic(ease.out) },
  ],
  peek: [
    [
      { transform: "translateY(30%) rotate(-10deg)", opacity: 0 },
      { transform: "translateY(-4%) rotate(4deg)", opacity: 1, offset: 0.55 },
      { transform: "translateY(0) rotate(0deg)", opacity: 1 },
    ],
    { duration: durationMs.slow, easing: cubic(ease.out) },
  ],
};

function clampSize(size: number): number {
  if (!Number.isFinite(size)) return 44;
  return Math.min(VITONEN_MAX, Math.max(VITONEN_MIN, size));
}

export function Vitonen({ size = 44, state = "idle", className = "", ref }: VitonenProps) {
  const mode = useMotionMode();
  const calm = mode !== "full";
  const svgRef = useRef<SVGSVGElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [active, setActive] = useState<ClassReaction | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const react = useCallback(
    (reaction: VitonenReaction) => {
      if (calm) return;
      if (reaction === "blink" || reaction === "wince" || reaction === "swing") {
        stop();
        if (active === reaction) {
          // Same reaction again: rewind its running CSS animations.
          svgRef.current
            ?.getAnimations({ subtree: true })
            .forEach((a) => {
              if ("animationName" in a && String(a.animationName).startsWith("cap-")) {
                a.currentTime = 0;
              }
            });
        }
        setActive(reaction);
        timer.current = setTimeout(() => {
          timer.current = null;
          setActive(null);
        }, CLASS_REACTIONS[reaction]);
        return;
      }
      const el = svgRef.current;
      if (!el || typeof el.animate !== "function") return;
      const [keyframes, options] = MOVES[reaction];
      el.getAnimations().forEach((a) => a.cancel());
      el.animate(keyframes, options);
    },
    [active, calm, stop],
  );

  useImperativeHandle(ref, () => ({ react }), [react]);

  // Turning calm mid-reaction stops everything at once.
  useEffect(() => {
    if (!calm) return;
    stop();
    svgRef.current?.getAnimations().forEach((a) => a.cancel());
  }, [calm, stop]);

  const px = clampSize(size);
  const classes = [
    "cap",
    px < VITONEN_TINY_BELOW ? "tiny" : "",
    calm ? "calm" : state,
    !calm && active ? active : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={`cap-slot ${className}`.trim()} aria-hidden="true" data-state={state}>
      <svg
        ref={svgRef}
        className={classes}
        viewBox="0 0 120 112"
        width={px}
        height={(px * 112) / 120}
        aria-hidden="true"
        focusable="false"
      >
        <g className="cap-body">
          <path className="cap-cord" d="M60 20 Q92 12 101 36" />
          <g className="cap-hang">
            <path className="cap-cord" d="M101 36 L102 62" />
            <path className="cap-tuft" d="M96 60 h12 l3.5 22 q-9.5 5 -19 0 z" />
          </g>
          <path className="cap-band" d="M26 56 H94 V82 Q94 88 88 88 H32 Q26 88 26 82 Z" />
          <path className="cap-visor" d="M28 86 Q60 104 92 86 Q90 98 60 100 Q30 98 28 86 Z" />
          <path className="cap-gloss" d="M40 92 Q50 96 60 96.5 Q50 98.5 41 95 Z" />
          <path
            className="cap-crown"
            d="M22 62 Q8 52 16 38 Q24 22 50 18 Q78 14 96 24 Q112 34 104 52 Q100 60 92 62 Q60 68 22 62 Z"
          />
          <path className="cap-crease" d="M36 34 Q54 28 74 32" />
          <ellipse className="cap-eye" cx="47" cy="73" rx="3.6" ry="4.2" />
          <ellipse className="cap-eye" cx="65" cy="73" rx="3.6" ry="4.2" />
          <path className="cap-wince" d="M43 70.5 l8 3 M69 70.5 l-8 3" />
          <path className="cap-mouth" d="M52 80 Q56 83.5 60 80" />
          <ellipse className="cap-mouth-o" cx="56" cy="81.5" rx="3" ry="2.4" />
          <circle className="cap-rose" cx="83" cy="72" r="6.5" />
          <circle className="cap-rose-c" cx="83" cy="72" r="3" />
        </g>
      </svg>
    </span>
  );
}
