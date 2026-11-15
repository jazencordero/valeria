"use client";

/**
 * Welcome screen (M5-02, intro M5-03). Source: prototype main-flow.html HTML
 * 1266-1284, CSS 242-255 and 550-569, JS 2160-2231 (welcomeIn). Spacing the
 * given CSS ranges do not hold (the start column, the top row, the mini
 * doodles' place, the underline) was measured from the prototype rendered in
 * a browser.
 *
 * Top: the wordmark (tiny cap + "Ready") and the theme button. Middle: the
 * cap on a blush blob with a butter star and a squiggle, the three-line
 * headline (the last line rose italic with a hand-drawn underline) and the
 * sub line. Foot: Get started (to /school) and "Takes about 20 seconds."
 *
 * The intro (full motion only), in ms from load: pencil outlines sketch where
 * the parts go (`Guides`), the blob springs in (250), the cap drops (450) and
 * blinks (600), headline lines one and two type in (from 600), line three
 * springs in (1450) and its underline draws (1550), the sub line fades up
 * (1400), the button lands (1650), the doodles pop (1750, 90 apart), the
 * fine print fades in (2050) and the outlines fade (1900). About 2.3 s.
 *
 * - Any pointerdown or keydown finishes it at once: running animations stop,
 *   the hidden start styles are dropped and the finished screen shows.
 * - Calm (reduced motion): the finished screen with one 150 ms fade.
 * - Instant (?fast=1 or READY_FAST): the finished screen at once.
 * - The finished DOM is the same in every mode. Every part is laid out from
 *   the first paint (hidden by opacity and transforms only, untyped text kept
 *   as invisible text), so nothing shifts.
 *
 * Needs the #wobble filter on the page (`DoodleDefs`, held by the (first-run)
 * layout).
 */
