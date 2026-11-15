"use client";

/**
 * Course path, drawn (M9-07). Source: prototype merged.html CSS 995-1037 and
 * JS 5326-5411 (coursePageHTML's path part, pathIntro, playAdvance).
 *
 * A dashed trail with the read part in rose; one round stop per lecture in
 * four looks (done, cur, up, soon), a clickable label right of each stop, the
 * cap above the current stop, deadline flags between stops and a finish flag.
 * Geometry comes from M9-06 (`pathGeom`, `curvePath`, `curveLength`).
 *
 * Plain data in, callbacks out; no fetching.
 *
 *   const path = useRef<CoursePathHandle>(null);
 *   <CoursePath ref={path} lectures={…} flags={…} finish={…} intro />
 *   path.current?.playAdvance({ from: 3, to: 4 });
 *
 * `intro` plays the first-visit draw-in on mount; `advance` plays the advance
 * on mount (pass the data as it is after the read: `from` done, `to` cur).
 * Calm (reduced motion) and the instant test switch: nothing moves, the page
 * only scrolls the current stop into view.
 *
 * A lecture with an `href` marks its stop with `workSource(href)`, and a
 * click on the stop or its label hands the stop over, so the lecture page
 * can grow out of it as a circle and shrink back into it (M9-18,
 * `LECTURE_PAGE` in `@/lib/motion/shared`). `onStopPress` is called when a
 * stop or label is hovered or pressed, to prefetch its page.
 */
import "./course-path.css";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type Ref,
} from "react";
import { Vitonen } from "@/components/vitonen";
import type { LectureStatus } from "@/lib/courses/lectures";
import { curveLength, curvePath, pathGeom, type PathLecture } from "@/lib/courses/path";
import { isFast } from "@/lib/motion/fast";
import { workSource } from "@/lib/motion/shared";
import { durationMs, ease } from "@/lib/motion/tokens";
import { useMotionMode } from "@/lib/motion/use-calm";

export type PathTone = "butter" | "mint" | "sky" | "blush";

export type CoursePathLecture = {
  /** Lecture number, 1-based. */
  n: number;
  /** "" shows "Lecture n". */
  title: string;
  /** One line about the lecture. */
  line: string;
  state: LectureStatus;
  /** Cards seen of the lecture's cards, for a read lecture. Without it the meta says just "read". */
  cards?: { seen: number; total: number } | null;
  /** When a not-posted lecture opens, already formatted: "Mon 16 Nov". */
  opens?: string | null;
  /** The lecture page. When given, the stop is the card that page opens out of (`workSource`). */
  href?: string;
};

export type CoursePathFlag = {
  id: string;
  /** Lecture number `n` the flag sits after. */
  after: number;
  /** "Assignment 3 · due today 21:00". */
  text: string;
  /** Shown instead of `text` once `done`: "Assignment 3 · handed in". */
  doneText?: string;
  done?: boolean;
  tone: PathTone;
};

export type CoursePathFinish = {
  /** "Exam · Fri 20 Nov 09:00", or "Project · date to come". */
  text: string;
  /** With an exam the finish is a button and shows the forecast. */
  exam?: { id: string; forecast: number } | null;
  /** Tone of the plain pill (the course's colour). The exam flag is always blush. */
  tone?: PathTone;
};

export type CoursePathAdvance = {
  /** Lecture number just read (now done). */
  from: number;
  /** Lecture number the cap moves to (now cur), or null when none is left. */
  to: number | null;
};

export type CoursePathHandle = {
  /** First-visit draw-in. Calm: only scrolls. */
  playIntro: () => void;
  /** After a lecture was read. Calm: only scrolls. */
  playAdvance: (advance: CoursePathAdvance) => void;
};

export type CoursePathProps = {
  lectures: readonly CoursePathLecture[];
  flags?: readonly CoursePathFlag[];
  finish: CoursePathFinish;
  /** Play the first-visit draw-in on mount. */
  intro?: boolean;
  /** Play the advance on mount. Ignored when `intro` is set. */
  advance?: CoursePathAdvance | null;
  /** `stop` is the stop's button (for a label click too), for the page to grow out of. */
  onStopClick?: (lecture: CoursePathLecture, stop: HTMLElement) => void;
  /** Defaults to onStopClick. */
  onLabelClick?: (lecture: CoursePathLecture, stop: HTMLElement) => void;
  /** A stop or its label is hovered or pressed: a moment to prefetch its page. */
  onStopPress?: (lecture: CoursePathLecture) => void;
  /** When given, deadline flags are buttons. */
  onFlagClick?: (flag: CoursePathFlag) => void;
  /** Only for a finish with an exam. */
  onFinishClick?: (finish: CoursePathFinish) => void;
  className?: string;
  ref?: Ref<CoursePathHandle>;
};

