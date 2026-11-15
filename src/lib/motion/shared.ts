/**
 * The workspace opens out of its card and closes back into it (M4-13).
 * Source: prototype main-flow.html JS 4161-4222 (openWork, closeWork,
 * backFromWork).
 *
 * Open (Start on a card marked with `workSource`): the page area grows out of
 * the card's box (a clip, 520 ms, in-out) over Home, which stays still
 * underneath; the workspace's content fades in and rises 8 px, 200 ms after
 * the growth starts (280 ms, out). Close (the workspace's back arrow, before
 * the hand-in): the workspace shrinks into the card and fades (420 ms) while
 * Home is already there underneath.
 *
 * How: the browser's View Transitions API, the same one React's
 * <ViewTransition> drives (node_modules/next/dist/docs/01-app/02-guides/
 * view-transitions.md). It is started here by hand and not through
 * <ViewTransition name>, because both pages stream behind <Suspense>: that
 * guide says a shared pair only forms when the destination renders in the
 * same commit as the navigation, and here the first commit of a navigation is
 * always the empty fallback. So:
 * - open: `startViewTransition` wraps the navigation and waits for that first
 *   commit only (Home gone, the page area empty). The empty page area then
 *   grows out of the card over the old picture of Home, and the workspace
 *   fades into it when it arrives (`playArrival`).
 * - close: the transition waits (up to `CLOSE_WAIT_MS`) for Home's card to be
 *   on screen, so the workspace can shrink into where the card really is. If
 *   the card does not show up in time the workspace slides out to the right.
 * The page area (`#main`) is the shared element: it is given the
 * view-transition name while `<html data-work-vt>` is set, which is this
 * transition's own type (`open-work`, `close-work`). It is an attribute and
 * not a `startViewTransition({ types })` type so it also works in browsers
 * that have view transitions but not types. The tab transition (M4-02) is
 * untouched: these navigations carry no transition type, so its boundary
 * resolves to "none" and React starts no transition of its own.
 *
 * No View Transitions in the browser: the workspace slides in from the right
 * and out again (280 ms). Reduced motion: a 150 ms fade in and out. The test
 * switch (?fast=1 or READY_FAST): nothing. Opened directly by a link, a
 * reload or browser back and forward: nothing either.
 *
 * While a workspace is on screen `<html data-work>` is set: the tab bar is
 * taken away (on phones the workspace covers everything) and the sidebar is
 * inert (`holdShell`).
 *
 * M4-14 adds the same thing for a page that opens out of a card and keeps
 * the shell, the exam page: see "A page that opens out of its card" below
 * (`openCardPage`, `openCardLink`, `cardArrival`, `closeCardPage`). Same
 * page area, same clip, its own types (`open-exam`, `close-exam`) and
 * timings (360 ms open, 320 ms close). It also remembers where the card was
 * (page and scroll position) so Back returns there.
 */
import type { MouseEvent as ReactMouseEvent } from "react";
import { calmDurationMs, durationMs, ease } from "./tokens";
import type { MotionMode } from "./use-calm";

/* ---------- Names ---------- */

/** This transition's types: the values of `<html data-work-vt>`. */
export const OPEN_WORK = "open-work";
export const CLOSE_WORK = "close-work";
/** Close, when Home's card is not there to shrink into. */
export const CLOSE_WORK_SLIDE = "close-work-slide";
/** The view-transition name the page area carries during the transition. */
export const WORK_NAME = "ready-work";
/** Marks the card a workspace opens from; the value is the workspace's path. */
export const WORK_SOURCE_ATTR = "data-work-source";
/** On <html> during the transition; the value is one of the types above. */
export const WORK_VT_ATTR = "data-work-vt";
/** On <html> while a workspace is opening ("opening") or on screen ("open"). */
export const WORK_ATTR = "data-work";

/** The exam page's types (M4-14). */
export const OPEN_EXAM = "open-exam";
export const CLOSE_EXAM = "close-exam";
export const CLOSE_EXAM_SLIDE = "close-exam-slide";
export const EXAM_OPEN_MS = 360;
export const EXAM_CLOSE_MS = 320;

