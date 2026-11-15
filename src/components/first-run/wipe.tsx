"use client";

/**
 * The end of first run (M5-11): confetti, the wipe, and the way to Home.
 * Source: prototype main-flow.html JS 2408-2456 (wipeIn, finishSort,
 * skipSort) and CSS 327-329 (.wipe, .wipe-text, .confetti).
 *
 * `Wipe` (plain props, no fetching) takes over when the sorting scene hands
 * over its hat: confetti bursts from the hat tip; after the script's confetti
 * hold (900 ms) the hat flies off and a blush circle grows from it to cover
 * the screen (520 ms) with "Just kidding."; after the wipe hold (700 ms) the
 * line becomes "Here's your study OS, all set up."; after the last hold
 * `onDone` fires. The blush stays on screen across the move to Home and fades
 * (280 ms) once Home is there, so Home builds itself under it.
 *
 * Where clip-path circles are not supported, or when calm, the wipe fades in
 * instead (calm: 150 ms, no hat flight, no confetti). The test switch
 * (instant): no waits, `onDone` at once.
 *
 * `SortingFlow` is the route's glue for /sorting: it starts (or continues)
 * the first sync, polls its progress once a second, plays the sorting scene,
 * then the wipe, then goes to /home?arrive=1. Skip goes there at once; the
 * sync keeps running on the server. If the sync fails or stops moving, it
 * says "<LMS> is slow right now. Your courses will appear on Home." and
 * carries on.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Sorting,
  syncDone,
  type SortingCourse,
  type SortingHandOff,
  type SortingProgress,
} from "@/components/first-run/sorting";
import { burst } from "@/components/ui/confetti";
import { calmDurationMs, durationMs, ease } from "@/lib/motion/tokens";
import { useMotionMode, type MotionMode } from "@/lib/motion/use-calm";
import type { SchoolId } from "@/lib/schools";
import { sortingScript, type SortingStep } from "@/lib/sorting/script";

/** Where first run ends: Home, building itself (M4-11). */
export const HOME_ARRIVE = "/home?arrive=1";
export const WIPE_FIRST_LINE = "Just kidding.";

const E_OUT = `cubic-bezier(${ease.out.join(", ")})`;
const E_IO = `cubic-bezier(${ease.inout.join(", ")})`;
const HAT_FLY_MS = 420;
const TEXT_DELAY_MS = 300;

/** How long a step of `kind` holds, from the script; 0 when the script has none. */
function holdMs(steps: readonly SortingStep[], kind: SortingStep["kind"]): number {
  return steps.find((s) => s.kind === kind)?.ms ?? 0;
}

function lastLine(steps: readonly SortingStep[]): string {
  const step = steps.find((s) => s.kind === "wipeText");
  return step && step.kind === "wipeText" ? step.text : "";
}

/** Whether the circle reveal can run here. */
function clipOk(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function"
    ? CSS.supports("clip-path", "circle(1px at 1px 1px)")
    : false;
}

