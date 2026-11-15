"use client";

/**
 * Sidebar fold state (M4-01). Source: prototype main-flow.html JS 3936-3961.
 *
 * Folded is 72 px (icons only), open is 240 px. Until she toggles, the
 * sidebar is folded between 700 and 1000 px and open from 1000 px. Her
 * choice lives in localStorage['ready-side'] ("collapsed" or "expanded").
 *
 * The state is written to <html data-side>, so CSS does the sizing and the
 * server-rendered sidebar is already right on first paint: the app layout
 * runs a one-line script before the sidebar is parsed that copies the saved
 * choice onto <html> (see SIDE_BOOT in src/app/(app)/layout.tsx). The grid
 * there turns it into `--side-c` (1 folded, 0 open) for the sidebar to read.
 *
 * Folding plays the prototype's move: the sidebar is clipped by 168 px while
 * the page slides left, 260 ms, then the width snaps. Instant when calm,
 * when the fast test switch is on, or under 700 px.
 */
import { useCallback, useRef, useSyncExternalStore, type RefObject } from "react";
import { ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

/** localStorage key; the boot script in the app layout uses the same literal. */
export const SIDE_KEY = "ready-side";

type Choice = "collapsed" | "expanded";

const WIDE = "(min-width: 700px)";
const WIDE1000 = "(min-width: 1000px)";
/** How far the sidebar is clipped and the page slides: 240 - 72. */
const SLIDE_PX = 168;
const SLIDE_MS = 260;
const EASE_IO = `cubic-bezier(${ease.inout.join(", ")})`;

function readStored(): Choice | null {
  try {
    const v = window.localStorage.getItem(SIDE_KEY);
    return v === "collapsed" || v === "expanded" ? v : null;
  } catch {
    return null;
  }
}

function writeChoice(choice: Choice): void {
  try {
    window.localStorage.setItem(SIDE_KEY, choice);
  } catch {
    // Private mode or storage blocked: the choice lasts for this page only.
  }
  document.documentElement.dataset.side = choice;
}

function htmlChoice(): Choice | null {
  const v = document.documentElement.dataset.side;
  return v === "collapsed" || v === "expanded" ? v : null;
}

function subscribe(onChange: () => void): () => void {
  // A soft navigation into the app skips the boot script; copy the saved
  // choice onto <html> here instead.
  const stored = readStored();
  if (stored && htmlChoice() !== stored) document.documentElement.dataset.side = stored;

  const wide = window.matchMedia(WIDE1000);
  wide.addEventListener("change", onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-side"],
  });
  return () => {
    wide.removeEventListener("change", onChange);
    observer.disconnect();
  };
}

function getSnapshot(): boolean {
  const choice = htmlChoice();
  if (choice) return choice === "collapsed";
  return !window.matchMedia(WIDE1000).matches;
}

/** The server cannot know her screen or her choice. */
function getServerSnapshot(): null {
  return null;
}

export type SideState = {
  /** True when folded to the icon rail; null before hydration. */
  collapsed: boolean | null;
  /** Folds or unfolds, animated when motion is full. */
  toggle: () => void;
};

/**
 * `sideRef` is the <aside>; the page area is found by id (`main`), since it
 * lives in the server layout.
 */
export function useSide(sideRef: RefObject<HTMLElement | null>): SideState {
  const collapsed = useSyncExternalStore<boolean | null>(subscribe, getSnapshot, getServerSnapshot);
  const mode = useMotionMode();
  const run = useRef(0);
  const running = useRef<Animation[]>([]);
  /** Where a running fold is heading, so a second tap mid-way reverses it. */
  const pending = useRef<boolean | null>(null);

  const toggle = useCallback(() => {
    const next = !(pending.current ?? getSnapshot());
    pending.current = null;
    const id = ++run.current;
    for (const a of running.current) a.cancel();
    running.current = [];

    const side = sideRef.current;
    const main = document.getElementById("main");
    const animate =
      mode === "full" &&
      window.matchMedia(WIDE).matches &&
      side !== null &&
      main !== null &&
      typeof side.animate === "function";

    if (!animate) {
      writeChoice(next ? "collapsed" : "expanded");
      return;
    }

    const timing: KeyframeAnimationOptions = {
      duration: SLIDE_MS,
      easing: EASE_IO,
    };
    const open = "inset(0px 0px 0px 0px)";
    const shut = `inset(0px ${SLIDE_PX}px 0px 0px)`;
    const home = "translateX(0px)";
    const left = `translateX(${-SLIDE_PX}px)`;

    if (next) {
      // Clip and slide at full width, then snap to 72 px.
      const anims = [
        side.animate([{ clipPath: open }, { clipPath: shut }], {
          ...timing,
          fill: "forwards",
        }),
        main.animate([{ transform: home }, { transform: left }], {
          ...timing,
          fill: "forwards",
        }),
      ];
      running.current = anims;
      pending.current = true;
      Promise.all(anims.map((a) => a.finished)).then(
        () => {
          if (id !== run.current) return;
          pending.current = null;
          writeChoice("collapsed");
          for (const a of anims) a.cancel();
          running.current = [];
        },
        () => {
          // Cancelled by a newer toggle; that one owns the state.
        },
      );
    } else {
      // Snap to 240 px, then unclip while the page slides back.
      writeChoice("expanded");
      running.current = [
        side.animate([{ clipPath: shut }, { clipPath: open }], timing),
        main.animate([{ transform: left }, { transform: home }], timing),
      ];
    }
  }, [mode, sideRef]);

  return { collapsed, toggle };
}