export const OPEN_MS = durationMs.slow;
export const CLOSE_MS = 420;
/** The workspace's content: starts this long after the growth, lasts this long. */
export const CONTENT_DELAY_MS = 200;
export const CONTENT_MS = durationMs.base;
export const CONTENT_RISE_PX = 8;
export const SLIDE_MS = durationMs.base;
/** The card's corner radius, which the clip starts from and ends at. */
export const CARD_RADIUS_PX = 20;

/** How long the open waits for the navigation to commit before giving up on the transition. */
const OPEN_WAIT_MS = 2500;
/** How long the close waits for Home's card before sliding out instead. */
const CLOSE_WAIT_MS = 1500;
/** A Start click older than this no longer animates the workspace that mounts. */
const OPENING_FRESH_MS = 8000;

const E_OUT = `cubic-bezier(${ease.out.join(",")})`;
const E_INOUT = `cubic-bezier(${ease.inout.join(",")})`;
const FULL_CLIP = "inset(0px 0px 0px 0px round 0px)";

/** Spread onto the card: `<article {...workSource(href)}>`. */
export function workSource(href: string): { [WORK_SOURCE_ATTR]: string } {
  return { [WORK_SOURCE_ATTR]: href };
}

/* ---------- Pure helpers ---------- */

export type Box = { left: number; top: number; width: number; height: number };

/**
 * The clip that shows only `card` inside `frame` (the prototype's
 * `insetFor`). Edges outside the frame are clamped to it.
 */
export function insetFor(card: Box, frame: Box, radius: number = CARD_RADIUS_PX): string {
  const px = (n: number) => `${Math.max(0, Math.round(n * 100) / 100)}px`;
  const top = card.top - frame.top;
  const left = card.left - frame.left;
  const right = frame.left + frame.width - (card.left + card.width);
  const bottom = frame.top + frame.height - (card.top + card.height);
  return `inset(${px(top)} ${px(right)} ${px(bottom)} ${px(left)} round ${radius}px)`;
}

export type WorkMotion = "clip" | "slide" | "fade" | "none";

/** Which version plays: the clip, the slide (no View Transitions), the fade (calm) or nothing (test switch). */
export function workMotion(mode: MotionMode, viewTransitions: boolean): WorkMotion {
  if (mode === "instant") return "none";
  if (mode === "calm") return "fade";
  return viewTransitions ? "clip" : "slide";
}

/**
 * Kept here, not in globals.css, so the transition is one file. Both the card
 * and the workspace render it (`<style href="ready-work-transition">`).
 *
 * Root (sidebar, tab bar): switched to the new state at once, as in M4-02.
 * Except opening on a phone, where the old picture stays so the tab bar is
 * still there until the growing page covers it.
 */
export const WORK_TRANSITION_CSS = `
html[${WORK_ATTR}] #main ~ nav { display: none; }
html[${WORK_VT_ATTR}] #main { view-transition-name: ${WORK_NAME}; }
html[${WORK_VT_ATTR}]::view-transition-group(${WORK_NAME}) { animation: none; }
html[${WORK_VT_ATTR}]::view-transition-old(${WORK_NAME}),
html[${WORK_VT_ATTR}]::view-transition-new(${WORK_NAME}) { animation: none; mix-blend-mode: normal; }
html[${WORK_VT_ATTR}]::view-transition-old(root) { display: none; }
html[${WORK_VT_ATTR}]::view-transition-new(root) { animation: none; mix-blend-mode: normal; }
@media (max-width: 699.98px) {
  html[${WORK_VT_ATTR}="${OPEN_WORK}"]::view-transition-old(root) { display: block; animation: none; mix-blend-mode: normal; }
  html[${WORK_VT_ATTR}="${OPEN_WORK}"]::view-transition-new(root) { display: none; }
}
html[${WORK_VT_ATTR}="${OPEN_WORK}"]::view-transition-new(${WORK_NAME}) {
  animation: ${OPEN_MS}ms ${E_INOUT} both ready-work-open;
}
html[${WORK_VT_ATTR}="${CLOSE_WORK}"]::view-transition-old(${WORK_NAME}) {
  z-index: 1;
  animation: ${CLOSE_MS}ms ${E_INOUT} both ready-work-close;
}
html[${WORK_VT_ATTR}="${CLOSE_WORK_SLIDE}"]::view-transition-old(${WORK_NAME}) {
  z-index: 1;
  animation: ${SLIDE_MS}ms ${E_INOUT} both ready-work-slide-out;
}
@keyframes ready-work-open { from { clip-path: var(--work-clip, ${FULL_CLIP}); } to { clip-path: ${FULL_CLIP}; } }
@keyframes ready-work-close {
  from { clip-path: ${FULL_CLIP}; opacity: 1; }
  55% { opacity: 0.85; }
  to { clip-path: var(--work-clip, ${FULL_CLIP}); opacity: 0; }
}
@keyframes ready-work-slide-out { to { transform: translateX(100%); } }
html[${WORK_VT_ATTR}="${OPEN_EXAM}"]::view-transition-new(${WORK_NAME}) {
  animation: ${EXAM_OPEN_MS}ms ${E_INOUT} both ready-work-open;
}
html[${WORK_VT_ATTR}="${CLOSE_EXAM}"]::view-transition-old(${WORK_NAME}) {
  z-index: 1;
  animation: ${EXAM_CLOSE_MS}ms ${E_INOUT} both ready-exam-close;
}
html[${WORK_VT_ATTR}="${CLOSE_EXAM_SLIDE}"]::view-transition-old(${WORK_NAME}) {
  z-index: 1;
  animation: ${SLIDE_MS}ms ${E_INOUT} both ready-work-slide-out;
}
@keyframes ready-exam-close {
  from { clip-path: ${FULL_CLIP}; opacity: 1; }
  70% { opacity: 1; }
  to { clip-path: var(--work-clip, ${FULL_CLIP}); opacity: 0; }
}
`;