/** el.animate, resolved when it ends (or at once where WAAPI is missing). */
function play(el: Element | null, frames: Keyframe[], opts: KeyframeAnimationOptions): Promise<void> {
  if (!el || typeof (el as HTMLElement).animate !== "function") return Promise.resolve();
  try {
    const a = (el as HTMLElement).animate(frames, opts);
    return a.finished.then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}

/**
 * Keeps a copy of the covering wipe on top while the router moves to Home,
 * then fades it once Home is on screen. Gives up (and removes it) after 6 s.
 */
function holdAcrossNavigation(el: HTMLElement, fadeMs: number, path: string): void {
  const copy = el.cloneNode(true) as HTMLElement;
  copy.removeAttribute("id");
  copy.setAttribute("aria-hidden", "true");
  copy.style.clipPath = "none";
  copy.style.opacity = "1";
  copy.style.pointerEvents = "none";
  document.body.appendChild(copy);
  const started = performance.now();
  const target = path.split("?")[0];
  const fade = () => {
    play(copy, [{ opacity: 1 }, { opacity: 0 }], { duration: fadeMs, easing: "linear", fill: "forwards" }).then(
      () => copy.remove(),
    );
  };
  const check = () => {
    if (!copy.isConnected) return;
    if (window.location.pathname === target) {
      // Home is laid out under the wipe before it fades (two frames).
      requestAnimationFrame(() => requestAnimationFrame(fade));
    } else if (performance.now() - started > 6000) {
      copy.remove();
    } else {
      requestAnimationFrame(check);
    }
  };
  requestAnimationFrame(check);
}

export type WipeProps = {
  /** The hat and its tip from the sorting scene; null until the scene is done. */
  from: SortingHandOff | null;
  /** The sorting script's steps: the confetti, wipe and wipeText holds and the last line. */
  steps: readonly SortingStep[];
  /** Where to go when it is over; the wipe stays up until that page is on screen. */
  to: string;
  /** The wipe has covered the screen and shown its last line. */
  onDone: () => void;
  /** Force a motion mode (preview pages); defaults to the user's. */
  mode?: MotionMode;
};

export function Wipe({ from, steps, to, onDone, mode: forcedMode }: WipeProps) {
  const userMode = useMotionMode();
  const mode = forcedMode ?? userMode;
  const ref = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLParagraphElement>(null);
  const [shown, setShown] = useState(false);
  const [text, setText] = useState(WIPE_FIRST_LINE);

  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    if (!from) return;
    let alive = true;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const wait = (ms: number) =>
      new Promise<void>((res) => {
        if (ms <= 0) return res();
        const t = setTimeout(() => {
          timers.delete(t);
          res();
        }, ms);
        timers.add(t);
      });

    if (mode === "instant") {
      onDoneRef.current();
      return;
    }
    const calm = mode === "calm";
    const fadeMs = calm ? calmDurationMs : durationMs.base;

    (async () => {
      // Confetti from the hat tip (burst does nothing when calm).
      if (!calm) burst(from.hatTip);
      await wait(holdMs(steps, "confetti"));
      if (!alive) return;

      const el = ref.current;
      if (!el) return;
      const hatRect = from.hat?.getBoundingClientRect();
      const circle = !calm && clipOk() && Boolean(hatRect);
      const x = hatRect ? hatRect.left + hatRect.width / 2 : 0;
      const y = hatRect ? hatRect.top + hatRect.height / 2 : 0;
      // Start closed (or clear) before it is shown, so it never flashes full.
      if (circle) el.style.clipPath = `circle(0px at ${x}px ${y}px)`;
      else el.style.opacity = "0";
      setShown(true);
      // Let React show the wipe before animating it.
      await new Promise<void>((res) => requestAnimationFrame(() => res()));
      if (!alive) return;

      if (!calm) {
        play(
          from.hat,
          [
            { opacity: 1, transform: "translateY(0px) rotate(0deg)" },
            { opacity: 0, transform: "translateY(-24px) rotate(20deg)" },
          ],
          { duration: HAT_FLY_MS, easing: E_OUT, fill: "forwards" },
        );
      }

      if (!circle) {
        await play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: fadeMs, easing: "linear", fill: "forwards" });
        el.style.opacity = "1";
      } else {
        const w = window.innerWidth;
        const h = window.innerHeight;
        const r = Math.ceil(Math.hypot(Math.max(x, w - x), Math.max(y, h - y))) + 4;
        play(
          textRef.current,
          [
            { opacity: 0, transform: "translateY(8px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: durationMs.base, delay: TEXT_DELAY_MS, easing: E_OUT, fill: "backwards" },
        );
        await play(
          el,
          [{ clipPath: `circle(0px at ${x}px ${y}px)` }, { clipPath: `circle(${r}px at ${x}px ${y}px)` }],
          { duration: durationMs.slow, easing: E_IO, fill: "forwards" },
        );
        el.style.clipPath = "none";
      }
      if (!alive) return;
      document.querySelectorAll("canvas[data-confetti]").forEach((c) => c.remove());

      await wait(holdMs(steps, "wipe"));
      if (!alive) return;
      const last = lastLine(steps);
      if (last) {
        setText(last);
        play(textRef.current, [{ opacity: 0 }, { opacity: 1 }], {
          duration: calm ? calmDurationMs : durationMs.quick,
          easing: "linear",
        });
      }
      await wait(holdMs(steps, "wipeText"));
      if (!alive) return;
      if (ref.current) holdAcrossNavigation(ref.current, fadeMs, to);
      onDoneRef.current();
    })();

    return () => {
      alive = false;
      timers.forEach(clearTimeout);
    };
  }, [from, steps, to, mode]);

  return (
    <div
      ref={ref}
      hidden={!shown}
      className="fixed inset-0 z-[45] grid place-items-center bg-accent-wash px-[var(--pad)] text-ink"
      data-wipe=""
    >
      <p
        ref={textRef}
        role="status"
        className="max-w-[16ch] text-center font-display text-[30px] font-semibold leading-[1.15] tracking-[-0.01em] [font-variation-settings:'SOFT'_100] [text-wrap:balance]"
      >
        {text}
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* The /sorting route's glue.                                               */
/* ----------------------------------------------------------------------- */

const POLL_MS = 1000;
/** No change in what the sync reports for this long: ask the server to continue it once. */
const STALL_NUDGE_MS = 30_000;
/** Still no change this long after that: give up waiting and go on. */
const STALL_GIVE_UP_MS = 30_000;
/** Never wait longer than this for the first sync (its own budget is 150 s plus files). */
const MAX_WAIT_MS = 180_000;
/** This many failed polls in a row is a failed sync. */
const MAX_ERRORS = 4;

const CHIP_COLOURS = ["var(--confetti-1)", "var(--confetti-3)", "var(--confetti-4)", "var(--confetti-5)", "var(--confetti-2)"];

type Reported = { stage: string; courses: string[]; files: number; dates: number };

function isReported(v: unknown): v is Reported {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.stage === "string" && Array.isArray(o.courses);
}

function toProgress(r: Reported): SortingProgress {
  const courses: SortingCourse[] = r.courses
    .filter((n): n is string => typeof n === "string")
    .map((name, i) => ({ name, color: CHIP_COLOURS[i % CHIP_COLOURS.length] }));
  const stage = r.stage;
  return {
    courses,
    files: Number(r.files) || 0,
    dates: Number(r.dates) || 0,
    done: stage === "done",
    stage,
  };
}

const START: SortingProgress = { courses: [], files: 0, dates: 0, done: false, stage: "courses" };

export type SortingFlowProps = {
  /** What her school calls its Moodle, from lmsNameOf(user). */
  lmsName: string;
  school: SchoolId;
  /** Her programme (guessProgramme), or null. */
  programme: string | null;
};

export function SortingFlow({ lmsName, school, programme }: SortingFlowProps) {
  const router = useRouter();
  const mode = useMotionMode();
  const calm = mode !== "full";
  const steps = useMemo(() => sortingScript({ school, programme, calm }).steps, [school, programme, calm]);

  const [progress, setProgress] = useState<SortingProgress>(START);
  const [slow, setSlow] = useState(false);
  const [handOff, setHandOff] = useState<SortingHandOff | null>(null);
  const left = useRef(false);

  const go = useCallback(() => {
    if (left.current) return;
    left.current = true;
    router.replace(HOME_ARRIVE);
  }, [router]);

  // Start (or continue) the first sync, then poll it once a second.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    let lastKey = "";
    let lastChange = Date.now();
    let nudged = false;
    let errors = 0;

    const giveUp = () => {
      if (!alive) return;
      alive = false;
      setSlow(true);
      // Let the scene finish: the courses will appear on Home.
      setProgress((p) => ({ ...p, done: true }));
    };

    const take = (body: unknown): boolean => {
      if (!isReported(body)) return false;
      const key = `${body.stage}|${body.courses.length}|${body.files}|${body.dates}`;
      if (key !== lastKey) {
        lastKey = key;
        lastChange = Date.now();
      }
      const p = toProgress(body);
      setProgress(p);
      return syncDone(p);
    };

    const request = async (method: "GET" | "POST"): Promise<boolean> => {
      try {
        const res = await fetch("/api/sync/progress", { method, cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        errors = 0;
        return take(await res.json());
      } catch {
        errors++;
        return false;
      }
    };

    const tick = async () => {
      if (!alive) return;
      const done = await request("GET");
      if (!alive || done) return;
      const now = Date.now();
      if (errors >= MAX_ERRORS || now - startedAt > MAX_WAIT_MS) return giveUp();
      if (now - lastChange > STALL_NUDGE_MS) {
        if (nudged && now - lastChange > STALL_NUDGE_MS + STALL_GIVE_UP_MS) return giveUp();
        if (!nudged) {
          nudged = true;
          await request("POST");
          if (!alive) return;
        }
      }
      timer = setTimeout(tick, POLL_MS);
    };

    (async () => {
      const done = await request("POST");
      if (!alive || done) return;
      timer = setTimeout(tick, POLL_MS);
    })();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <>
      <Sorting
        lmsName={lmsName}
        school={school}
        programme={programme}
        progress={progress}
        onSkip={go}
        onDone={setHandOff}
      />
      {slow && (
        <p
          role="status"
          className="fixed inset-x-0 bottom-6 z-[46] mx-auto max-w-[440px] px-[var(--pad)] text-center text-[15px] text-ink-2"
        >
          {lmsName} is slow right now. Your courses will appear on Home.
        </p>
      )}
      <Wipe from={handOff} steps={steps} to={HOME_ARRIVE} onDone={go} />
    </>
  );
}