const WIDE_QUERY = "(min-width: 700px)";
const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeWide(onChange: () => void): () => void {
  const media = window.matchMedia(WIDE_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}

/** Read at call time, so a play on mount is right even before the motion hook has synced. */
function calmNow(): boolean {
  return isFast() || window.matchMedia(REDUCE_QUERY).matches;
}

/** The cap sits on the current stop, or on the last read one when nothing is current. */
export function capIndex(lectures: readonly { state: LectureStatus }[]): number {
  let last = 0;
  for (let i = 0; i < lectures.length; i++) {
    if (lectures[i].state === "cur") return i;
    if (lectures[i].state === "done") last = i;
  }
  return last;
}

const STATE_WORDS: Record<LectureStatus, string> = {
  done: ", read",
  cur: ", you are here",
  up: "",
  soon: ", not posted yet",
};

function titleOf(l: CoursePathLecture): string {
  return l.title.trim() || `Lecture ${l.n}`;
}

function metaOf(l: CoursePathLecture): string {
  if (l.state === "done") return l.cards ? `read · ${l.cards.seen} of ${l.cards.total} cards` : "read";
  if (l.state === "soon" && l.opens) return `opens ${l.opens}`;
  return "";
}

function ariaOf(l: CoursePathLecture): string {
  let s = `Lecture ${l.n}, ${titleOf(l)}${STATE_WORDS[l.state]}`;
  if (l.state === "done" && l.cards) s += `, ${l.cards.seen} of ${l.cards.total} cards`;
  if (l.state === "soon" && l.opens) s += `, opens ${l.opens}`;
  return s;
}

function finishText(f: CoursePathFinish): string {
  return f.exam ? `${f.text} · ${Math.round(f.exam.forecast)}% forecast` : f.text;
}

const cubic = (e: readonly number[]) => `cubic-bezier(${e.join(",")})`;
const E_OUT = cubic(ease.out);
const E_IO = cubic(ease.inout);
/** Stand-in for the prototype's springs: the reward ease (tokens.css --e-reward) overshoots once. */
const E_SPRING = "cubic-bezier(.3,1.4,.5,1)";

function CheckIcon() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 12.5l4 4L18 8" />
    </svg>
  );
}

function FlagIcon({ filter }: { filter: string }) {
  return (
    <svg className="cp-flag-ic" viewBox="0 0 18 22" aria-hidden="true" focusable="false">
      <g filter={filter}>
        <path d="M4 21V2" />
        <path className="fl" d="M4 3h11l-3 4.5 3 4.5H4z" />
      </g>
    </svg>
  );
}

type GeomLecture = PathLecture & { lec: CoursePathLecture };

