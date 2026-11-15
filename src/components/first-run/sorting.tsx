"use client";

/**
 * The sorting scene (M5-10). Source: prototype main-flow.html HTML 1346-1375,
 * CSS 293-330, JS 2291-2407 (startSort).
 *
 * Walks the script from src/lib/sorting/script.ts: the hat types each line in
 * the bubble, thinks between lines, the house word flickers and lands, then the
 * last line. Under it, "PULLING FROM <LMS>" with a chip per course that has
 * arrived and a counter that ticks up to the real file and date numbers.
 *
 * The scene stops at the script's "confetti" step: M5-11 owns the confetti,
 * the wipe and the route. `onDone` fires once the script has got there, the
 * sync says done, and `minimumMs` has passed since mount; it hands over the
 * hat and the hat tip so M5-11 can burst confetti from it and fly it off.
 *
 * Calm (reduced motion): lines appear whole, no flicker, no hat drop, sway or
 * talking; holds are the script's calm ones, so the scene is shorter.
 * Instant (the test switch): no waits at all.
 *
 * Plain props, no fetching: the M5-07 progress endpoint feeds `progress`.
 */
import "./sorting.css";
import { animate } from "motion/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { capTimeline, planTimeline, Typewriter } from "@/components/ui/typewriter";
import { ease } from "@/lib/motion/tokens";
import { useMotionMode, type MotionMode } from "@/lib/motion/use-calm";
import type { SchoolId } from "@/lib/schools";
import { sortingScript, type SortingStep } from "@/lib/sorting/script";

export type SortingCourse = { name: string; color: string };

export type SortingProgress = {
  /** Courses that have arrived so far, in the order they arrived. */
  courses: readonly SortingCourse[];
  files: number;
  dates: number;
  /** The first sync has finished. */
  done: boolean;
  /**
   * The sync's stage, as M5-07 reports it ("courses", "assignments", "dates",
   * "grades", "files", "done"). Only "done" changes anything (same as `done`);
   * every other value, known or not, is shown as-is on data-stage and ignored.
   */
  stage?: string;
};

/** The sync is over: `done`, or a stage of "done". Never throws on odd stages. */
export function syncDone(p: SortingProgress): boolean {
  return p.done || p.stage === "done";
}

export type SortingHandOff = {
  /** The hat's slot (what flies off). */
  hat: HTMLDivElement | null;
  /** The hat's tip (where confetti bursts from). */
  hatTip: SVGGElement | null;
};

export type SortingProps = {
  /** What her school calls its Moodle, from lmsNameOf(user). */
  lmsName: string;
  school: SchoolId;
  /** Her programme (guessProgramme), or null to skip that line. */
  programme: string | null;
  progress: SortingProgress;
  onSkip: () => void;
  /** Script reached its end, sync is done and the minimum time has passed. */
  onDone: (handOff: SortingHandOff) => void;
  /** Force a motion mode (preview pages); defaults to the user's. */
  mode?: MotionMode;
};

/** The steps this component plays: everything before the confetti. */
function playedSteps(steps: readonly SortingStep[]): SortingStep[] {
  const end = steps.findIndex((s) => s.kind === "confetti");
  return end < 0 ? [...steps] : steps.slice(0, end);
}

/** How long the typewriter takes to show a line (it calls onDone at the last character). */
function typingMs(text: string): number {
  const at = capTimeline(planTimeline([{ kind: "text", text }]));
  return at.length ? at[at.length - 1] : 0;
}

/** Expected length of the played part, in ms, for the progress line. */
export function sceneLengthMs(steps: readonly SortingStep[], calm: boolean): number {
  return steps.reduce(
    (sum, s) => sum + s.ms + (s.kind === "say" && !calm ? typingMs(s.text) : 0),
    0,
  );
}

