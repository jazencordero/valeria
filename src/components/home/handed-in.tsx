"use client";

/**
 * After a hand-in, Home rearranges itself (M4-12). Source: prototype
 * main-flow.html JS 4125-4160 (endState).
 *
 *   <HandedIn play={justHandedIn} id={`${done.id}:${done.submittedAt.getTime()}`}>
 *     <HandedInGreeting sentence="Handed in, 5 hours early. ..." />
 *     <Slide as="section">
 *       <Swap before={<HeroCard ...the one she handed in />} done={<DoneRow ... />}>
 *         <HeroCard ...the next one />
 *       </Swap>
 *     </Slide>
 *     <Slide as="section">
 *       <BeforeOnly>...the next one, still a row in the list</BeforeOnly>
 *       <Slide>...rows numbered with <QueueNumber n={2} /></Slide>
 *     </Slide>
 *   </HandedIn>
 *
 * The server page always sends the after state, plus the one card that is
 * gone (`before`). `play` is the hand-in flash (`src/server/data/flash.ts`):
 * she handed in a moment ago, in this visit. Then, once:
 *
 * - Home first shows the before state: the handed-in card still as Do first,
 *   the next item still a row in the list, the numbers one higher, and the
 *   greeting she last saw;
 * - after a beat the card fades and shrinks to 0.96 (180 ms);
 * - the done row appears in its place (240 ms), the next item fades and rises
 *   in the Do first slot (300 ms), everything below slides to its new place
 *   (380 ms, Motion layout animations) and the queue numbers roll;
 * - 200 ms later the greeting types the handed-in sentence.
 *
 * "Once" is per hand-in and per browser tab: the id of the hand-in that has
 * played sits in sessionStorage, so coming back to Home inside the flash's
 * minute shows the after state at rest. (A reload never gets `play`: the
 * proxy drops the flash on a full page load.)
 *
 * Reduced motion: the after state, Do first fading in over 150 ms. The test
 * switch (?fast=1 or READY_FAST): the after state at rest. Without `play`
 * every part here renders plain markup and nothing else.
 *
 * Never together with `Arrive` (the page plays one or the other).
 */
import { motion } from "motion/react";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Greeting } from "@/components/home/greeting";
import { RollingNumber } from "@/components/ui/rolling-number";
import { applyFast, isFast } from "@/lib/motion/fast";
import { calmDurationMs, ease } from "@/lib/motion/tokens";

/** The before state stays this long, so she sees what is about to change. */
export const HOLD_MS = 320;
/** The handed-in card fades and shrinks. */
export const OUT_MS = 180;
/** The done row appears. */
export const DONE_IN_MS = 240;
/** The next item fades and rises into the Do first slot. */
export const RISE_MS = 300;
/** Everything below slides to its new place. */
export const SLIDE_MS = 380;
/** The greeting starts typing this long after the swap. */
export const GREET_AFTER_MS = 200;
/** From the swap until every part has settled. */
export const SETTLE_MS = Math.max(DONE_IN_MS, RISE_MS, SLIDE_MS) + 120;

const REDUCE = "(prefers-reduced-motion: reduce)";
const PLAYED_KEY = "ready.handedIn.played";
/** Keep in step with `STORE_KEY` in `greeting.tsx`: the sentence the bubble last typed in this tab. */
const GREETING_KEY = "ready.greeting.typed";

let playedInMemory: string | null = null;

function lastPlayed(): string | null {
  try {
    return window.sessionStorage.getItem(PLAYED_KEY) ?? playedInMemory;
  } catch {
    return playedInMemory;
  }
}

function rememberPlayed(id: string): void {
  playedInMemory = id;
  try {
    window.sessionStorage.setItem(PLAYED_KEY, id);
  } catch {
    // Storage blocked: the module variable covers this page load.
  }
}

function lastGreeting(): string | null {
  try {
    return window.sessionStorage.getItem(GREETING_KEY);
  } catch {
    return null;
  }
}