/* ---------- Browser helpers ---------- */

type Finished = { finished: Promise<unknown>; ready: Promise<unknown>; skipTransition: () => void };
type StartViewTransition = (update: () => Promise<void> | void) => Finished;
type StartVTLike = (this: Document, update: () => Promise<void> | void) => Finished;

function viewTransitionStarter(): StartViewTransition | null {
  if (typeof document === "undefined") return null;
  const start = (document as unknown as { startViewTransition?: StartVTLike }).startViewTransition;
  return typeof start === "function" ? (update) => start.call(document, update) : null;
}

/** True when the browser has same-document view transitions. */
export function hasViewTransitions(): boolean {
  return viewTransitionStarter() !== null;
}

/** A plain primary click on a link that opens in this tab. `link` is the link when the handler sits on something else. */
function plainClick(e: ReactMouseEvent<Element>, link: Element = e.currentTarget): boolean {
  if (e.defaultPrevented || e.button !== 0) return false;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  const target = link.getAttribute("target");
  return !target || target === "_self";
}

function isShown(el: Element): boolean {
  if (!el.isConnected) return false;
  // Pages she left can stay in the document, hidden.
  return typeof el.checkVisibility === "function" ? el.checkVisibility() : true;
}

/**
 * Resolves with what `read` returns once it returns something, checking
 * again whenever the page area changes. Null when `ms` runs out first.
 * (No animation frames: they do not run while a view transition holds the
 * screen.)
 */
function waitFor<T>(main: HTMLElement, ms: number, read: () => T | null): Promise<T | null> {
  const now = read();
  if (now !== null) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = (value: T | null) => {
      observer.disconnect();
      window.clearTimeout(timer);
      resolve(value);
    };
    const observer = new MutationObserver(() => {
      const value = read();
      if (value !== null) done(value);
    });
    observer.observe(main, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "hidden", WORK_SOURCE_ATTR],
    });
    const timer = window.setTimeout(() => done(read()), ms);
  });
}

/** True while `replayClick` is sending the click through again. */
let replaying = false;

/** Clicks the link again so <Link> does its own navigation; the handlers below let it pass. */
function replayClick(link: HTMLAnchorElement): void {
  replaying = true;
  try {
    link.click();
  } finally {
    replaying = false;
  }
}

/** One open or close at a time. */
let busy = false;

function endTransition(): void {
  const html = document.documentElement;
  html.removeAttribute(WORK_VT_ATTR);
  html.style.removeProperty("--work-clip");
  busy = false;
}

/* ---------- Open ---------- */

type Opening = {
  /** The workspace's path. */
  href: string;
  how: Exclude<WorkMotion, "none">;
  /** When Start was clicked. */
  at: number;
  /** When the growth started on screen; null until it does. */
  grewAt: number | null;
};

