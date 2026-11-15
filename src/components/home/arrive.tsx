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
 * `arrive` is taken out of the address when this component is live, so a
 * reload shows Home at rest.
 *
 * The content never waits for the script (M8-70). The rise is plain CSS and
 * the server sends it already playing (`data-arrive="play"`): the parts
 * start rising 80 ms after the page is first styled, with or without script.
 * What the script does depends on when it is live:
 * - nothing is showing yet (a normal phone or laptop): it starts the build
 *   above from the top (`data-arrive="build"`), outlines first;
 * - some parts are showing: it joins the rise that is playing. Outlines are
 *   sketched, and the rings and numbers of the parts still to come draw and
 *   count; what she can already see is left alone (no number drops to 0);
 * - every part is showing (a slow phone): it adds nothing
 *   (`data-arrive="late"`).
 * No extra elements in the flow, so nothing shifts.
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
/** The rise the server sends starts this soon: it does not wait for the outlines, which need the script. */
export const EARLY_START_MS = 80;

const EASE_OUT = `cubic-bezier(${ease.out.join(",")})`;
const PARTS = "[data-arrive-part]";
const GUIDED = '[data-arrive-part]:not([data-arrive-part="bare"])';
const REDUCE = "(prefers-reduced-motion: reduce)";

const delay = (start: number) => `calc(${start}ms + min(var(--arrive-i,0),${RISE_MAX_STEPS}) * ${RISE_STEP_MS}ms)`;

const rise = (name: string, start: number) =>
  `animation:${name} ${RISE_MS}ms ${EASE_OUT} backwards,arrive-show 1ms linear backwards;animation-delay:${delay(start)}`;

// Two names for the same rise: changing the name is what starts it again
// ("build"); "late" keeps the name, so the rise that is playing goes on.
//
// `arrive-show` makes the browser paint a part again on the first frame of
// its rise. The rise itself runs off the main thread, and without this
// Chrome only notices the part has appeared when the rise ends (which is the
// time it would report as largest contentful paint, 260 ms late).
const ARRIVE_CSS = `@keyframes arrive-rise{from{opacity:0;transform:translateY(6px)}}
@keyframes arrive-build{from{opacity:0;transform:translateY(6px)}}
@keyframes arrive-show{from{visibility:hidden}}
@keyframes arrive-fade{from{opacity:0}}
[data-arrive="play"] ${PARTS},[data-arrive="late"] ${PARTS}{${rise("arrive-rise", EARLY_START_MS)}}
[data-arrive="build"] ${PARTS}{${rise("arrive-build", RISE_START_MS)}}
[data-arrive="late"] [data-guides]{display:none}
@media ${REDUCE}{
[data-arrive] ${PARTS}{animation:none}
[data-arrive]{animation:arrive-fade ${calmDurationMs}ms linear backwards}
}
:root[data-fast] [data-arrive],:root[data-fast] [data-arrive] ${PARTS}{animation:none!important}`;

/**
 * The times below are counted from the start of the rise's own clock. `start`
 * is when the first part starts rising: `RISE_START_MS` in the full build,
 * `EARLY_START_MS` when the script joins the rise the server started.
 */

/** When the last of this many parts has risen. */
export function riseEndsAt(parts: number, start = RISE_START_MS): number {
  return start + Math.min(Math.max(parts - 1, 0), RISE_MAX_STEPS) * RISE_STEP_MS + RISE_MS;
}

/** When the outlines start to fade, for this many parts. */
export function guidesFadeAt(parts: number, start = RISE_START_MS): number {
  return start + Math.min(parts, RISE_MAX_STEPS) * RISE_STEP_MS + 200;
}

/** When the rings start to draw and the numbers to count. */
export function countStartsAt(start = RISE_START_MS): number {
  return start + COUNT_START_MS - RISE_START_MS;
}

/** When the whole build is over, for this many parts. */
export function buildEndsAt(parts: number, start = RISE_START_MS): number {
  return Math.max(guidesFadeAt(parts, start) + GUIDE_FADE_MS, countStartsAt(start) + COUNT_MS) + 50;
}

/**
 * Where a part's rise stands: `at` ms on its clock, visible from `from` ms.
 * `null` when it has finished (or never ran); `undefined` when the browser
 * cannot say (then the script acts as if nothing is showing yet).
 */
type Rise = { at: number; from: number } | null | undefined;

