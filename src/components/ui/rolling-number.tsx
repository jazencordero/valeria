"use client";

import { useEffect, useRef, useState } from "react";
import { useCalm } from "@/lib/motion/use-calm";

/** Each changed digit slides up over 300 ms, the next one 30 ms later. */
export const ROLL_MS = 300;
export const ROLL_STAGGER_MS = 30;
const ROLL_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

type Roll = { from: string; to: string; run: number };

export type RollingNumberProps = {
  value: number | string;
  className?: string;
};

/**
 * A number that rolls its changed digits up when the value changes.
 * Screen readers always get the plain value; the rolling digits are hidden
 * from them. No roll when the length changes or when motion is calm.
 */
export function RollingNumber({ value, className }: RollingNumberProps) {
  const text = String(value);
  const calm = useCalm();
  const [shown, setShown] = useState(text);
  const [roll, setRoll] = useState<Roll | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Adjust state while rendering when the value changes (no effect needed).
  if (shown !== text) {
    setShown(text);
    const canRoll = !calm && shown.length === text.length;
    setRoll(canRoll ? { from: shown, to: text, run: (roll?.run ?? 0) + 1 } : null);
  }

  useEffect(() => {
    if (!roll) return;
    const cols = wrapRef.current?.querySelectorAll<HTMLElement>("[data-roll-in]") ?? [];
    const anims: Animation[] = [];
    cols.forEach((el, k) => {
      if (typeof el.animate !== "function") return;
      anims.push(
        el.animate([{ transform: "translateY(0%)" }, { transform: "translateY(-50%)" }], {
          duration: ROLL_MS,
          delay: k * ROLL_STAGGER_MS,
          easing: ROLL_EASE,
          fill: "forwards",
        }),
      );
    });
    const done = window.setTimeout(
      () => setRoll(null),
      ROLL_MS + cols.length * ROLL_STAGGER_MS + 120,
    );
    return () => {
      window.clearTimeout(done);
      anims.forEach((a) => a.cancel());
    };
  }, [roll]);

  if (!roll || roll.to !== text) {
    return <span className={className}>{text}</span>;
  }

  const { from, to } = roll;
  return (
    <span className={className}>
      <span
        ref={wrapRef}
        aria-hidden="true"
        data-rolling=""
        className="inline-flex whitespace-pre"
      >
        {Array.from(to).map((ch, i) => {
          const old = from.charAt(i);
          if (ch !== old && /\d/.test(ch + old)) {
            return (
              <span
                key={`${roll.run}-${i}`}
                className="inline-block overflow-hidden"
                style={{ height: "1lh" }}
              >
                <span data-roll-in="" className="flex flex-col">
                  <span style={{ height: "1lh" }}>{old}</span>
                  <span style={{ height: "1lh" }}>{ch}</span>
                </span>
              </span>
            );
          }
          return <span key={`${roll.run}-${i}`}>{ch}</span>;
        })}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  );
}