let opening: Opening | null = null;

/**
 * The Start link's `onClick`. The card around it must carry `workSource`.
 * Clip: holds the click, starts the view transition and navigates inside it.
 * Slide and fade: lets the link navigate and leaves a note for the workspace
 * (`playArrival`).
 */
export function openWork(e: ReactMouseEvent<HTMLAnchorElement>, mode: MotionMode): void {
  if (replaying || !plainClick(e)) return;
  const link = e.currentTarget;
  const source = link.closest<HTMLElement>(`[${WORK_SOURCE_ATTR}]`);
  const main = document.getElementById("main");
  const start = viewTransitionStarter();
  const how = workMotion(mode, start !== null);
  if (how === "none" || !source || !main) return;

  const mine: Opening = {
    href: source.getAttribute(WORK_SOURCE_ATTR) ?? "",
    how,
    at: performance.now(),
    grewAt: null,
  };
  if (how !== "clip" || start === null) {
    opening = mine;
    return;
  }

  e.preventDefault();
  if (busy) return;
  busy = true;
  opening = mine;

  const html = document.documentElement;
  const card = source.getBoundingClientRect();
  if (card.width <= 0) {
    busy = false;
    replayClick(link);
    return;
  }
  html.setAttribute(WORK_VT_ATTR, OPEN_WORK);
  let left = false;
  const transition = start(async () => {
    replayClick(link);
    left = (await waitFor(main, OPEN_WAIT_MS, () => (isShown(source) ? null : true))) === true;
    if (!left) return;
    // From here the tab bar is gone, so the page area has its final size.
    if (!html.hasAttribute(WORK_ATTR)) {
      html.setAttribute(WORK_ATTR, "opening");
      // If no workspace ever mounts (an error page), give the tab bar back.
      window.setTimeout(() => {
        if (html.getAttribute(WORK_ATTR) === "opening") html.removeAttribute(WORK_ATTR);
      }, OPENING_FRESH_MS);
    }
    html.style.setProperty("--work-clip", insetFor(card, main.getBoundingClientRect()));
  });
  transition.ready.then(
    () => {
      if (!left) transition.skipTransition();
      else mine.grewAt = performance.now();
    },
    () => {},
  );
  transition.finished.then(endTransition, endTransition);
}

/**
 * Called by the workspace when it mounts. Plays its side of the open if a
 * Start click led here a moment ago; does nothing on a direct visit.
 * The note is used up, so an effect that runs twice plays it once; the
 * animations end on their own and leave nothing behind.
 */
export function playArrival(root: HTMLElement): void {
  const mine = opening;
  opening = null;
  const now = performance.now();
  if (!mine || now - mine.at > OPENING_FRESH_MS) return;
  if (mine.href !== window.location.pathname || typeof root.animate !== "function") return;

  if (mine.how === "fade") {
    root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: calmDurationMs, easing: "linear" });
  } else if (mine.how === "slide") {
    root.animate([{ transform: "translateX(100%)" }, { transform: "none" }], {
      duration: SLIDE_MS,
      easing: E_OUT,
    });
  } else {
    const sinceGrowth = mine.grewAt === null ? 0 : now - mine.grewAt;
    root.animate(
      [
        { opacity: 0, transform: `translateY(${CONTENT_RISE_PX}px)` },
        { opacity: 1, transform: "none" },
      ],
      {
        duration: CONTENT_MS,
        delay: Math.max(0, CONTENT_DELAY_MS - sinceGrowth),
        easing: E_OUT,
        fill: "backwards",
      },
    );
  }
}

/* ---------- Close ---------- */

/**
 * The back arrow's `onClick`, before the hand-in. `root` is the workspace.
 * Clip: the workspace shrinks into Home's card for this page. Slide and
 * fade: the workspace leaves first, then the link navigates.
 */
