"use client";

/**
 * Suggestion: one chip above the composer with the next suggested step.
 * Source: prototype main-flow.html HTML 1662 (#suggest, .chip.sugg), CSS 906-908
 * and JS 4459-4474 (updateSuggest) and 4518-4523 (suggestAction).
 *
 * - Hidden while a reply is arriving (`busy`) or when there is no label.
 * - Fades up 4 px when it appears (150 ms plain fade when calm).
 * - Bounces once after 4 s with no input, once per label. Every keystroke
 *   (`lastInput` changing) restarts the 4 s. No bounce when the user prefers
 *   reduced motion or the fast test switch is on.
 * - Tapping it sends its label.
 * After the bounce the button carries `data-bounced` with the label, so tests
 * and the preview page can see it happened.
 */
import { animate } from "motion/react";
import { useEffect, useEffectEvent, useRef } from "react";
import { calmDuration, duration, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

export const BOUNCE_AFTER_MS = 4000;

export type SuggestionProps = {
  /** The next suggested step. Null or empty hides the chip. */
  label: string | null;
  /** A reply is arriving: the chip hides. */
  busy?: boolean;
  /** Tapping the chip sends its label. */
  onSend: (label: string) => void;
  /** Any value that changes on each keystroke in the composer, e.g. a counter. */
  lastInput?: number;
  /** Called when the chip bounces. */
  onBounce?: (label: string) => void;
  className?: string;
};

export function Suggestion({
  label,
  busy = false,
  onSend,
  lastInput = 0,
  onBounce,
  className = "",
}: SuggestionProps) {
  const mode = useMotionMode();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bounced = useRef(new Set<string>());
  const wasHidden = useRef(true);
  const hidden = busy || !label;

  // Fade up when the chip appears.
  useEffect(() => {
    const appearing = wasHidden.current && !hidden;
    wasHidden.current = hidden;
    if (!appearing || !wrapRef.current || mode === "instant") return;
    if (mode === "calm") {
      animate(wrapRef.current, { opacity: [0, 1] }, { duration: calmDuration, ease: ease.out });
    } else {
      animate(
        wrapRef.current,
        { opacity: [0, 1], y: [4, 0] },
        { duration: duration.base, ease: ease.out },
      );
    }
  }, [hidden, mode]);

  const bounce = useEffectEvent((text: string) => {
    const el = buttonRef.current;
    if (!el) return;
    bounced.current.add(text);
    el.dataset.bounced = text;
    animate(
      el,
      { y: [0, -5, 0, -2, 0] },
      { duration: 0.52, ease: ease.out, times: [0, 0.3, 0.6, 0.8, 1] },
    );
    onBounce?.(text);
  });

  // Once per label, after 4 s with no input. lastInput restarts the wait.
  useEffect(() => {
    if (hidden || !label || mode !== "full" || bounced.current.has(label)) return;
    const timer = window.setTimeout(() => bounce(label), BOUNCE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [hidden, label, mode, lastInput]);

  return (
    <div
      ref={wrapRef}
      hidden={hidden}
      className={"flex min-h-11 overflow-x-auto [scrollbar-width:none] " + className}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          if (!busy && label) onSend(label);
        }}
        className="group inline-flex min-h-11 max-w-full flex-none items-center rounded-full border-0 bg-transparent p-0 text-left"
      >
        <span
          className={
            "inline-flex min-h-8 max-w-full items-center rounded-full border border-solid border-accent " +
            "bg-surface px-3 py-1 text-[13px] font-semibold leading-[1.3] text-accent " +
            "transition-[background-color] duration-quick ease-out motion-reduce:duration-150 " +
            "[@media(hover:hover)]:group-hover:bg-accent-wash"
          }
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
        </span>
      </button>
    </div>
  );
}