/** "rest" is the after state with nothing left to play (also every ordinary visit). */
type Step = "before" | "out" | "after" | "said" | "rest";
type Plan = { id: string; calm: boolean; greeting: string | null };

/** Decided while rendering, so the first paint is already the before state. Reads only. */
function planFor(id: string): Plan | null {
  applyFast();
  if (isFast() || lastPlayed() === id) return null;
  const calm = typeof window.matchMedia === "function" && window.matchMedia(REDUCE).matches;
  return { id, calm, greeting: calm ? null : lastGreeting() };
}

type Stage = {
  /** The page was sent with `play` at least once: parts render their Motion elements. */
  armed: boolean;
  /** Showing the before state. */
  before: boolean;
  /** The handed-in card is on its way out. */
  leaving: boolean;
  /** How the after state comes in. */
  enter: "none" | "full" | "calm";
  /** The greeting to show instead of the new one, while it has not been said yet. */
  greeting: string | null;
  /** Changes when the layout is about to change: Motion measures then. */
  shift: number;
};

const REST: Stage = { armed: false, before: false, leaving: false, enter: "none", greeting: null, shift: 0 };
const StageContext = createContext<Stage>(REST);

const noSubscribe = () => () => {};
/** False while hydrating server markup, true for anything rendered in the browser. */
function useInBrowser(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}

export type HandedInProps = {
  /** She handed in a moment ago, in this visit (the hand-in flash). */
  play?: boolean;
  /** Names this hand-in, so it plays once: the assignment id and when it was handed in. */
  id?: string;
  children: ReactNode;
};

export function HandedIn({ play = false, id = "", children }: HandedInProps) {
  const inBrowser = useInBrowser();
  const key = inBrowser && play && id ? id : null;

  const [armed, setArmed] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [step, setStep] = useState<Step>("rest");

  // Adjust state while rendering when a new hand-in arrives (no effect, so
  // the greeting and the cards never show the after state first).
  if (key !== seen) {
    const next = key ? planFor(key) : null;
    setSeen(key);
    setPlan(next);
    setStep(!next ? "rest" : next.calm ? "said" : "before");
    if (key && !armed) setArmed(true);
  }

  useLayoutEffect(() => {
    if (!plan) return;
    const timers: number[] = [];
    const at = (ms: number, run: () => void) => timers.push(window.setTimeout(run, ms));
    if (lastPlayed() === plan.id) {
      // Played to the swap already (Home was hidden and is shown again): nothing comes in twice.
      at(0, () => setStep("rest"));
    } else if (plan.calm) {
      at(calmDurationMs + 50, () => {
        rememberPlayed(plan.id);
        setStep("rest");
      });
    } else {
      at(HOLD_MS, () => setStep("out"));
      at(HOLD_MS + OUT_MS, () => {
        rememberPlayed(plan.id);
        setStep("after");
      });
      at(HOLD_MS + OUT_MS + GREET_AFTER_MS, () => setStep("said"));
      at(HOLD_MS + OUT_MS + SETTLE_MS, () => setStep("rest"));
    }
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      // Cut short before the swap (Home hidden, or React's double run in
      // development): start again from the before state next time.
      if (!plan.calm && lastPlayed() !== plan.id) setStep("before");
    };
  }, [plan]);

  const stage = useMemo<Stage>(() => {
    if (!plan) return armed ? { ...REST, armed } : REST;
    const before = step === "before" || step === "out";
    return {
      armed: true,
      before,
      leaving: step === "out",
      // At rest nothing comes in again when Home is hidden and shown (Next keeps the page).
      enter: step === "rest" ? "none" : plan.calm ? "calm" : "full",
      greeting: before || step === "after" ? plan.greeting : null,
      shift: plan.calm || before ? 0 : step === "after" ? 1 : 2,
    };
  }, [armed, plan, step]);

  return <StageContext.Provider value={stage}>{children}</StageContext.Provider>;
}

