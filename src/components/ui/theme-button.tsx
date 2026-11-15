"use client";

/**
 * Light and dark switch (M4-05). Source: prototype main-flow.html
 * JS 3568-3607, CSS 585-596.
 *
 * A moon (light now) or sun (dark now) icon button, `aria-pressed` when dark.
 * Pressing it writes `data-theme` on <html>, saves localStorage['ready-theme']
 * and dispatches a `themechange` CustomEvent on window (`detail.theme`).
 * With full motion the page cross-fades through the View Transitions API
 * (220 ms, linear) and then the icon spins in from -90 degrees (240 ms).
 * Calm or instant motion: the colours swap at once, no fade, no spin.
 *
 * No flash on reload: the root layout's boot script copies the saved choice
 * onto <html data-theme> before first paint. This button only reads that
 * attribute (system scheme when it is missing), so it never fights it.
 * Before hydration the theme is unknown (null) and `aria-pressed` is left
 * out, so server and client markup match.
 *
 * Cut: no "follow system" third state. Clearing site data returns to system.
 *
 * Used in the sidebar next to the user chip; exported for Home's top row on
 * phones and the Welcome screen.
 */
import { useRef, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

export type Theme = "light" | "dark";

/** localStorage key; the boot script in src/app/layout.tsx uses the same literal. */
export const THEME_KEY = "ready-theme";

/** Event the button dispatches on window after the theme changes. */
export const THEME_EVENT = "themechange";

export type ThemeChangeDetail = { theme: Theme };

const DARK_QUERY = "(prefers-color-scheme: dark)";
/** View transition type, so the 220 ms fade below only styles this transition. */
const VT_TYPE = "ready-theme";
const SPIN_MS = 240;
const EASE_OUT = `cubic-bezier(${ease.out.join(", ")})`;

const THEME_VT_CSS = `html:active-view-transition-type(${VT_TYPE})::view-transition-old(root),
html:active-view-transition-type(${VT_TYPE})::view-transition-new(root) { animation-duration: 220ms; animation-timing-function: linear; }`;

/** The theme on screen: <html data-theme>, else the system scheme. */
export function currentTheme(): Theme {
  const d = document.documentElement.dataset.theme;
  if (d === "light" || d === "dark") return d;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab, a preview page or the system scheme can change it too.
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener("change", onChange);
  return () => {
    listeners.delete(onChange);
    mo.disconnect();
    mq.removeEventListener("change", onChange);
  };
}

function getServerSnapshot(): Theme | null {
  return null;
}

/** The current theme; null until hydrated. */
export function useTheme(): Theme | null {
  return useSyncExternalStore(subscribe, currentTheme, getServerSnapshot);
}

/** Writes the theme without any animation, tells every button and chart. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private mode or storage blocked: the choice lasts for this page only.
  }
  // Re-render the buttons now, so the view transition's new snapshot has the new icon.
  flushSync(() => listeners.forEach((fn) => fn()));
  window.dispatchEvent(new CustomEvent<ThemeChangeDetail>(THEME_EVENT, { detail: { theme } }));
}

type StartVT = (arg: unknown) => { finished: Promise<void> };

/** Cross-fades the swap where the browser can; false when it could not. */
function crossFade(update: () => void, after: () => void): boolean {
  const start = (document as unknown as { startViewTransition?: StartVT }).startViewTransition;
  if (typeof start !== "function") return false;
  let vt: { finished: Promise<void> };
  try {
    vt = start.call(document, { update, types: [VT_TYPE] });
  } catch {
    // Older engines take only a callback (no types): the default fade.
    try {
      vt = start.call(document, update);
    } catch {
      return false;
    }
  }
  vt.finished.then(after, after);
  return true;
}

const MOON = "M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7z";
const SUN_RAYS =
  "M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4";

export type ThemeButtonProps = {
  /** Extra classes for placement (margins). */
  className?: string;
};

export function ThemeButton({ className = "" }: ThemeButtonProps) {
  const theme = useTheme();
  const mode = useMotionMode();
  const svgRef = useRef<SVGSVGElement>(null);
  const dark = theme === "dark";

  const spin = () => {
    svgRef.current?.animate(
      [
        { opacity: 0, transform: "rotate(-90deg)" },
        { opacity: 1, transform: "rotate(0deg)" },
      ],
      { duration: SPIN_MS, easing: EASE_OUT },
    );
  };

  const toggle = () => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    const update = () => applyTheme(next);
    if (mode !== "full") {
      update();
      return;
    }
    if (!crossFade(update, spin)) {
      update();
      spin();
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Dark mode"
      aria-pressed={theme === null ? undefined : dark}
      title="Dark mode"
      data-testid="theme-button"
      className={`grid h-11 w-11 flex-none place-items-center rounded-xl border-0 bg-transparent text-ink-2 transition-colors duration-quick ease-out [@media(hover:hover)]:hover:bg-surface [@media(hover:hover)]:hover:text-ink ${className}`}
    >
      <style href="ready-theme-vt" precedence="default">
        {THEME_VT_CSS}
      </style>
      <svg ref={svgRef} className="ic !h-5 !w-5" viewBox="0 0 24 24" aria-hidden="true">
        {dark ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d={SUN_RAYS} />
          </>
        ) : (
          <path d={MOON} />
        )}
      </svg>
    </button>
  );
}
