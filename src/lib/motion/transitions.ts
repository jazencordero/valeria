/**
 * Ready-made Motion props. Spread them onto a motion element:
 *   <motion.div {...rise(mode)} />
 * Pass the mode from useMotionMode(), or a boolean from useCalm().
 * Calm versions fade opacity only, for 150 ms. Instant versions (the test
 * switch) are the calm ones with duration 0.
 */
import type { MotionProps, Transition } from "motion/react";
import type { MotionMode } from "./use-calm";
import { calmDuration, duration, ease, rewardSpring } from "./tokens";

export type MotionPreset = Pick<
  MotionProps,
  "initial" | "animate" | "exit" | "transition"
>;

type ModeInput = MotionMode | boolean;

function toMode(input: ModeInput): MotionMode {
  if (input === true) return "calm";
  if (input === false) return "full";
  return input;
}

function calm(mode: "calm" | "instant"): MotionPreset {
  const transition: Transition = {
    duration: mode === "instant" ? 0 : calmDuration,
    ease: "linear",
  };
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition,
  };
}

/** Content arriving: rises 12px and fades in. */
export function rise(input: ModeInput = "full"): MotionPreset {
  const mode = toMode(input);
  if (mode !== "full") return calm(mode);
  return {
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 12 },
    transition: { duration: duration.base, ease: ease.out },
  };
}

/** Plain fade. */
export function fade(input: ModeInput = "full"): MotionPreset {
  const mode = toMode(input);
  if (mode !== "full") return calm(mode);
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: duration.quick, ease: ease.out },
  };
}

/** Reward: scales in on the reward spring. */
export function pop(input: ModeInput = "full"): MotionPreset {
  const mode = toMode(input);
  if (mode !== "full") return calm(mode);
  return {
    initial: { opacity: 0, scale: 0.8 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.8 },
    transition: {
      scale: rewardSpring,
      opacity: { duration: duration.quick, ease: ease.out },
    },
  };
}

/** Bottom sheet: slides up from below the screen. */
export function sheetUp(input: ModeInput = "full"): MotionPreset {
  const mode = toMode(input);
  if (mode !== "full") return calm(mode);
  return {
    initial: { opacity: 1, y: "100%" },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 1, y: "100%" },
    transition: { duration: duration.slow, ease: ease.inout },
  };
}

export const presets = { rise, fade, pop, sheetUp } as const;
