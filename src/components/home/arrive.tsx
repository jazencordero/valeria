"use client";

/**
 * Home builds itself on first arrival (M4-11). Source: prototype
 * main-flow.html JS 4042-4076 (homeArrive), 2200-2220 (drawGuides) and CSS
 * 550-554 (.guides).
 *
 *   <Arrive play={arrive} className="grid ...">
 *     <StickyHeader data-arrive-part="bare" style={{ "--arrive-i": 0 }} />
 *     <section data-arrive-part="" style={{ "--arrive-i": 1 }}>...</section>
 *   </Arrive>
 *
 * `Arrive` is the element that holds Home's sections (it takes the grid's
 * class names and adds `relative`). The server page marks each section with
 * `data-arrive-part` and its place in the order (`--arrive-i`); a part marked
 * "bare" rises in but gets no outline (the top row).
 *
 * `play` false (every ordinary visit): a plain div, nothing else.
 *
 * `play` true (`/home?arrive=1`), once:
 * - pencil-dashed outlines sketch each part (`Guides`), 40 ms apart;
 * - from 240 ms the parts rise in (6 px, 260 ms), 70 ms apart;
 * - at 400 ms the forecast rings draw and percentages and minutes count up
 *   from 0 over 600 ms;
 * - 200 ms after the last part started rising the outlines fade (300 ms);
 * - the greeting types by its own rule (`Greeting`: the first time a sentence
 *   is shown in a tab), as its part rises in.
 * `arrive` is taken out of the address when the build starts, so a reload
 * shows Home at rest.
 *
 * The rise is plain CSS, so the page does not flash before the script runs:
 * the server sends the parts held back (`data-arrive="wait"`), and the build
 * starts when this component is live in the browser. Without script the
 * parts simply appear when the hold runs out (3 s). No extra elements in the
 * flow, so nothing shifts.
 *
 * Reduced motion: one 150 ms fade of the whole page, nothing else. The test
 * switch (?fast=1 or READY_FAST): nothing at all.
 *
 * The rings and numbers are found in the page as it stands: `Ring`'s accent
 * circle (`[role=img][data-value]`), `[data-pct]`, and any "N min" or
 * "N-minute" text that is an amount (not a clock like "15 h 41 min left").
 */
import { animate } from "motion/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Guides, GUIDE_FADE_MS } from "@/components/ui/guides";
import { applyFast, isFast } from "@/lib/motion/fast";
import { calmDurationMs, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

/** The query flag that plays the build (the server page reads it: `?arrive=1`). */
const ARRIVE_PARAM = "arrive";

/** The first part starts rising this long after the build starts, the next ones this far apart. */
export const RISE_START_MS = 240;
export const RISE_STEP_MS = 70;
export const RISE_MS = 260;
/** Parts after the ninth rise together with it (prototype: Math.min(i, 8)). */
export const RISE_MAX_STEPS = 8;
/** Rings draw and numbers count from here, for this long. */
export const COUNT_START_MS = 120 + 4 * RISE_STEP_MS;
export const COUNT_MS = 600;
/** Without script, held-back parts appear after this long. */
export const HOLD_MS = 3000;

const EASE_OUT = `cubic-bezier(${ease.out.join(",")})`;
const PARTS = "[data-arrive-part]";
const GUIDED = '[data-arrive-part]:not([data-arrive-part="bare"])';
const REDUCE = "(prefers-reduced-motion: reduce)";

const ARRIVE_CSS = `@keyframes arrive-hold{0%,90%{opacity:0}100%{opacity:1}}
@keyframes arrive-rise{from{opacity:0;transform:translateY(6px)}}
@keyframes arrive-fade{from{opacity:0}}
[data-arrive="wait"] ${PARTS}{animation:arrive-hold ${HOLD_MS}ms linear backwards}
[data-arrive="play"] ${PARTS}{animation:arrive-rise ${RISE_MS}ms ${EASE_OUT} backwards;animation-delay:calc(${RISE_START_MS}ms + min(var(--arrive-i,0),${RISE_MAX_STEPS}) * ${RISE_STEP_MS}ms)}
@media ${REDUCE}{
[data-arrive] ${PARTS}{animation:none}
[data-arrive="wait"]{animation:arrive-fade ${calmDurationMs}ms linear backwards}
}
:root[data-fast] [data-arrive],:root[data-fast] [data-arrive] ${PARTS}{animation:none!important}`;

/** When the outlines start to fade, for this many parts. */
export function guidesFadeAt(parts: number): number {
  return RISE_START_MS + Math.min(parts, RISE_MAX_STEPS) * RISE_STEP_MS + 200;
}

/** When the whole build is over, for this many parts. */
export function buildEndsAt(parts: number): number {
  return Math.max(guidesFadeAt(parts) + GUIDE_FADE_MS, COUNT_START_MS + COUNT_MS) + 50;
}

/** Takes `arrive` out of the address without a navigation. */
function dropFlag(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(ARRIVE_PARAM)) return;
  url.searchParams.delete(ARRIVE_PARAM);
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

type Counter = { node: Text; rest: string; show: (n: number) => string; to: number; last: string };

const MINUTES = /\d+(?=[ -]?min)/i;
/** Clock text ("15 h 41 min left", "5 h 8 min early") is not counted: it is a time, not an amount. */
const CLOCK = /\d\s?h\b|\b(left|early|late|ago)\b/i;

/** Every number that counts up: ring labels, `[data-pct]`, and minutes in running text. */
function findCounters(root: HTMLElement): Counter[] {
  const out: Counter[] = [];
  const whole = (el: Element) => {
    const node = el.firstChild;
    if (!(node instanceof Text) || !/^\d+$/.test(node.data)) return;
    out.push({ node, rest: node.data, to: Number(node.data), show: String, last: node.data });
  };
  root.querySelectorAll('[role="img"][data-value] > b, [data-pct]').forEach(whole);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const m = MINUTES.exec(node.data);
    if (!m || CLOCK.test(node.parentElement?.textContent ?? node.data)) continue;
    const before = node.data.slice(0, m.index);
    const after = node.data.slice(m.index + m[0].length);
    out.push({ node, rest: node.data, to: Number(m[0]), show: (v) => `${before}${v}${after}`, last: node.data });
  }
  return out;
}