import { spring } from "motion/react";
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ThemeButton } from "@/components/ui/theme-button";
import { Button } from "@/components/ui/button";
import { Guides } from "@/components/ui/guides";
import { Caret, capTimeline, planTimeline, useReveal } from "@/components/ui/typewriter";
import { Vitonen, type VitonenHandle } from "@/components/vitonen";
import { calmDurationMs, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

const BLOB =
  "M102 8 C150 6 194 34 190 80 C186 124 142 146 96 142 C50 138 8 118 10 74 C12 32 54 10 102 8 Z";
const STAR =
  "M12 3l2.3 5.4 5.7.5-4.4 3.8 1.4 5.6L12 15.3l-5 3 1.4-5.6L4 8.9l5.7-.5z";
const SQUIG = "M2 10 q5 -9 10 0 t10 0 t10 -2";
const UNDERLINE = "M3 9 C 30 3, 50 13, 80 7 S 130 3, 160 8 S 190 10, 197 5";

const LINE_1 = "Get a 5.";
const LINE_2 = "Worry less.";

/** Small hand-drawn marks: ink-2 line, round ends. */
const MINI =
  "absolute [&_path]:stroke-ink-2 [&_path]:[stroke-width:1.6] [&_path]:[stroke-linecap:round] [&_path]:[stroke-linejoin:round]";

/** When the headline starts typing, in ms from load. */
const TYPE_AT_MS = 600;
/** When the outlines start to fade. */
const GUIDES_FADE_AT_MS = 1900;

type Part = "blob" | "cap" | "line3" | "underline" | "sub" | "button" | "star" | "squig" | "fine";

type Step = {
  /** The hidden start, also rendered on the server so nothing flashes. */
  from: CSSProperties;
  keyframes: PropertyIndexedKeyframes;
  /** In ms from load. */
  delay: number;
  duration: number;
  /** A spring with this bounce over `duration`; leave out for an ease-out. */
  bounce?: number;
};

const rise = (from: string, to: string) => ({ transform: [from, to], opacity: [0, 1] });

/** The intro, part by part (prototype welcomeIn). */
const STEPS: Record<Part, Step> = {
  blob: {
    from: { opacity: 0, transform: "scale(1.15) rotate(-7deg)" },
    keyframes: rise("scale(1.15) rotate(-7deg)", "scale(1) rotate(0deg)"),
    delay: 250,
    duration: 400,
    bounce: 0.3,
  },
  cap: {
    from: { opacity: 0, transform: "translateY(-40px)" },
    keyframes: rise("translateY(-40px)", "translateY(0px)"),
    delay: 450,
    duration: 400,
    bounce: 0.25,
  },
  line3: {
    from: { opacity: 0, transform: "scale(0.9)" },
    keyframes: rise("scale(0.9)", "scale(1)"),
    delay: 1450,
    duration: 350,
    bounce: 0.3,
  },
  underline: {
    from: { strokeDashoffset: 1 },
    keyframes: { strokeDashoffset: [1, 0] },
    delay: 1550,
    duration: 300,
  },
  sub: {
    from: { opacity: 0, transform: "translateY(8px)" },
    keyframes: rise("translateY(8px)", "translateY(0px)"),
    delay: 1400,
    duration: 300,
  },
  button: {
    from: { opacity: 0, transform: "translateY(-10px)" },
    keyframes: rise("translateY(-10px)", "translateY(0px)"),
    delay: 1650,
    duration: 300,
    bounce: 0.25,
  },
  star: {
    from: { opacity: 0, transform: "scale(0)" },
    keyframes: rise("scale(0)", "scale(1)"),
    delay: 1750,
    duration: 300,
    bounce: 0.3,
  },
  squig: {
    from: { opacity: 0, transform: "scale(0)" },
    keyframes: rise("scale(0)", "scale(1)"),
    delay: 1840,
    duration: 300,
    bounce: 0.3,
  },
  fine: {
    from: { opacity: 0 },
    keyframes: { opacity: [0, 1] },
    delay: 2050,
    duration: 300,
  },
};

const PARTS = Object.keys(STEPS) as Part[];

const cubic = (e: readonly number[]) => `cubic-bezier(${e.join(",")})`;

/**
 * Web Animations timing for a step. Springs become a linear() curve from
 * motion's spring, so the browser plays every part and cancel() leaves no
 * inline style behind.
 */
function timing(step: Step): KeyframeAnimationOptions {
  const base = { delay: step.delay, fill: "both" as const };
  if (step.bounce === undefined) return { ...base, duration: step.duration, easing: cubic(ease.out) };
  // "400ms linear(...)": the settle time and the curve.
  const curve = String(spring({ keyframes: [0, 1], bounce: step.bounce, duration: step.duration }));
  const gap = curve.indexOf(" ");
  return { ...base, duration: parseFloat(curve), easing: curve.slice(gap + 1) };
}

function partEl(root: HTMLElement | null, part: Part): HTMLElement | SVGElement | null {
  return root?.querySelector<HTMLElement | SVGElement>(`[data-part="${part}"]`) ?? null;
}

/**
 * One headline line being typed: typed text, the caret, the untyped rest kept
 * in place. The caret (1.1em) is taller than this line (1.08), so it hangs
 * out of the flow and the line keeps its height.
 */
function TypedLine({ text, shown, caret }: { text: string; shown: number; caret: boolean }) {
  return (
    <>
      <span>{text.slice(0, shown)}</span>
      {caret && (
        <span className="relative">
          <span className="absolute top-[0.08em] left-0 leading-none">
            <Caret />
          </span>
        </span>
      )}
      <span className="invisible">{text.slice(shown)}</span>
    </>
  );
}

export function Welcome() {
  const mode = useMotionMode();
  const [done, setDone] = useState(false);
  const intro = mode === "full" && !done;

  const root = useRef<HTMLDivElement>(null);
  const cap = useRef<VitonenHandle>(null);
  /** The hidden start while the intro runs; nothing once it is over. */
  const from = (part: Part): CSSProperties | undefined => (intro ? STEPS[part].from : undefined);

  // Lines one and two: one typing timeline, started TYPE_AT_MS after load.
  const at = useMemo(
    () =>
      capTimeline(
        planTimeline([
          { kind: "text", text: LINE_1 },
          { kind: "text", text: LINE_2 },
        ]),
      ).map((t) => t + TYPE_AT_MS),
    [],
  );
  const typed = useReveal(at, { instant: !intro });
  const typing = intro && !typed.finished;
  const shown1 = Math.min(typed.shown, LINE_1.length);
  const shown2 = Math.max(0, typed.shown - LINE_1.length);

  // The intro: play every part, finish on any input. The animations hold
  // their start (fill both) and are cancelled when it ends, so the finished
  // DOM carries nothing they set.
  useLayoutEffect(() => {
    if (!intro) return;
    const anims: Animation[] = [];
    for (const part of PARTS) {
      const el = partEl(root.current, part);
      const a = el?.animate?.(STEPS[part].keyframes, timing(STEPS[part]));
      if (a) anims.push(a);
    }
    let live = true;
    const blink = window.setTimeout(() => cap.current?.react("blink"), TYPE_AT_MS);
    const finish = () => {
      if (!live) return;
      live = false;
      setDone(true);
    };
    Promise.all(anims.map((a) => a.finished)).then(finish, () => {});
    window.addEventListener("pointerdown", finish, true);
    window.addEventListener("keydown", finish, true);
    return () => {
      live = false;
      window.clearTimeout(blink);
      window.removeEventListener("pointerdown", finish, true);
      window.removeEventListener("keydown", finish, true);
      for (const a of anims) a.cancel();
    };
  }, [intro]);

  // React empties the start styles but keeps style=""; drop it, so the
  // finished DOM is the one calm and instant render.
  useLayoutEffect(() => {
    if (intro) return;
    for (const part of PARTS) {
      const el = partEl(root.current, part);
      if (el?.getAttribute("style") === "") el.removeAttribute("style");
    }
  }, [intro]);

  // Calm: the finished screen, one 150 ms fade.
  useLayoutEffect(() => {
    if (mode !== "calm") return;
    const a = root.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], {
      duration: calmDurationMs,
      easing: "linear",
    });
    return () => a?.cancel();
  }, [mode]);

  return (
    // From 700 px the prototype's page is paper (body background there); the
    // app's body stays surface, so the screen paints it itself.
    <div ref={root} className="min-h-dvh min-[700px]:bg-paper">
      <div className="relative mx-auto flex min-h-dvh w-full max-w-[440px] flex-col px-[var(--pad)] pt-[max(16px,env(safe-area-inset-top,0px))] pb-[max(28px,env(safe-area-inset-bottom,0px))]">
        <div className="-mr-3 flex items-center justify-between">
          <div className="inline-flex min-h-11 items-center gap-2 font-display text-[20px] font-semibold tracking-[-0.01em] [font-variation-settings:'SOFT'_100]">
            <Vitonen size={24} />
            Ready
          </div>
          <ThemeButton />
        </div>

        <div className="flex flex-1 flex-col justify-center py-4">
          <div
            data-guide
            className="relative mx-auto mb-6 flex h-[150px] w-[200px] items-end justify-center"
            aria-hidden="true"
          >
            <svg
              data-part="blob"
              style={from("blob")}
              className="absolute inset-0 h-full w-full"
              viewBox="0 0 200 150"
              aria-hidden="true"
              focusable="false"
            >
              <path d={BLOB} className="fill-accent-wash" />
            </svg>
            <span data-part="cap" style={from("cap")} className="relative mb-3 flex">
              <Vitonen ref={cap} size={120} state="idle" />
            </span>
            <svg
              data-part="star"
              style={from("star")}
              className={`${MINI} top-1.5 left-2 h-6 w-6 [&_path]:fill-butter`}
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <g filter="url(#wobble)">
                <path d={STAR} />
              </g>
            </svg>
            <svg
              data-part="squig"
              style={from("squig")}
              className={`${MINI} top-[26px] right-0.5 h-4 w-[34px] [&_path]:fill-none`}
              viewBox="0 0 34 16"
              aria-hidden="true"
              focusable="false"
            >
              <g filter="url(#wobble)">
                <path d={SQUIG} />
              </g>
            </svg>
          </div>

          <h1
            className="text-[34px] leading-[1.08]"
            aria-label={intro ? `${LINE_1} ${LINE_2} Party more.` : undefined}
          >
            <span data-guide className="block">
              {intro ? <TypedLine text={LINE_1} shown={shown1} caret={typing && typed.shown > 0 && shown1 < LINE_1.length} /> : LINE_1}
            </span>
            <span data-guide className="block">
              {intro ? <TypedLine text={LINE_2} shown={shown2} caret={typing && shown1 >= LINE_1.length} /> : LINE_2}
            </span>
            <span
              data-guide
              data-part="line3"
              style={from("line3")}
              className="relative inline-block font-medium text-accent italic"
            >
              Party more.
              <svg
                className="absolute -bottom-1.5 left-0 h-2.5 w-full overflow-visible"
                viewBox="0 0 200 14"
                preserveAspectRatio="none"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  data-part="underline"
                  style={from("underline")}
                  pathLength={1}
                  d={UNDERLINE}
                  className="fill-none stroke-accent [stroke-dasharray:1] [stroke-linecap:round] [stroke-width:2.5]"
                />
              </svg>
            </span>
          </h1>
          <p
            data-guide
            data-part="sub"
            style={from("sub")}
            className="mt-4 max-w-[32ch] text-[17px] text-ink-2"
          >
            Your courses, deadlines and homework, sorted before you finish your
            coffee.
          </p>
        </div>

        <div className="grid gap-3 pt-4 text-center">
          <div data-guide data-part="button" style={from("button")}>
            <Button href="/school" size="lg" block>
              Get started
            </Button>
          </div>
          <p data-part="fine" style={from("fine")} className="fine">
            Takes about 20 seconds.
          </p>
        </div>

        {intro && <Guides targets="[data-guide]" fadeAfterMs={GUIDES_FADE_AT_MS} />}
      </div>
    </div>
  );
}