export function CoursePath({
  lectures,
  flags = [],
  finish,
  intro = false,
  advance = null,
  onStopClick,
  onLabelClick,
  onStopPress,
  onFlagClick,
  onFinishClick,
  className = "",
  ref,
}: CoursePathProps) {
  const mode = useMotionMode();
  const wide = useWide();
  const rootRef = useRef<HTMLDivElement>(null);
  const running = useRef<Animation[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const filterId = "cp-wobble-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const filter = `url(#${filterId})`;

  const geom = useMemo(
    () =>
      pathGeom<GeomLecture, CoursePathFlag>(
        lectures.map((l) => ({ n: l.n, st: l.state, lec: l })),
        flags,
        wide,
      ),
    [lectures, flags, wide],
  );
  const ci = capIndex(lectures);
  const capPt = geom.pts[ci];

  const stopAll = useCallback(() => {
    running.current.forEach((a) => a.cancel());
    running.current = [];
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  useEffect(() => stopAll, [stopAll]);

  // Turning calm mid-animation stops everything at once.
  useEffect(() => {
    if (mode !== "full") stopAll();
  }, [mode, stopAll]);

  const play = useCallback(
    (el: Element | null | undefined, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      if (!el || typeof el.animate !== "function") return;
      running.current.push(el.animate(keyframes, { fill: "backwards", ...options }));
    },
    [],
  );

  const later = useCallback((ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  const scrollToCur = useCallback((smooth: boolean) => {
    const cap = rootRef.current?.querySelector(".cp-cap");
    cap?.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "instant" });
  }, []);

  const playIntro = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    stopAll();
    if (calmNow()) {
      later(60, () => scrollToCur(false));
      return;
    }
    const n = lectures.length;
    const dl = (i: number) => (i <= ci ? Math.round(700 * (ci ? i / ci : 0)) : 700 + (i - ci) * 60);
    play(root.querySelector(".cp-done"), [{ strokeDashoffset: "1" }, { strokeDashoffset: "0" }], {
      duration: 700,
      easing: E_IO,
    });
    play(root.querySelector(".cp-base"), [{ opacity: 0 }, { opacity: 1 }], {
      duration: 300,
      easing: "linear",
    });
    root.querySelectorAll("[data-cp-stop]").forEach((s, i) => {
      play(s, [{ opacity: 0, transform: "scale(0.6)" }, { opacity: 1, transform: "scale(1)" }], {
        duration: 300,
        delay: dl(i),
        easing: E_SPRING,
      });
    });
    root.querySelectorAll("[data-cp-lbl]").forEach((l, i) => {
      play(
        l,
        [
          { opacity: 0, transform: "translate(-6px, -50%)" },
          { opacity: 1, transform: "translate(0px, -50%)" },
        ],
        { duration: 240, delay: dl(i) + 40, easing: E_OUT },
      );
    });
    root.querySelectorAll<HTMLElement>("[data-cp-flag]").forEach((f) => {
      const after = Number(f.dataset.after);
      const idx = lectures.findIndex((l) => l.n === after);
      play(f, [{ opacity: 0, transform: "scale(0.9)" }, { opacity: 1, transform: "scale(1)" }], {
        duration: 300,
        delay: dl(idx < 0 ? n - 1 : idx) + 120,
        easing: E_SPRING,
      });
    });
    play(
      root.querySelector(".cp-cap"),
      [
        { opacity: 0, transform: "translateY(-36px)" },
        { opacity: 1, transform: "translateY(0px)" },
      ],
      { duration: 450, delay: dl(ci) + 120, easing: E_SPRING },
    );
    later(260, () => scrollToCur(true));
  }, [ci, later, lectures, play, scrollToCur, stopAll]);

  const playAdvance = useCallback(
    (a: CoursePathAdvance) => {
      const root = rootRef.current;
      if (!root) return;
      stopAll();
      if (calmNow()) {
        later(60, () => scrollToCur(false));
        return;
      }
      const fromIdx = lectures.findIndex((l) => l.n === a.from);
      const toIdx = a.to === null ? -1 : lectures.findIndex((l) => l.n === a.to);
      const stopEl = (i: number) => root.querySelectorAll("[data-cp-stop]")[i];
      if (fromIdx >= 0) {
        play(stopEl(fromIdx), [{ transform: "scale(0.7)" }, { transform: "scale(1)" }], {
          duration: 400,
          easing: E_SPRING,
        });
      }
      // The rose line grows from the stop just read to where the cap is now.
      const pts = geom.pts;
      const newLen = curveLength(pts.slice(0, ci + 1));
      if (fromIdx >= 0 && newLen > 0 && fromIdx < ci) {
        const frac = 1 - curveLength(pts.slice(0, fromIdx + 1)) / newLen;
        play(root.querySelector(".cp-done"), [{ strokeDashoffset: String(frac) }, { strokeDashoffset: "0" }], {
          duration: 500,
          delay: 150,
          easing: E_IO,
        });
      }
      if (toIdx >= 0 && fromIdx >= 0) {
        const dx = pts[fromIdx].x - pts[toIdx].x;
        const dy = pts[fromIdx].y - pts[toIdx].y;
        play(
          root.querySelector(".cp-cap"),
          [
            { transform: `translate(${dx}px, ${dy}px)` },
            { offset: 0.5, transform: `translate(${dx / 2}px, ${dy / 2 - 44}px)` },
            { transform: "translate(0px, 0px)" },
          ],
          { duration: durationMs.slow, delay: 300, easing: E_IO },
        );
        play(stopEl(toIdx), [{ transform: "scale(0.8)" }, { transform: "scale(1)" }], {
          duration: 400,
          delay: 760,
          easing: E_SPRING,
        });
      }
      later(300, () => scrollToCur(true));
    },
    [ci, geom.pts, later, lectures, play, scrollToCur, stopAll],
  );

  useImperativeHandle(ref, () => ({ playIntro, playAdvance }), [playIntro, playAdvance]);

  // On mount only: what the page asked to play when it opened.
  const onMount = useRef({ intro, advance });
  const mounted = useRef({ playIntro, playAdvance });
  useEffect(() => {
    mounted.current = { playIntro, playAdvance };
  });
  useEffect(() => {
    const { intro: i, advance: a } = onMount.current;
    if (i) mounted.current.playIntro();
    else if (a) mounted.current.playAdvance(a);
  }, []);

  const all = [...geom.pts, geom.fin];
  const labelClick = onLabelClick ?? onStopClick;
  const fx = (x: number) => ({ left: x, ["--fx" as string]: `${x}px` }) as CSSProperties;

  return (
    <div
      ref={rootRef}
      className={`cpath ${mode !== "full" ? "calm" : ""} ${className}`.trim()}
      style={{ height: geom.h }}
    >
      <svg
        className="cp-trail"
        width={geom.lx}
        height={geom.h}
        aria-hidden="true"
        focusable="false"
      >
        <filter id={filterId}>
          <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves={2} seed={7} />
          <feDisplacementMap in="SourceGraphic" scale={2} />
        </filter>
        <g filter={filter}>
          <path className="cp-base" d={curvePath(all)} />
          {ci > 0 && (
            <path className="cp-done" pathLength={1} d={curvePath(geom.pts.slice(0, ci + 1))} />
          )}
        </g>
      </svg>

      {geom.flags.map(({ x, y, f }) => {
        const text = f.done && f.doneText ? f.doneText : f.text;
        const props = {
          className: `cp-flag cp-${f.tone}`,
          "data-cp-flag": "",
          "data-after": f.after,
          style: { ...fx(x - 14), top: y },
        };
        return onFlagClick ? (
          <button key={f.id} type="button" {...props} onClick={() => onFlagClick(f)}>
            <FlagIcon filter={filter} />
            <span>{text}</span>
          </button>
        ) : (
          <p key={f.id} {...props}>
            <FlagIcon filter={filter} />
            <span>{text}</span>
          </p>
        );
      })}

      {finish.exam ? (
        <button
          type="button"
          className="cp-flag finish cp-blush"
          data-cp-flag=""
          style={{ ...fx(geom.fin.x - 16), top: geom.fin.y }}
          onClick={() => onFinishClick?.(finish)}
        >
          <FlagIcon filter={filter} />
          <span>{finishText(finish)}</span>
        </button>
      ) : (
        <p
          className={`cp-flag finish cp-${finish.tone ?? "sky"}`}
          data-cp-flag=""
          style={{ ...fx(geom.fin.x - 16), top: geom.fin.y }}
        >
          <FlagIcon filter={filter} />
          <span>{finishText(finish)}</span>
        </p>
      )}

      {geom.pts.map(({ x, y, l: { lec } }) => {
        const meta = metaOf(lec);
        return (
          <Fragment key={lec.n}>
            <button
              type="button"
              {...(lec.href ? workSource(lec.href) : {})}
              className={`cp-stop ${lec.state}`}
              data-cp-stop=""
              style={{ left: x, top: y }}
              aria-label={ariaOf(lec)}
              aria-current={lec.state === "cur" ? "step" : undefined}
              onClick={(e) => onStopClick?.(lec, e.currentTarget)}
              onPointerEnter={onStopPress ? () => onStopPress(lec) : undefined}
              onPointerDown={onStopPress ? () => onStopPress(lec) : undefined}
            >
              {lec.state === "done" ? <CheckIcon /> : lec.n}
            </button>
            {/* The stop button already says all of this, so the label is hidden from screen readers. */}
            <div
              className="cp-lbl"
              data-cp-lbl=""
              aria-hidden="true"
              style={{ left: geom.lx, top: y }}
              onClick={(e) => {
                // The page grows out of the stop, which is the button just before the label.
                const stop = e.currentTarget.previousElementSibling;
                if (stop instanceof HTMLElement) labelClick?.(lec, stop);
              }}
              onPointerEnter={onStopPress ? () => onStopPress(lec) : undefined}
              onPointerDown={onStopPress ? () => onStopPress(lec) : undefined}
            >
              {lec.state === "cur" && <span className="cp-here">You are here</span>}
              <p className="mono">LECTURE {lec.n}</p>
              <p className="cp-lbl-t">{titleOf(lec)}</p>
              {lec.line && (
                <p className="cp-lbl-c" title={lec.line}>
                  {lec.line}
                </p>
              )}
              {meta && <p className="mono cp-lbl-m">{meta}</p>}
            </div>
          </Fragment>
        );
      })}

      {capPt && (
        <span className="cp-cap" style={{ left: capPt.x, top: capPt.y }}>
          <Vitonen size={40} state="idle" />
        </span>
      )}
    </div>
  );
}