export function closeWork(
  e: ReactMouseEvent<HTMLAnchorElement>,
  mode: MotionMode,
  root: HTMLElement | null,
): void {
  if (replaying || !plainClick(e)) return;
  const link = e.currentTarget;
  const main = document.getElementById("main");
  const start = viewTransitionStarter();
  const how = workMotion(mode, start !== null);
  if (how === "none" || !main || !root) return;

  e.preventDefault();
  if (busy) return;
  busy = true;

  if (how !== "clip" || start === null) {
    if (typeof root.animate !== "function") {
      busy = false;
      replayClick(link);
      return;
    }
    const leave =
      how === "fade"
        ? root.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: calmDurationMs,
            easing: "linear",
            fill: "forwards",
          })
        : root.animate([{ transform: "translateX(0%)" }, { transform: "translateX(100%)" }], {
            duration: SLIDE_MS,
            easing: E_INOUT,
            fill: "forwards",
          });
    const go = () => {
      busy = false;
      replayClick(link);
      // The page may be kept, hidden, for browser back: do not leave it faded out.
      void waitFor(main, OPEN_WAIT_MS, () => (isShown(root) ? null : true)).then(() => leave.cancel());
    };
    leave.finished.then(go, go);
    return;
  }

  const html = document.documentElement;
  const key = window.location.pathname;
  const from = main.getBoundingClientRect();
  const selector = `[${WORK_SOURCE_ATTR}="${CSS.escape(key)}"]`;
  let card: HTMLElement | null = null;
  html.setAttribute(WORK_VT_ATTR, CLOSE_WORK);
  const transition = start(async () => {
    replayClick(link);
    card = await waitFor(main, CLOSE_WAIT_MS, () => {
      for (const el of main.querySelectorAll<HTMLElement>(selector)) if (isShown(el)) return el;
      return null;
    });
    const box = card?.getBoundingClientRect();
    if (box && box.width > 0) {
      const to = main.getBoundingClientRect();
      // The old picture keeps its own size, pinned to the page area's top left corner.
      html.style.setProperty(
        "--work-clip",
        insetFor(box, { left: to.left, top: to.top, width: from.width, height: from.height }),
      );
    } else {
      html.setAttribute(WORK_VT_ATTR, CLOSE_WORK_SLIDE);
    }
  });
  const after = () => {
    endTransition();
    // As in the prototype: focus goes back to Start.
    card?.querySelector<HTMLElement>("a[href]")?.focus({ preventScroll: true });
  };
  transition.finished.then(after, after);
}

/* ---------- The shell while a workspace is on screen ---------- */

/**
 * Marks `<html data-work>` (the tab bar goes away) and makes the sidebar
 * inert. Returns the undo. Call from a layout effect in the workspace.
 */
export function holdShell(): () => void {
  const html = document.documentElement;
  const side = document.getElementById("side");
  html.setAttribute(WORK_ATTR, "open");
  const wasInert = side?.hasAttribute("inert") ?? false;
  side?.setAttribute("inert", "");
  return () => {
    html.removeAttribute(WORK_ATTR);
    if (side && !wasInert) side.removeAttribute("inert");
  };
}

/* ---------- A page that opens out of its card and keeps the shell: exams (M4-14) ---------- */
/*
 * Source: prototype main-flow.html JS 2957-3054 (openExam, closeExamPage).
 * The card carries `workSource(key)`: the page's path when the card knows it
 * (the Exams tab's card is a link), any text that names the card when it does
 * not (Home's exam card). Opening notes where the card was; the page that
 * mounts calls `cardArrival`; its back link calls `closeCardPage`, which goes
 * back to the page the card is on, puts the scroll where it was and shrinks
 * into the card. Opened some other way (a link, a reload, browser back): Back
 * goes to the fallback page and shrinks into the card there that carries the
 * page's path, if there is one.
 */

/** One kind of page that opens out of a card: its `<html data-work-vt>` values and how long it grows. */
export type CardPage = { open: string; close: string; closeSlide: string; openMs: number };

export const EXAM_PAGE: CardPage = {
  open: OPEN_EXAM,
  close: CLOSE_EXAM,
  closeSlide: CLOSE_EXAM_SLIDE,
  openMs: EXAM_OPEN_MS,
};

/** How long the content takes to fade in when it lands inside the growing page. */
const CARD_CONTENT_MS = durationMs.quick;

type CardOrigin = {
  /** The page the card is on. */
  path: string;
  /** How far that page was scrolled. */
  scroll: number;
  /** The card's `workSource` value. */
  key: string | null;
  at: number;
  /** The page that opened; null until it mounts. */
  to: string | null;
};

