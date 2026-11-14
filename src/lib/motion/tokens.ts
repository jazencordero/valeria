/**
 * Motion tokens from the motion spec (context/decisions.md, "Motion spec").
 * Motion takes durations in seconds; the ms values match the CSS vars in
 * src/styles/tokens.css (--t-quick, --t-base, --t-slow).
 */
import type { Transition } from "motion/react";

export const durationMs = { quick: 180, base: 280, slow: 520 } as const;

export const duration = {
  quick: durationMs.quick / 1000,
  base: durationMs.base / 1000,
  slow: durationMs.slow / 1000,
} as const;

export const ease = {
  out: [0.2, 0.8, 0.2, 1],
  inout: [0.6, 0, 0.2, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** Springs only on rewards. */
export const rewardSpring = {
  type: "spring",
  bounce: 0.25,
  visualDuration: 0.4,
} as const satisfies Transition;

/** Reduced motion: 150 ms fades, no stagger, no confetti. */
export const calmDurationMs = 150;
export const calmDuration = calmDurationMs / 1000;
