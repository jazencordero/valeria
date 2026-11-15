"use client";

/**
 * M9-10: how far she has read a lecture page, and when it counts as read.
 *
 *   const main = useRef<HTMLElement | null>(null);   // the app's <main id="main">
 *   const progress = useReadProgress({ ref: main, view, onRead: () => markLectureRead(id) });
 *   <div style={{ transform: `scaleX(${progress})` }} />   // the 3 px bar
 *
 * - Progress is the scroll container's scrollTop / (scrollHeight - clientHeight),
 *   0 to 1. The app frame scrolls `<main id="main">`, not the window, so the
 *   hook takes a ref to the element that scrolls. A container that cannot
 *   scroll (everything fits) reads as 1: all of it is on screen.
 * - Updates on scroll (passive listener, at most once per animation frame),
 *   on window resize, and when the container changes size (ResizeObserver,
 *   where the browser has one).
 * - In the Read view only, the first time progress reaches 97 % `onRead` is
 *   called. It is called at most once per mount: scrolling back up and down
 *   again, or switching to Slides and back, never calls it a second time.
 * - A page that does not scroll at all: `onRead` after 2.5 seconds on screen.
 *   "On screen" is `document.visibilityState === "visible"`: a hidden tab
 *   stops the wait and showing it again starts the 2.5 s over. (The container
 *   is the app's main column, which is always in the viewport when the tab is
 *   visible, so an IntersectionObserver would add nothing.) If the page grows
 *   and starts to scroll, the wait is dropped and the 97 % rule applies.
 * - Slides and Notes never call `onRead`. Switching away from Read cancels a
 *   pending wait; coming back starts it over.
 * - `enabled: false` (for example a lecture already read) never calls
 *   `onRead`; progress still moves.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import type { LectureView } from "./reader";

/** Progress at which a scrolled page counts as read. */
export const READ_AT = 0.97;
/** How long a page that cannot scroll must be on screen before it counts as read. */
export const SHORT_PAGE_MS = 2500;

export type ReadProgressOptions = {
  /** The element that scrolls: the app's `<main id="main">`. */
  ref: RefObject<HTMLElement | null>;
  /** The reader's current view; only "read" can mark the lecture read. */
  view: LectureView;
  /** Called once, when she has read the page. */
  onRead: () => void;
  /** False: never call `onRead`. Defaults to true. */
  enabled?: boolean;
};

type Measure = { progress: number; scrolls: boolean };

function measure(el: HTMLElement): Measure {
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 0) return { progress: 1, scrolls: false };
  return { progress: Math.min(1, Math.max(0, el.scrollTop / max)), scrolls: true };
}

export function useReadProgress({ ref, view, onRead, enabled = true }: ReadProgressOptions): number {
  const [progress, setProgress] = useState(0);
  const fired = useRef(false);
  const onReadRef = useRef(onRead);
  useEffect(() => {
    onReadRef.current = onRead;
  }, [onRead]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const canFire = enabled && view === "read";

    let frame: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fire = () => {
      if (fired.current || !canFire) return;
      fired.current = true;
      onReadRef.current();
    };

    const stopWait = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    const update = () => {
      frame = null;
      const m = measure(el);
      setProgress(m.progress);
      if (m.scrolls) {
        stopWait();
        if (m.progress >= READ_AT) fire();
      } else if (canFire && !fired.current && timer === null && document.visibilityState === "visible") {
        timer = setTimeout(() => {
          timer = null;
          fire();
        }, SHORT_PAGE_MS);
      }
    };

    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") update();
      else stopWait();
    };

    update();
    el.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", onVisibility);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(el);

    return () => {
      stopWait();
      if (frame !== null) cancelAnimationFrame(frame);
      el.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
    };
  }, [ref, view, enabled]);

  return progress;
}
