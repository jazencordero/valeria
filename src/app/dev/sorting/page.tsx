"use client";

/**
 * Preview of the sorting scene (M5-10) with fake first-sync progress:
 * 4 courses, 47 files, 6 dates, arriving over a few seconds.
 * Replay restarts it; Motion forces full or calm (reduced) motion.
 */
import { useEffect, useRef, useState } from "react";
import { Sorting, type SortingProgress } from "@/components/first-run/sorting";
import type { MotionMode } from "@/lib/motion/use-calm";
import { SCHOOLS } from "@/lib/schools";
import { guessProgramme } from "@/lib/sorting/script";

const SCHOOL = "aalto" as const;
const PROGRAMME = guessProgramme([{ code: "ISM-E1001" }, { code: "ISM-E2002" }, { code: "TU-A1100" }]);

const COURSES = [
  { name: "Service Design", color: "var(--confetti-1)" },
  { name: "Business Analytics", color: "var(--confetti-3)" },
  { name: "Information Systems", color: "var(--confetti-4)" },
  { name: "Academic English", color: "var(--confetti-5)" },
];

/** [ms after start, progress at that moment]. */
const TIMELINE: [number, SortingProgress][] = [
  [0, { courses: [], files: 0, dates: 0, done: false, stage: "courses" }],
  [900, { courses: COURSES.slice(0, 1), files: 6, dates: 0, done: false, stage: "assignments" }],
  [2200, { courses: COURSES.slice(0, 2), files: 18, dates: 2, done: false, stage: "dates" }],
  [3600, { courses: COURSES.slice(0, 3), files: 31, dates: 4, done: false, stage: "grades" }],
  [5000, { courses: COURSES, files: 47, dates: 6, done: false, stage: "files" }],
  [6000, { courses: COURSES, files: 47, dates: 6, done: true, stage: "done" }],
];

type Choice = "auto" | Exclude<MotionMode, "instant">;
type Status = { kind: "playing" } | { kind: "done"; ms: number } | { kind: "skipped"; ms: number };

export default function SortingPage() {
  const [run, setRun] = useState(0);
  const [choice, setChoice] = useState<Choice>("auto");
  const [progress, setProgress] = useState<SortingProgress>(TIMELINE[0][1]);
  const [status, setStatus] = useState<Status>({ kind: "playing" });
  const startedAt = useRef(0);

  const restart = () => {
    setProgress(TIMELINE[0][1]);
    setStatus({ kind: "playing" });
  };

  useEffect(() => {
    startedAt.current = performance.now();
    const timers = TIMELINE.slice(1).map(([ms, p]) => setTimeout(() => setProgress(p), ms));
    return () => timers.forEach(clearTimeout);
  }, [run, choice]);

  const elapsed = () => Math.round(performance.now() - startedAt.current);

  return (
    <main className="min-h-dvh pb-24">
      <Sorting
        key={`${run}-${choice}`}
        lmsName={SCHOOLS[SCHOOL].lms}
        school={SCHOOL}
        programme={PROGRAMME}
        progress={progress}
        mode={choice === "auto" ? undefined : choice}
        onSkip={() => setStatus({ kind: "skipped", ms: elapsed() })}
        onDone={() => setStatus({ kind: "done", ms: elapsed() })}
      />

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-[440px] flex-wrap items-center gap-x-3 gap-y-2">
          <button
            type="button"
            className="min-h-11 rounded-full border border-line px-4 text-[14px] font-medium"
            onClick={() => {
              restart();
              setRun((n) => n + 1);
            }}
          >
            Replay
          </button>
          <label className="flex items-center gap-2 text-[14px]">
            <span className="ink-2">Motion</span>
            <select
              className="min-h-11 rounded-full border border-line bg-surface px-3"
              value={choice}
              onChange={(e) => {
                restart();
                setChoice(e.target.value as Choice);
              }}
              data-testid="sort-mode"
            >
              <option value="auto">Auto</option>
              <option value="full">Full</option>
              <option value="calm">Calm</option>
            </select>
          </label>
          <span className="mono ink-3" data-testid="sort-status">
            {status.kind === "playing"
              ? "Playing…"
              : `${status.kind === "done" ? "Done" : "Skipped"} at ${(status.ms / 1000).toFixed(1)} s`}
          </span>
        </div>
      </div>
    </main>
  );
}