function riseOf(part: HTMLElement): Rise {
  if (typeof part.getAnimations !== "function") return undefined;
  for (const a of part.getAnimations()) {
    const name = (a as Partial<CSSAnimation>).animationName;
    if (name !== "arrive-rise" && name !== "arrive-build") continue;
    return { at: Number(a.currentTime ?? 0), from: Number(a.effect?.getComputedTiming().delay ?? 0) };
  }
  return null;
}

/** Still fully invisible: its rise has not reached its first frame. */
const waiting = (rise: Rise): boolean => rise === undefined || (rise !== null && rise.at < rise.from);

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

/** Every number that counts up: ring labels, `[data-pct]`, and minutes in running text. `skip`: leave these alone. */
function findCounters(root: HTMLElement, skip: (n: Node) => boolean): Counter[] {
  const out: Counter[] = [];
  const whole = (el: Element) => {
    const node = el.firstChild;
    if (!(node instanceof Text) || !/^\d+$/.test(node.data) || skip(node)) return;
    out.push({ node, rest: node.data, to: Number(node.data), show: String, last: node.data });
  };
  root.querySelectorAll('[role="img"][data-value] > b, [data-pct]').forEach(whole);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const m = MINUTES.exec(node.data);
    if (!m || skip(node) || CLOCK.test(node.parentElement?.textContent ?? node.data)) continue;
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

/** Redraws every ring from empty, starting at `delay`. `skip`: leave these alone. Returns the running animations. */
function drawRings(root: HTMLElement, delay: number, skip: (n: Node) => boolean): Animation[] {
  const out: Animation[] = [];
  root.querySelectorAll<SVGCircleElement>('[role="img"][data-value] circle.stroke-accent').forEach((circle) => {
    const value = Number(circle.closest("[data-value]")?.getAttribute("data-value"));
    if (!value || typeof circle.animate !== "function" || skip(circle)) return;
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
    // The rise has been playing since the server's HTML was styled. Where is it?
    const parts = Array.from(root.querySelectorAll<HTMLElement>(PARTS));
    const rises = parts.map(riseOf);
    const showing = parts.filter((_, i) => !waiting(rises[i]));
    // React keeps rendering "play" until the build is done, so it leaves the
    // attribute alone when it is changed here.
    if (showing.length === parts.length) {
      // Every part is showing or has finished: add nothing, let the rise end.
      root.dataset.arrive = "late";
      const at = Math.max(0, ...rises.map((r) => r?.at ?? Infinity).filter(Number.isFinite));
      const left = rises.some((r) => r) ? riseEndsAt(parts.length, EARLY_START_MS) - at + 50 : 0;
      const t = window.setTimeout(finish, Math.max(0, left));
      return () => window.clearTimeout(t);
    }
    // Nothing is showing yet: start the full build from the top, outlines
    // first. (Under React strict mode this runs twice; the second time the
    // build's own rise is on, and still waiting.) Otherwise join the rise
    // that is playing, `at` ms in.
    const full = showing.length === 0;
    const start = full ? RISE_START_MS : EARLY_START_MS;
    const at = full ? 0 : Math.max(0, ...rises.map((r) => r?.at ?? 0));
    if (full) root.dataset.arrive = "build";
    const seen = (n: Node) => showing.some((p) => p.contains(n));
    const from = (ms: number) => Math.max(0, ms - at);

    const rings = drawRings(root, from(countStartsAt(start)), seen);
    const counters = findCounters(root, seen);
    counters.forEach((c) => write(c, c.show(0)));
    const count = animate(0, 1, {
      duration: COUNT_MS / 1000,
      delay: from(countStartsAt(start)) / 1000,
      ease: ease.out,
      onUpdate: (p) => counters.forEach((c) => write(c, c.show(Math.round(c.to * p)))),
    });
    const settle = () => {
      count.stop();
      counters.forEach((c) => write(c, c.rest));
    };
    const fading = window.setTimeout(() => setFade(true), from(guidesFadeAt(parts.length, start)));
    const end = window.setTimeout(
      () => {
        settle();
        finish();
      },
      from(buildEndsAt(parts.length, start)),
    );

    return () => {
      window.clearTimeout(fading);
      window.clearTimeout(end);
      settle();
      rings.forEach((a) => a.cancel());
    };
  }, [play]);

  const live = play && !done && mode !== "instant";

  return (
    <div ref={ref} className={`relative ${className}`.trim()} data-arrive={live ? "play" : undefined}>
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