type CardOpening = {
  how: Exclude<WorkMotion, "none">;
  at: number;
  grewAt: number | null;
  ms: number;
};

let cardOrigin: CardOrigin | null = null;
let cardOpening: CardOpening | null = null;
/** The page that last arrived and when its growth ends, so asking twice gives one answer. */
let cardArrived: { root: HTMLElement; endsAt: number } | null = null;
const cardPaths = new WeakMap<HTMLElement, string>();

/**
 * Opens a page out of `source` (the card, marked with `workSource`).
 * `navigate` starts the navigation; it is always called, once.
 */
export function openCardPage(
  source: HTMLElement,
  mode: MotionMode,
  navigate: () => void,
  page: CardPage = EXAM_PAGE,
): void {
  const main = document.getElementById("main");
  const start = viewTransitionStarter();
  const how = workMotion(mode, start !== null);
  const at = performance.now();
  cardOrigin = {
    path: window.location.pathname,
    scroll: main?.scrollTop ?? 0,
    key: source.getAttribute(WORK_SOURCE_ATTR),
    at,
    to: null,
  };
  cardOpening = null;
  if (how === "none" || !main) {
    navigate();
    return;
  }
  const mine: CardOpening = { how, at, grewAt: null, ms: page.openMs };
  if (how !== "clip" || start === null) {
    cardOpening = mine;
    navigate();
    return;
  }
  const card = source.getBoundingClientRect();
  if (busy || card.width <= 0) {
    navigate();
    return;
  }
  busy = true;
  cardOpening = mine;

  const html = document.documentElement;
  html.setAttribute(WORK_VT_ATTR, page.open);
  let left = false;
  const transition = start(async () => {
    navigate();
    left = (await waitFor(main, OPEN_WAIT_MS, () => (isShown(source) ? null : true))) === true;
    if (left) html.style.setProperty("--work-clip", insetFor(card, main.getBoundingClientRect()));
  });
  transition.ready.then(
    () => {
      if (left) {
        mine.grewAt = performance.now();
        return;
      }
      if (cardOpening === mine) cardOpening = null;
      transition.skipTransition();
    },
    () => {},
  );
  transition.finished.then(endTransition, endTransition);
}

/** `openCardPage` as the `onClick` of a link that is the card, or sits inside it. */
export function openCardLink(
  e: ReactMouseEvent<HTMLAnchorElement>,
  mode: MotionMode,
  page: CardPage = EXAM_PAGE,
): void {
  if (replaying || !plainClick(e)) return;
  const link = e.currentTarget;
  const source = link.closest<HTMLElement>(`[${WORK_SOURCE_ATTR}]`);
  if (!source) return;
  e.preventDefault();
  openCardPage(source, mode, () => replayClick(link), page);
}

/** True while a page is growing out of a card and has not mounted yet. Safe to read while rendering. */
export function cardRevealPending(): boolean {
  const mine = cardOpening;
  return mine !== null && mine.how === "clip" && performance.now() - mine.at <= OPENING_FRESH_MS;
}

/**
 * Called by the page when it mounts or is shown again (a layout effect).
 * Plays its side of the open if a card led here a moment ago, and returns how
 * many ms are left until the page has grown to full size: start first-show
 * animations after that. 0 when there is nothing to wait for.
 */
export function cardArrival(root: HTMLElement): number {
  const now = performance.now();
  const here = window.location.pathname;
  cardPaths.set(root, here);
  if (cardOrigin && cardOrigin.to === null) {
    if (now - cardOrigin.at <= OPENING_FRESH_MS) cardOrigin.to = here;
    else cardOrigin = null;
  }
  const mine = cardOpening;
  cardOpening = null;
  if (!mine) return cardArrived?.root === root ? Math.max(0, cardArrived.endsAt - now) : 0;
  if (now - mine.at > OPENING_FRESH_MS || typeof root.animate !== "function") return 0;

  let wait = 0;
  if (mine.how === "fade") {
    root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: calmDurationMs, easing: "linear" });
  } else if (mine.how === "slide") {
    root.animate([{ transform: "translateX(100%)" }, { transform: "none" }], {
      duration: SLIDE_MS,
      easing: E_OUT,
    });
  } else {
    wait = mine.grewAt === null ? mine.ms : Math.max(0, mine.ms - (now - mine.grewAt));
    root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: CARD_CONTENT_MS, easing: E_OUT });
  }
  cardArrived = { root, endsAt: now + wait };
  return wait;
}

