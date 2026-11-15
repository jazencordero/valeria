"use client";

/**
 * Tab-to-tab page transition and focus (M4-02).
 * Source: prototype main-flow.html JS 3962-4002 (`setTab`).
 *
 * Between two sidebar tabs the old page fades and moves 10 px (120 ms,
 * linear), then the new one rises 10 px into place (220 ms, ease-out).
 * Forward in the tab order (Home, Assignments, Exams, Grades, Calendar) the
 * pages travel up, backward they travel down.
 *
 * How: React's <ViewTransition>, the approach in
 * node_modules/next/dist/docs/01-app/02-guides/view-transitions.md ("Add
 * directional motion for navigation"). It needs no next.config flag in this
 * version. A link says which way it goes with <Link transitionTypes>
 * (`tabTransitionTypes` below; the sidebar uses it), and the boundary here
 * maps that type to a class the CSS below animates. The boundary sits in the
 * layout, where enter and exit never fire, so it listens for `update`: the
 * page inside it being swapped.
 *
 * Browser back and forward: no transition (ticket Cut). Nothing to detect for
 * the view transition: a history move carries no transition type, so the
 * boundary resolves to "none" and React starts no view transition at all.
 * Same for a refresh, a streamed-in section, or any link without a type.
 *
 * Reduced motion: the same two fades with no movement (CSS media query).
 * The fast test switch: the sidebar sends no type, so nothing animates.
 *
 * No View Transitions in the browser: the page swaps at once, then a plain
 * fade-in runs on the main area (`TabArrival`). That fallback cannot see
 * transition types, so it detects history moves itself: a `popstate` event
 * marks the next path change as "via history" and the fade is skipped; any
 * click clears the mark, so a hash-only history move cannot swallow the next
 * real navigation.
 *
 * Focus: after a tab change, focus moves to the new page's <h1>, except on
 * Home. Never on first load. The <h1> gets tabindex="-1" only if it has no
 * tabindex yet. If the heading streams in late it is focused when it arrives,
 * unless she has already moved focus into the page.
 */
import { usePathname } from "next/navigation";
import { Suspense, ViewTransition, useEffect, useRef, type ReactNode } from "react";
import { calmDurationMs } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";
import { SIDE_ITEMS, sideCurrent, type NavId } from "./nav-items";

/** Home, Assignments, Exams, Grades, Calendar. */
export const TAB_ORDER: readonly NavId[] = SIDE_ITEMS.map((item) => item.id);

export const TAB_FORWARD = "tab-forward";
export const TAB_BACK = "tab-back";

const OUT_MS = 120;
const IN_MS = 220;
const MOVE_PX = 10;
/** How long a late heading is waited for before giving up. */
const HEADING_WAIT_MS = 3000;

/** 1 when `to` comes after `from` in the tab order, -1 before, 0 when not a tab switch. */
export function tabDirection(from: NavId | null, to: NavId | null): 1 | -1 | 0 {
  if (from === null || to === null || from === to) return 0;
  const a = TAB_ORDER.indexOf(from);
  const b = TAB_ORDER.indexOf(to);
  if (a < 0 || b < 0) return 0;
  return b > a ? 1 : -1;
}

/**
 * The `transitionTypes` for a <Link> from the page at `fromPathname` to
 * `toHref`. Undefined when it is not a switch between two tabs, so the link
 * navigates with no transition.
 */
export function tabTransitionTypes(
  fromPathname: string | null,
  toHref: string,
): string[] | undefined {
  const dir = tabDirection(sideCurrent(fromPathname), sideCurrent(toHref));
  if (dir === 0) return undefined;
  return [dir === 1 ? TAB_FORWARD : TAB_BACK];
}

/** Transition type to view-transition class; anything untyped does not animate. */
const BY_TYPE = { [TAB_FORWARD]: TAB_FORWARD, [TAB_BACK]: TAB_BACK, default: "none" };

/**
 * Kept here, not in globals.css, so the transition is one file. The sidebar
 * and the frame are the "root" snapshot: it is switched to the new state at
 * once so the nav marker's spring is seen live, not cross-faded.
 */