/** Writes a counter's text, unless something else (React) has changed it since. */
function write(c: Counter, text: string): void {
  if (c.node.data !== c.last) return;
  c.node.data = text;
  c.last = text;
}

/** Redraws every ring from empty, starting at `delay`. Returns the running animations. */
function drawRings(root: HTMLElement, delay: number): Animation[] {
  const out: Animation[] = [];
  root.querySelectorAll<SVGCircleElement>('[role="img"][data-value] circle.stroke-accent').forEach((circle) => {
    const value = Number(circle.closest("[data-value]")?.getAttribute("data-value"));
    if (!value || typeof circle.animate !== "function") return;
    out.push(
      circle.animate([{ strokeDashoffset: value }, { strokeDashoffset: 0 }], {
        duration: COUNT_MS,
        delay,
        easing: EASE_OUT,
        fill: "backwards",
      }),
    );
  });
  return out;
}

export type ArriveProps = {
  /** Play the build: the first visit after connecting (`?arrive=1`). */
  play?: boolean;
  className?: string;
  children: ReactNode;
};

export function Arrive({ play = false, className = "", children }: ArriveProps) {
  const ref = useRef<HTMLDivElement>(null);
  const mode = useMotionMode();
  const [done, setDone] = useState(false);
  const [fade, setFade] = useState(false);
  const [guidesGone, setGuidesGone] = useState(false);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!play || !root) return;
    dropFlag();
    applyFast();
    if (isFast()) return; // `mode` turns "instant" and the page is at rest.

    const finish = () => setDone(true);
    if (window.matchMedia(REDUCE).matches) {
      // The one fade is CSS and started with the page; let it finish.
      const t = window.setTimeout(finish, calmDurationMs);
      return () => window.clearTimeout(t);
    }
    const parts = root.querySelectorAll<HTMLElement>(PARTS);
    const first = parts[0];
    // Already showing (the hold ran out before the script was live): leave it.
    // (Under React strict mode this runs twice; the second time the rise is on.)
    const shown =
      typeof first?.getAnimations === "function" &&
      !first.getAnimations().some((a) => a instanceof CSSAnimation && a.animationName.startsWith("arrive-"));
    if (shown) {
      const t = window.setTimeout(finish, 0);
      return () => window.clearTimeout(t);
    }

    // Start the rise now, in step with the outlines. React keeps rendering
    // "wait" until the build is done, so it leaves this attribute alone.
    root.dataset.arrive = "play";

    const rings = drawRings(root, COUNT_START_MS);
    const counters = findCounters(root);
    counters.forEach((c) => write(c, c.show(0)));
    const count = animate(0, 1, {
      duration: COUNT_MS / 1000,
      delay: COUNT_START_MS / 1000,
      ease: ease.out,
      onUpdate: (p) => counters.forEach((c) => write(c, c.show(Math.round(c.to * p)))),
    });
    const settle = () => {
      count.stop();
      counters.forEach((c) => write(c, c.rest));
    };
    const fading = window.setTimeout(() => setFade(true), guidesFadeAt(parts.length));
    const end = window.setTimeout(() => {
      settle();
      finish();
    }, buildEndsAt(parts.length));

    return () => {
      window.clearTimeout(fading);
      window.clearTimeout(end);
      settle();
      rings.forEach((a) => a.cancel());
    };
  }, [play]);

  const live = play && !done && mode !== "instant";

  return (
    <div ref={ref} className={`relative ${className}`.trim()} data-arrive={live ? "wait" : undefined}>
      {live && (
        <style href="ready-arrive" precedence="default">
          {ARRIVE_CSS}
        </style>
      )}
      {children}
      {live && !guidesGone && <Guides targets={GUIDED} fade={fade} onDone={() => setGuidesGone(true)} />}
    </div>
  );
}