/**
 * Called by the page when it is taken away (the layout effect's cleanup).
 * Forgets where it was opened from, so a later visit by some other way does
 * not go "back" to a card it did not come from.
 */
export function leaveCardPage(root: HTMLElement): void {
  const path = cardPaths.get(root);
  // Later: an effect that runs twice leaves a page that is still there.
  window.setTimeout(() => {
    if (isShown(root)) return;
    if (cardOrigin && cardOrigin.to !== null && cardOrigin.to === path) cardOrigin = null;
    if (cardArrived?.root === root) cardArrived = null;
  }, 0);
}

/**
 * A click on the page's back link (`link`; the handler may sit on something
 * around it). `root` is the page. Goes back with `navigate(path)` to where
 * the card is, or to `fallbackPath`, restores the scroll position there, and
 * shrinks the page into the card (clip), or lets it leave first (slide,
 * fade). A click that opens a new tab is left alone.
 */
export function closeCardPage(
  e: ReactMouseEvent<Element>,
  link: Element,
  mode: MotionMode,
  root: HTMLElement | null,
  navigate: (path: string) => void,
  fallbackPath: string,
  page: CardPage = EXAM_PAGE,
): void {
  if (!plainClick(e, link)) return;
  const main = document.getElementById("main");
  if (!main || !root) return;
  e.preventDefault();
  e.stopPropagation();

  const here = window.location.pathname;
  const from: Pick<CardOrigin, "path" | "scroll" | "key"> =
    cardOrigin && cardOrigin.to === here ? cardOrigin : { path: fallbackPath, scroll: 0, key: here };
  const selector = from.key === null ? null : `[${WORK_SOURCE_ATTR}="${CSS.escape(from.key)}"]`;
  const findCard = (): HTMLElement | null => {
    if (selector === null) return null;
    for (const el of main.querySelectorAll<HTMLElement>(selector)) if (isShown(el)) return el;
    return null;
  };
  /** The card's page is back: put the scroll where it was. Resolves with the card, if it is there. */
  const land = async (): Promise<HTMLElement | null> => {
    const card = await waitFor(main, CLOSE_WAIT_MS, findCard);
    main.scrollTop = from.scroll;
    return card;
  };

  const start = viewTransitionStarter();
  const how = workMotion(mode, start !== null);
  if (how === "none") {
    navigate(from.path);
    void land();
    return;
  }
  if (busy) return;
  busy = true;

  if (how !== "clip" || start === null) {
    if (typeof root.animate !== "function") {
      busy = false;
      navigate(from.path);
      void land();
      return;
    }
    const leave =
      how === "fade"
        ? root.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: calmDurationMs,
            easing: "linear",
            fill: "forwards",
          })
        : root.animate([{ transform: "translateX(0%)" }, { transform: "translateX(100%)" }], {
            duration: SLIDE_MS,
            easing: E_INOUT,
            fill: "forwards",
          });
    const go = () => {
      busy = false;
      navigate(from.path);
      // The page may be kept, hidden, for browser back: do not leave it faded out.
      void land().then(() => leave.cancel());
    };
    leave.finished.then(go, go);
    return;
  }

  const html = document.documentElement;
  const before = main.getBoundingClientRect();
  let card: HTMLElement | null = null;
  html.setAttribute(WORK_VT_ATTR, page.close);
  const transition = start(async () => {
    navigate(from.path);
    card = await land();
    const box = card?.getBoundingClientRect();
    if (box && box.width > 0) {
      const to = main.getBoundingClientRect();
      // The old picture keeps its own size, pinned to the page area's top left corner.
      html.style.setProperty(
        "--work-clip",
        insetFor(box, { left: to.left, top: to.top, width: before.width, height: before.height }),
      );
    } else {
      html.setAttribute(WORK_VT_ATTR, page.closeSlide);
    }
  });
  const after = () => {
    endTransition();
    // As in the prototype: focus goes back to what opened the page.
    const opener = card?.matches("a[href], button") ? card : card?.querySelector<HTMLElement>("button, a[href]");
    opener?.focus({ preventScroll: true });
  };
  transition.finished.then(after, after);
}
