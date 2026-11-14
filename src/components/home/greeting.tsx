"use client";

/**
 * The Home greeting: Vitonen in a blush circle and a speech bubble with a
 * tail. Source: prototype main-flow.html HTML 1424-1427, CSS 275-278 and
 * 427-429 (.bubble.tail-left, .greet, .greet-cap, .greet-bubble), JS 4066-4073
 * (spring-in on the first greeting) and 2029-2040 (eyes look toward the
 * pointer's half of the screen).
 *
 *   <Greeting sentence="Hi Valeria. One thing is due tonight." />
 *
 * - The first time a sentence is shown in a visit, the bubble springs in and
 *   the sentence types. Shown again (Home re-entered, a reload in the same
 *   tab), it is plain text. A new sentence types again, without the spring.
 *   "Visit" is the browser tab session: the last typed sentence sits in
 *   sessionStorage, so coming back to Home does not repeat the typing, and
 *   a new tab greets afresh. If storage is blocked, a module variable keeps
 *   it for this page load.
 * - Wide screens with a fine pointer (same 700 px breakpoint as the
 *   prototype's WIDE): the cap's eyes shift 4 px toward the pointer's half.
 *   The offset is on the root as data-look ("-4", "0", "4").
 * - Calm (reduced motion or ?fast=1): no spring, no typing, no eye motion.
 */
import { motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Typewriter } from "@/components/ui/typewriter";
import { Vitonen } from "@/components/vitonen";
import { useCalm } from "@/lib/motion/use-calm";

/** Where the eyes may follow the pointer. Prototype: WIDE is min-width 700px. */
export const LOOK_QUERY = "(hover: hover) and (pointer: fine) and (min-width: 700px)";
/** How far the eyes shift, in px. */
export const LOOK_PX = 4;

const STORE_KEY = "ready.greeting.typed";
let typedInMemory: string | null = null;

function lastTyped(): string | null {
  try {
    return window.sessionStorage.getItem(STORE_KEY) ?? typedInMemory;
  } catch {
    return typedInMemory;
  }
}

function rememberTyped(sentence: string): void {
  typedInMemory = sentence;
  try {
    window.sessionStorage.setItem(STORE_KEY, sentence);
  } catch {
    // Storage blocked: the module variable covers this page load.
  }
}

/** Pure: which way the eyes look for a pointer at x on a screen this wide. */
export function lookFor(x: number, width: number): number {
  return x < width / 2 ? -LOOK_PX : LOOK_PX;
}

function subscribeLook(onChange: () => void): () => void {
  const media = window.matchMedia(LOOK_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function useCanLook(): boolean {
  return useSyncExternalStore(
    subscribeLook,
    () => window.matchMedia(LOOK_QUERY).matches,
    () => false,
  );
}

/** Eye offset in px: follows the pointer while `enabled`, else 0. */
function useLook(enabled: boolean): number {
  const [look, setLook] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let x = 0;
    const onMove = (e: PointerEvent) => {
      x = e.clientX;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setLook(lookFor(x, window.innerWidth));
      });
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      document.removeEventListener("pointermove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [enabled]);
  return enabled ? look : 0;
}

type Plan = { sentence: string; type: boolean; spring: boolean };

const SPRING = { type: "spring", bounce: 0.3, visualDuration: 0.4 } as const;
const HIDDEN = { opacity: 0, scale: 0.6 };
const SHOWN = { opacity: 1, scale: 1 };

export type GreetingProps = {
  /** The sentence Vitonen says (built by the Home greeting rules). */
  sentence: string;
  className?: string;
};

export function Greeting({ sentence, className = "" }: GreetingProps) {
  const calm = useCalm();
  const canLook = useCanLook();
  const look = useLook(canLook && !calm);

  // Decided once per sentence, before paint. The ref keeps the decision
  // stable when effects run twice (React strict mode in development).
  const decided = useRef<Plan | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [doneTyping, setDoneTyping] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (decided.current?.sentence !== sentence) {
      const first = decided.current === null;
      const type = lastTyped() !== sentence;
      if (type) rememberTyped(sentence);
      decided.current = { sentence, type, spring: first && type };
    }
    setPlan(decided.current);
  }, [sentence]);

  const typing = plan !== null && plan.type && !calm && doneTyping !== plan.sentence;

  return (
    <div className={`mt-[14px] flex items-end gap-3 ${className}`.trim()} data-look={look}>
      <span
        className="grid size-[60px] flex-none place-items-center rounded-full bg-accent-wash"
        style={{ "--look": `${look}px` } as CSSProperties}
      >
        <Vitonen size={44} state={typing ? "talking" : "idle"} />
      </span>
      <motion.div
        className={[
          "relative mb-[10px] flex-1 origin-bottom-left rounded-[20px] border border-line bg-surface px-4 py-3 text-[15px] text-ink shadow-[var(--shadow-card)]",
          // The tail, pointing left at the cap (.bubble.tail-left::after).
          "after:absolute after:bottom-4 after:-left-[7px] after:size-3 after:rotate-[135deg] after:border-r after:border-b after:border-line after:bg-surface after:content-['']",
        ].join(" ")}
        initial={false}
        animate={plan ? SHOWN : HIDDEN}
        transition={plan?.spring && !calm ? SPRING : { duration: 0 }}
        aria-live="polite"
        data-testid="greeting-bubble"
      >
        <p>
          <span className="sr-only">{sentence}</span>
          <span aria-hidden="true" data-testid="greeting-text">
            {plan ? (
              <Typewriter
                key={plan.sentence}
                text={plan.sentence}
                instant={!plan.type}
                onDone={() => setDoneTyping(plan.sentence)}
              />
            ) : (
              <span className="invisible">{sentence}</span>
            )}
          </span>
        </p>
      </motion.div>
    </div>
  );
}