export const PAGE_TRANSITION_CSS = `
::view-transition { pointer-events: none; }
::view-transition-old(.${TAB_FORWARD}), ::view-transition-old(.${TAB_BACK}) {
  animation: ${OUT_MS}ms linear both ready-tab-out;
  mix-blend-mode: normal;
}
::view-transition-new(.${TAB_FORWARD}), ::view-transition-new(.${TAB_BACK}) {
  animation: ${IN_MS}ms var(--e-out, ease-out) ${OUT_MS}ms both ready-tab-in;
  mix-blend-mode: normal;
}
::view-transition-old(.${TAB_FORWARD}), ::view-transition-new(.${TAB_BACK}) { --ready-tab-y: -${MOVE_PX}px; }
::view-transition-new(.${TAB_FORWARD}), ::view-transition-old(.${TAB_BACK}) { --ready-tab-y: ${MOVE_PX}px; }
@keyframes ready-tab-out { to { opacity: 0; translate: 0 var(--ready-tab-y, 0px); } }
@keyframes ready-tab-in { from { opacity: 0; translate: 0 var(--ready-tab-y, 0px); } }
html:active-view-transition-type(${TAB_FORWARD}, ${TAB_BACK})::view-transition-old(root) { display: none; }
html:active-view-transition-type(${TAB_FORWARD}, ${TAB_BACK})::view-transition-new(root) { animation: none; }
@media (prefers-reduced-motion: reduce) {
  ::view-transition-old(.${TAB_FORWARD}), ::view-transition-old(.${TAB_BACK}),
  ::view-transition-new(.${TAB_FORWARD}), ::view-transition-new(.${TAB_BACK}) { --ready-tab-y: 0px; }
}
`;

function isShown(el: HTMLElement): boolean {
  // Pages she left can stay in the DOM, hidden; their headings do not count.
  return typeof el.checkVisibility === "function" ? el.checkVisibility() : true;
}

/**
 * Focuses the first visible <h1> under `root`. Adds tabindex="-1" only when
 * the heading has no tabindex. False when there is no heading yet.
 */
export function focusHeading(root: ParentNode): boolean {
  const heading = Array.from(root.querySelectorAll<HTMLElement>("h1")).find(isShown);
  if (!heading) return false;
  if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  return true;
}

/** After a tab change: move focus to the heading, and fade in where View Transitions are missing. */
function TabArrival() {
  const pathname = usePathname();
  const tab = sideCurrent(pathname);
  const mode = useMotionMode();
  /** undefined until the first path has been seen, so first load does nothing. */
  const lastTab = useRef<NavId | null | undefined>(undefined);
  const viaHistory = useRef(false);

  useEffect(() => {
    const onPop = () => {
      viaHistory.current = true;
    };
    const onClick = () => {
      viaHistory.current = false;
    };
    window.addEventListener("popstate", onPop);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  useEffect(() => {
    const from = lastTab.current;
    lastTab.current = tab;
    const history = viaHistory.current;
    viaHistory.current = false;
    if (from === undefined || tab === null || tab === from) return;
    const main = document.getElementById("main");
    if (!main) return;

    if (
      !history &&
      mode !== "instant" &&
      tabDirection(from, tab) !== 0 &&
      typeof document.startViewTransition !== "function" &&
      typeof main.animate === "function"
    ) {
      main.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: mode === "calm" ? calmDurationMs : IN_MS,
        easing: "ease-out",
      });
    }

    if (tab === "home") return;
    if (focusHeading(main)) return;
    // The heading is still streaming in. Take it when it lands, unless she is already in the page.
    const observer = new MutationObserver(() => {
      if (main.contains(document.activeElement)) observer.disconnect();
      else if (focusHeading(main)) observer.disconnect();
    });
    observer.observe(main, { childList: true, subtree: true });
    const timer = window.setTimeout(() => observer.disconnect(), HEADING_WAIT_MS);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
    // `mode` is read, not watched: a change of motion setting is not a tab change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, tab]);

  return null;
}

/** Wraps the page inside <main id="main">. */
export function PageTransition({ children }: { children: ReactNode }) {
  return (
    <>
      <style href="ready-page-transition" precedence="default">
        {PAGE_TRANSITION_CSS}
      </style>
      {/* Reads the path, which a prerendered shell may not know yet. */}
      <Suspense fallback={null}>
        <TabArrival />
      </Suspense>
      <ViewTransition default="none" update={BY_TYPE}>
        {children}
      </ViewTransition>
    </>
  );
}
