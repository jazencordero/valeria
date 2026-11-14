"use client";

/**
 * Preview for M9-07, the course path. Two made-up courses: one with an exam
 * at the finish (the finish is a button with the forecast), one with a plain
 * finish pill. Together they show all four stop looks and two kinds of flag.
 */
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import {
  CoursePath,
  type CoursePathFinish,
  type CoursePathFlag,
  type CoursePathHandle,
  type CoursePathLecture,
} from "@/components/courses/course-path";
import { useMotionMode } from "@/lib/motion/use-calm";

/** Before the read: lecture 3 is current. */
const FORECASTING_BEFORE: CoursePathLecture[] = [
  { n: 1, title: "What a forecast is", line: "Signal, noise and why the past is a guide.", state: "done", cards: { seen: 6, total: 6 } },
  { n: 2, title: "Trends and seasons", line: "Pulling a series apart into its pieces.", state: "done", cards: { seen: 4, total: 6 } },
  { n: 3, title: "Smoothing", line: "Moving averages and exponential smoothing.", state: "cur" },
  { n: 4, title: "Measuring error", line: "MAE, RMSE and when each one lies.", state: "up" },
  { n: 5, title: "Stationarity", line: "Why differencing makes a series behave.", state: "up" },
  { n: 6, title: "ARIMA models", line: "Reading ACF and PACF plots to pick a model.", state: "soon", opens: "Mon 16 Nov" },
];

/** After the read: lecture 3 is done, 4 is current. */
const FORECASTING_AFTER: CoursePathLecture[] = FORECASTING_BEFORE.map((l) =>
  l.n === 3
    ? { ...l, state: "done", cards: null }
    : l.n === 4
      ? { ...l, state: "cur" }
      : l,
);

const FORECASTING_FINISH: CoursePathFinish = {
  text: "Exam · Fri 20 Nov 09:00",
  exam: { id: "exam-1", forecast: 64 },
};

const DESIGN_LECTURES: CoursePathLecture[] = [
  { n: 1, title: "Why services fail", line: "The moments where people give up.", state: "done" },
  { n: 2, title: "Journey maps", line: "Drawing what someone goes through, step by step.", state: "cur" },
  { n: 3, title: "Service blueprints", line: "What happens backstage to make a step work.", state: "up" },
  { n: 4, title: "Prototyping a service", line: "Testing a service before it exists.", state: "soon", opens: "Mon 16 Nov" },
  { n: 5, title: "", line: "", state: "soon", opens: "Mon 23 Nov" },
];

const DESIGN_FLAGS: CoursePathFlag[] = [
  { id: "d1", after: 3, text: "Service blueprint draft · due Thu 19 Nov", tone: "butter" },
];

const DESIGN_FINISH: CoursePathFinish = { text: "Final concept · date to come", tone: "sky" };

function setFast(on: boolean) {
  const root = document.documentElement;
  if (on) root.dataset.fast = "1";
  else delete root.dataset.fast;
}

export default function CoursePathPage() {
  const mode = useMotionMode();
  const forecasting = useRef<CoursePathHandle>(null);
  const design = useRef<CoursePathHandle>(null);
  const [advanced, setAdvanced] = useState(false);
  const [handedIn, setHandedIn] = useState(false);
  const [last, setLast] = useState("Nothing tapped yet.");

  const forecastingFlags: CoursePathFlag[] = [
    { id: "c1", after: 2, text: "Case 1 · graded 16/20", tone: "mint" },
    {
      id: "a3",
      after: 4,
      text: "Assignment 3 · due today 21:00",
      doneText: "Assignment 3 · handed in",
      done: handedIn,
      tone: "butter",
    },
  ];

  // The advance plays on the new data (3 done, 4 current), so commit it first.
  const replayAdvance = () => {
    flushSync(() => setAdvanced(true));
    forecasting.current?.playAdvance({ from: 3, to: 4 });
  };

  const tap = (what: string) => setLast(what);

  return (
    <main className="mx-auto max-w-[760px] space-y-10 px-5 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Course path</h1>
        <p className="ink-2">
          Read, current, coming and not-posted stops, deadline flags and both
          kinds of finish. With reduced motion or the instant switch on,
          nothing moves; the replays only scroll the current stop into view.
        </p>
        <p className="font-mono text-sm ink-3" data-testid="motion-mode">
          motion: {mode}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => forecasting.current?.playIntro()}>
            Replay first visit
          </Button>
          <Button variant="secondary" size="sm" onClick={replayAdvance}>
            Replay advance (3 → 4)
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAdvanced(false)}>
            Reset to lecture 3
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setHandedIn((v) => !v)}>
            {handedIn ? "Undo hand-in" : "Hand in Assignment 3"}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setFast(mode !== "instant")}>
            {mode === "instant" ? "Instant switch off" : "Instant switch on"}
          </Button>
        </div>
        <p className="mono ink-2" aria-live="polite" data-testid="last-tap">
          {last}
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="type-h22">Forecasting basics</h2>
        <p className="fine">Finish with an exam: a button with the forecast.</p>
        <CoursePath
          ref={forecasting}
          lectures={advanced ? FORECASTING_AFTER : FORECASTING_BEFORE}
          flags={forecastingFlags}
          finish={FORECASTING_FINISH}
          onStopClick={(l) => tap(`Stop: lecture ${l.n}`)}
          onLabelClick={(l) => tap(`Label: lecture ${l.n}`)}
          onFinishClick={(f) => tap(`Finish: ${f.exam?.id}`)}
        />
      </section>

      <section className="space-y-2">
        <h2 className="type-h22">Service design</h2>
        <p className="fine">No exam: a plain finish pill. Flags are buttons here.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => design.current?.playIntro()}>
            Replay first visit
          </Button>
        </div>
        <CoursePath
          ref={design}
          lectures={DESIGN_LECTURES}
          flags={DESIGN_FLAGS}
          finish={DESIGN_FINISH}
          onStopClick={(l) => tap(`Stop: lecture ${l.n}`)}
          onFlagClick={(f) => tap(`Flag: ${f.id}`)}
        />
      </section>
    </main>
  );
}
