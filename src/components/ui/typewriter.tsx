"use client";

/**
 * The typewriter. Source: prototype main-flow.html JS 4352-4416 (typeMsg).
 *
 * A message is a timeline of units: each character of a paragraph is one
 * unit, and each block that fades in (a list item, a table row, a source
 * line) is one unit. planTimeline() gives every unit the moment it shows:
 *
 * - 14 to 22 ms a character, 0.65x in the middle of long words (7+ letters),
 * - +110 ms after , : ; and +240 ms after . ? ! …,
 * - +240 ms after a paragraph that does not end a sentence,
 * - faded blocks 110 ms apart, +120 ms after a group of them.
 *
 * capTimeline() scales the whole timeline down so the message never takes
 * more than 2.4 s. useReveal() plays it: tap to finish, instant when calm.
 *
 * Streamed text: pass the text that has arrived and `complete={false}`. Only
 * what has arrived is typed; the clock stops while the typewriter waits for
 * more, so waiting on the network is not counted against the 2.4 s.
 *
 *   <Typewriter text={reply} complete={doneStreaming} onDone={...} />
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCalm } from "@/lib/motion/use-calm";

/** The whole message is typed within this many ms. */
export const TYPE_CAP_MS = 2400;
/** Faded blocks (list items, table rows, source lines) come this far apart. */
export const REVEAL_GAP_MS = 110;
const REVEAL_TAIL_MS = 120;
const CLAUSE_PAUSE_MS = 110;
const SENTENCE_PAUSE_MS = 240;
const SENTENCE_END = /[.?!…]$/;

/**
 * A steady 0..1 "random" number per unit. The prototype used Math.random();
 * a fixed sequence keeps server and client renders and tests the same.
 */
export function jitter(i: number): number {
  const x = Math.sin((i + 1) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** How long to wait after showing character `i` of `text`. */
export function charDelay(text: string, i: number, rand: number = jitter(i)): number {
  const ch = text.charAt(i);
  let d = 14 + rand * 8;
  let s = i;
  while (s > 0 && /\S/.test(text.charAt(s - 1))) s--;
  let e = i;
  while (e < text.length - 1 && /\S/.test(text.charAt(e + 1))) e++;
  const len = e - s + 1;
  const pos = i - s;
  if (len >= 7 && pos >= 2 && pos <= len - 3) d *= 0.65;
  if (ch === "," || ch === ":" || ch === ";") d += CLAUSE_PAUSE_MS;
  else if (ch === "." || ch === "?" || ch === "!" || ch === "…") d += SENTENCE_PAUSE_MS;
  return d;
}

export type TimelineStep =
  | { kind: "text"; text: string }
  | { kind: "reveal"; count: number };

export type Timeline = {
  /** When each unit shows, in ms from the start, before the cap. */
  at: number[];
  /** When the message is over, before the cap. */
  total: number;
};

/** Natural timing for a message, unit by unit, in order. */
export function planTimeline(steps: readonly TimelineStep[]): Timeline {
  const at: number[] = [];
  let t = 0;
  for (const step of steps) {
    if (step.kind === "text") {
      if (!step.text) continue;
      for (let i = 0; i < step.text.length; i++) {
        at.push(t);
        t += charDelay(step.text, i, jitter(at.length - 1));
      }
      if (!SENTENCE_END.test(step.text)) t += SENTENCE_PAUSE_MS;
    } else if (step.count > 0) {
      for (let i = 0; i < step.count; i++) {
        at.push(t);
        t += REVEAL_GAP_MS;
      }
      t += REVEAL_TAIL_MS;
    }
  }
  return { at, total: t };
}

/** Scales a timeline down so it ends within `cap` ms. Never slows it down. */
export function capTimeline({ at, total }: Timeline, cap: number = TYPE_CAP_MS): number[] {
  const k = total > cap ? cap / total : 1;
  return at.map((a) => a * k);
}

export type RevealOptions = {
  /** False while more text is still streaming in. Default true. */
  complete?: boolean;
  /** Show everything at once (for example a message from history). */
  instant?: boolean;
  /** Called once, when every unit is shown and the text is complete. */
  onDone?: () => void;
};

export type RevealState = {
  /** How many units are shown. */
  shown: number;
  /** Every unit is shown and nothing more is coming. */
  finished: boolean;
  /** Tap to finish: shows everything now, and anything that streams in later. */
  finish: () => void;
  /** Everything shows at once (calm, instant, or tapped): skip fades too. */
  immediate: boolean;
};

/**
 * Plays a capped timeline (from capTimeline). `at` may grow while streaming;
 * it should keep its old values for units already planned.
 */
export function useReveal(at: readonly number[], options: RevealOptions = {}): RevealState {
  const { complete = true, instant = false, onDone } = options;
  const calm = useCalm();
  const [count, setCount] = useState(0);
  const [skipped, setSkipped] = useState(false);
  const now = calm || instant || skipped;

  // The typing clock, in ms. It only runs while there is something to type.
  const clock = useRef(0);
  const lastTick = useRef<number | null>(null);
  const shownRef = useRef(0);

  useEffect(() => {
    if (now) {
      shownRef.current = at.length;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    lastTick.current = Date.now();

    const tick = () => {
      timer = null;
      const t = Date.now();
      if (lastTick.current !== null) clock.current += t - lastTick.current;
      lastTick.current = t;
      let n = Math.min(shownRef.current, at.length);
      while (n < at.length && at[n] <= clock.current) n++;
      shownRef.current = n;
      setCount(n);
      if (n >= at.length) {
        // Caught up: stop the clock until more text arrives.
        lastTick.current = null;
        return;
      }
      timer = setTimeout(tick, Math.max(8, at[n] - clock.current));
    };
    timer = setTimeout(tick, 0);

    return () => {
      if (timer !== null) clearTimeout(timer);
      if (lastTick.current !== null) clock.current += Date.now() - lastTick.current;
      lastTick.current = null;
    };
  }, [at, now]);

  const shown = now ? at.length : Math.min(count, at.length);
  const finished = complete && shown >= at.length;

  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });
  const doneCalled = useRef(false);
  useEffect(() => {
    if (!finished || doneCalled.current) return;
    doneCalled.current = true;
    onDoneRef.current?.();
  }, [finished]);

  const finish = useCallback(() => setSkipped(true), []);

  return { shown, finished, finish, immediate: now };
}

/** The typing caret. Decoration only. */
export function Caret() {
  return (
    <span
      aria-hidden="true"
      className="-mr-[1.5px] inline-block h-[1.1em] w-0 border-l-[1.5px] border-ink align-[-0.18em]"
    />
  );
}

export type TypewriterProps = {
  text: string;
  /** False while more text is still streaming in. Default true. */
  complete?: boolean;
  /** Show the text at once, no typing. */
  instant?: boolean;
  onDone?: () => void;
  className?: string;
};

/**
 * Types one piece of plain text. The untyped rest is laid out but invisible,
 * so lines do not jump while typing. Tap it to finish.
 */
export function Typewriter({ text, complete = true, instant, onDone, className }: TypewriterProps) {
  const at = useMemo(() => capTimeline(planTimeline([{ kind: "text", text }])), [text]);
  const { shown, finished, finish } = useReveal(at, { complete, instant, onDone });
  return (
    <span className={className} onClick={finished ? undefined : finish} aria-busy={!finished}>
      <span>{text.slice(0, shown)}</span>
      {!finished && <Caret />}
      <span className="invisible">{text.slice(shown)}</span>
    </span>
  );
}