const CHIP_FIRST_MS = { full: 1000, calm: 300 };
const CHIP_GAP_MS = { full: 1100, calm: 150 };
const COUNT_DELAY_MS = 800;
const COUNT_TWEEN_MS = { full: 1400, calm: 400 };

function CheckIcon({ color }: { color: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ color }}
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function Chip({ course, calm }: { course: SortingCourse; calm: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const controls = calm
      ? animate(el, { opacity: [0, 1] }, { duration: 0.15 })
      : animate(
          el,
          { opacity: [0, 1], scale: [0.8, 1] },
          { type: "spring", bounce: 0.25, duration: 0.25 },
        );
    return () => controls.stop();
  }, [calm]);
  return (
    <li ref={ref} className="tchip">
      <CheckIcon color={course.color || "var(--accent)"} />
      <span className="tchip-name">{course.name}</span>
    </li>
  );
}

export function Sorting({
  lmsName,
  school,
  programme,
  progress,
  onSkip,
  onDone,
  mode: forcedMode,
}: SortingProps) {
  const userMode = useMotionMode();
  const mode = forcedMode ?? userMode;
  const calm = mode !== "full";
  const instant = mode === "instant";
  const pace = calm ? "calm" : "full";

  const script = useMemo(() => sortingScript({ school, programme, calm }), [school, programme, calm]);
  const steps = useMemo(() => playedSteps(script.steps), [script]);
  const lengthMs = instant ? 0 : sceneLengthMs(steps, calm);

  const [line, setLine] = useState<{ text: string; key: number } | null>(null);
  const [spoken, setSpoken] = useState("");
  const [house, setHouse] = useState("");
  const [talking, setTalking] = useState(false);
  const [thinking, setThinking] = useState(false);

  const clipId = `bust-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const hatSlotRef = useRef<HTMLDivElement>(null);
  const hatTipRef = useRef<SVGGElement>(null);
  const houseRef = useRef<HTMLDivElement>(null);
  const typedRef = useRef<(() => void) | null>(null);
  const mountedAt = useRef(0);

  const progressRef = useRef(progress);
  const doneWaiter = useRef<(() => void) | null>(null);
  useEffect(() => {
    progressRef.current = progress;
    if (syncDone(progress)) doneWaiter.current?.();
  }, [progress]);

  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  const onTyped = useCallback(() => {
    typedRef.current?.();
  }, []);

  // The hat drops on with a spring, then squashes.
  useEffect(() => {
    const el = hatSlotRef.current;
    if (!el) return;
    if (calm) {
      el.style.opacity = "1";
      el.style.transform = "none";
      return;
    }
    let alive = true;
    let controls = animate(
      el,
      { opacity: [0, 1], y: [-150, 0] },
      { type: "spring", bounce: 0.3, duration: 0.45, delay: 0.2 },
    );
    controls.then(() => {
      if (!alive) return;
      controls = animate(
        el,
        { scaleX: [1, 1.08, 0.97, 1], scaleY: [1, 0.9, 1.04, 1], rotate: [0, -4, 3, 0] },
        { duration: 0.56, times: [0, 0.25, 0.6, 1], ease: ease.out },
      );
    });
    return () => {
      alive = false;
      controls.stop();
    };
  }, [calm]);

  // The script.
  useEffect(() => {
    let alive = true;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    mountedAt.current = performance.now();

    const wait = (ms: number) =>
      new Promise<void>((res) => {
        if (instant || ms <= 0) return res();
        const t = setTimeout(() => {
          timers.delete(t);
          res();
        }, ms);
        timers.add(t);
      });

    let key = 0;
    const say = (text: string) =>
      new Promise<void>((res) => {
        typedRef.current = () => {
          typedRef.current = null;
          res();
        };
        setThinking(false);
        setTalking(!calm);
        setSpoken(text);
        setLine({ text, key: ++key });
      });

    const land = async (text: string, animMs: number) => {
      setHouse(text);
      setSpoken(text);
      const el = houseRef.current;
      if (!el || instant) return;
      const controls = calm
        ? animate(el, { opacity: [0, 1] }, { duration: animMs / 1000 })
        : animate(
            el,
            { opacity: [0.4, 1], scale: [0.8, 1] },
            { type: "spring", bounce: 0.3, duration: animMs / 1000 },
          );
      await controls;
    };

    (async () => {
      for (const step of steps) {
        if (!alive) return;
        switch (step.kind) {
          case "pause":
            await wait(step.ms);
            break;
          case "say":
            await say(step.text);
            if (!alive) return;
            setTalking(false);
            setThinking(true);
            await wait(step.ms);
            break;
          case "flicker":
            setHouse(step.text);
            await wait(step.ms);
            break;
          case "house": {
            const start = performance.now();
            await land(step.text, step.animMs);
            if (!alive) return;
            await wait(step.ms - (performance.now() - start));
            break;
          }
          default:
            await wait(step.ms);
        }
      }
      if (!alive) return;
      setThinking(false);
      // Never sooner than minimumMs, never before the sync is done.
      if (!instant) await wait(script.minimumMs - (performance.now() - mountedAt.current));
      if (!alive) return;
      if (!syncDone(progressRef.current)) {
        await new Promise<void>((res) => {
          doneWaiter.current = res;
        });
        doneWaiter.current = null;
      }
      if (!alive) return;
      onDoneRef.current({ hat: hatSlotRef.current, hatTip: hatTipRef.current });
    })();

    return () => {
      alive = false;
      timers.forEach(clearTimeout);
      typedRef.current = null;
      doneWaiter.current = null;
    };
  }, [steps, script.minimumMs, calm, instant]);

  // Course chips land one by one, however fast they arrive.
  const [shownCourses, setShownCourses] = useState(0);
  const courseCount = progress.courses.length;
  useEffect(() => {
    if (shownCourses >= courseCount) return;
    const since = performance.now() - mountedAt.current;
    const delay = instant
      ? 0
      : shownCourses === 0
        ? Math.max(0, CHIP_FIRST_MS[pace] - since)
        : CHIP_GAP_MS[pace];
    const t = setTimeout(() => setShownCourses((n) => n + 1), delay);
    return () => clearTimeout(t);
  }, [shownCourses, courseCount, pace, instant]);

  // The counter ticks up to the real numbers.
  const [count, setCount] = useState({ files: 0, dates: 0 });
  const countRef = useRef(count);
  const { files, dates } = progress;
  useEffect(() => {
    const from = countRef.current;
    const to = { files, dates };
    if (from.files === to.files && from.dates === to.dates) return;
    const set = (v: { files: number; dates: number }) => {
      countRef.current = v;
      setCount(v);
    };
    if (instant) {
      set(to);
      return;
    }
    let raf = 0;
    const since = performance.now() - mountedAt.current;
    const delay = Math.max(0, COUNT_DELAY_MS - since);
    const dur = COUNT_TWEEN_MS[pace];
    let start = 0;
    const frame = (now: number) => {
      if (!start) start = now;
      const p = Math.min(1, (now - start) / dur);
      const k = 1 - Math.pow(1 - p, 2);
      set({
        files: Math.round(from.files + (to.files - from.files) * k),
        dates: Math.round(from.dates + (to.dates - from.dates) * k),
      });
      if (p < 1) raf = requestAnimationFrame(frame);
    };
    const t = setTimeout(() => {
      raf = requestAnimationFrame(frame);
    }, delay);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(raf);
    };
  }, [files, dates, pace, instant]);

  const hatClass = ["hat", thinking && "thinking", talking && "talking"].filter(Boolean).join(" ");

  return (
    <div
      className="sorting"
      data-calm={calm ? "" : undefined}
      data-mode={mode}
      style={{ "--sort-ms": `${Math.round(lengthMs)}ms` } as CSSProperties}
    >
      <div className="sort-progress" aria-hidden="true" />
      <div className="sort-top">
        <button type="button" className="btn-skip" onClick={onSkip}>
          Skip
        </button>
      </div>

      {/* What the hat says, once per line, for screen readers. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {spoken}
      </p>

      <div className="sort-bubble" aria-hidden="true">
        {line && (
          <Typewriter key={line.key} text={line.text} instant={calm} onDone={onTyped} />
        )}
      </div>
      <div ref={houseRef} className="house" aria-hidden="true">
        {house}
      </div>

      <div className="sort-stage">
        <svg className="bust" viewBox="0 0 180 180" aria-hidden="true" focusable="false">
          <defs>
            <clipPath id={clipId}>
              <circle cx="90" cy="90" r="90" />
            </clipPath>
          </defs>
          <circle className="b-bg" cx="90" cy="90" r="90" />
          <g clipPath={`url(#${clipId})`}>
            <path className="b-hair" d="M54 92 Q52 46 90 44 Q128 46 126 92 L132 150 Q90 162 48 150 Z" />
            <rect className="b-skin" x="80" y="114" width="20" height="24" rx="6" />
            <path className="b-mint" d="M26 180 Q28 146 66 134 Q90 150 114 134 Q152 146 154 180 Z" />
            <ellipse className="b-skin" cx="90" cy="92" rx="25" ry="29" />
            <path className="b-hair" d="M64 88 Q64 60 90 58 Q116 60 116 88 Q106 72 90 74 Q74 72 64 88 Z" />
            <path className="b-line" d="M78 95 q4 4 8 0 M94 95 q4 4 8 0" />
            <path className="b-line" d="M85 106 q5 4 10 0" />
          </g>
        </svg>
        <div
          ref={hatSlotRef}
          className="hat-slot"
          aria-hidden="true"
          style={calm ? undefined : { opacity: 0 }}
        >
          <svg className={hatClass} viewBox="0 0 140 130" focusable="false">
            <path className="hat-shade" d="M8 106 Q22 94 40 100 Q56 92 70 99 Q86 92 100 100 Q118 94 132 106 Q118 120 96 116 Q70 124 44 116 Q22 120 8 106 Z" />
            <path className="hat-fill" d="M30 104 Q44 78 54 58 Q60 44 62 36 L82 38 Q86 56 94 72 Q102 88 110 104 Q70 114 30 104 Z" />
            <path className="hat-stitch" d="M40 96 Q70 103 102 96" />
            <path className="hat-shade" d="M84 54 l14 3 l-2 13 l-14 -3 Z" />
            <path className="hat-stitch" d="M86 58 l10 2" />
            <path className="hat-ink" d="M46 70 L60 75 Q56 81 49 78 Z" />
            <path className="hat-ink" d="M92 70 L78 75 Q82 81 89 78 Z" />
            <path className="hat-mouth" d="M54 88 Q62 84 70 88 Q77 91 84 86" />
            <path className="hat-mouth-o" d="M54 87 Q66 82 84 85 Q76 96 62 94 Z" />
            <g ref={hatTipRef} className="hat-tip">
              <path className="hat-fill" d="M61 40 Q60 18 78 9 Q96 2 106 15 Q98 13 90 19 Q82 26 83 41 Z" />
            </g>
          </svg>
        </div>
      </div>

      <div className="ticker" data-stage={typeof progress.stage === "string" ? progress.stage : undefined}>
        <div className="ticker-label mono">PULLING FROM {lmsName.toUpperCase()}</div>
        <ul className="ticker-chips" aria-label="Courses so far">
          {progress.courses.slice(0, shownCourses).map((c, i) => (
            <Chip key={`${i}-${c.name}`} course={c} calm={calm} />
          ))}
        </ul>
        <div className="ticker-count mono" data-testid="sort-count">
          {count.files} files · {count.dates} dates
        </div>
      </div>
    </div>
  );
}