const OUT = { duration: OUT_MS / 1000, ease: ease.out };
const SLIDE = { layout: { duration: SLIDE_MS / 1000, ease: ease.inout } };
const EASE_OUT = `cubic-bezier(${ease.out.join(",")})`;

export type SwapProps = {
  /** The card she handed in, as it stood in Do first. */
  before: ReactNode;
  /** Its done row. */
  done: ReactNode;
  /** What is in Do first now, under the done row. */
  children?: ReactNode;
};

/** Do first: the handed-in card leaves, its done row and the next item take its place. */
export function Swap({ before, done, children }: SwapProps) {
  const stage = useContext(StageContext);
  if (!stage.armed) {
    return (
      <>
        {done}
        {children}
      </>
    );
  }
  if (stage.before) {
    return (
      // Not hers to tap any more: it is leaving.
      <motion.div
        key="before"
        inert
        data-handed-in="before"
        initial={false}
        animate={stage.leaving ? { opacity: 0, scale: 0.96 } : { opacity: 1, scale: 1 }}
        transition={OUT}
      >
        {before}
      </motion.div>
    );
  }
  return (
    <>
      <Enter part="done" y={-4} ms={DONE_IN_MS}>
        {done}
      </Enter>
      {children != null && children !== false && (
        <Enter part="next" y={8} ms={RISE_MS}>
          {children}
        </Enter>
      )}
    </>
  );
}

/**
 * A part of the after state coming in: from `y` px away and clear, or (calm) a
 * plain fade. A plain element animated once in place; Next keeps Home mounted
 * while she is on another page, and nothing here plays again when it is shown.
 */
function Enter({ part, y, ms, children }: { part: string; y: number; ms: number; children: ReactNode }) {
  const { enter } = useContext(StageContext);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (enter === "none" || !el || typeof el.animate !== "function") return;
    const anim =
      enter === "full"
        ? el.animate(
            [
              { opacity: 0, transform: `translateY(${y}px)` },
              { opacity: 1, transform: "translateY(0px)" },
            ],
            { duration: ms, easing: EASE_OUT },
          )
        : el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: calmDurationMs, easing: "linear" });
    return () => anim.cancel();
  }, [enter, y, ms]);
  return (
    <div ref={ref} data-handed-in={part}>
      {children}
    </div>
  );
}

export type SlideProps = {
  as?: "div" | "section";
  className?: string;
  style?: CSSProperties;
  "aria-labelledby"?: string;
  /** `Arrive`'s mark, passed through. */
  "data-arrive-part"?: string;
  children?: ReactNode;
};

/** A part of Home that slides to its new place when what is above it changes height. */
export function Slide({ as = "div", children, ...rest }: SlideProps) {
  const stage = useContext(StageContext);
  if (!stage.armed) {
    const Tag = as;
    return <Tag {...rest}>{children}</Tag>;
  }
  const Tag = as === "section" ? motion.section : motion.div;
  return (
    <Tag {...rest} layout="position" layoutDependency={stage.shift} transition={SLIDE}>
      {children}
    </Tag>
  );
}

/** Shown only in the before state (what the hand-in removes). */
export function BeforeOnly({ children }: { children: ReactNode }) {
  return useContext(StageContext).before ? children : null;
}

/** Hidden in the before state (what the hand-in brings). */
export function AfterOnly({ children }: { children: ReactNode }) {
  return useContext(StageContext).before ? null : children;
}

/** A queue number: one higher in the before state, rolling down to `n`. */
export function QueueNumber({ n }: { n: number }) {
  const stage = useContext(StageContext);
  if (!stage.armed) return n;
  return <RollingNumber value={stage.before ? n + 1 : n} />;
}

/** The greeting: the sentence she last saw until the swap, then the new one, typed. */
export function HandedInGreeting({ sentence, className }: { sentence: string; className?: string }) {
  const stage = useContext(StageContext);
  return <Greeting sentence={stage.greeting ?? sentence} className={className} />;
}
