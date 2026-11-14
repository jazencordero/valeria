"use client";

import { useSyncExternalStore } from "react";
import { applyFast, isFast } from "./fast";

/**
 * "full": normal motion. "calm": the user prefers reduced motion (150 ms fades).
 * "instant": the test switch is on (?fast=1 or READY_FAST), so everything
 * finishes at once.
 */
export type MotionMode = "full" | "calm" | "instant";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  applyFast();
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-fast"],
  });
  return () => {
    media.removeEventListener("change", onChange);
    observer.disconnect();
  };
}

function getSnapshot(): MotionMode {
  if (isFast()) return "instant";
  return window.matchMedia(QUERY).matches ? "calm" : "full";
}

function getServerSnapshot(): MotionMode {
  return "full";
}

export function useMotionMode(): MotionMode {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** True when the user prefers reduced motion or the fast switch is on. */
export function useCalm(): boolean {
  return useMotionMode() !== "full";
}
