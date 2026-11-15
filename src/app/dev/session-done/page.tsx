"use client";

import { useState } from "react";
import { DoodleDefs } from "@/components/doodle";
import { SessionDone, type DoneConcept, type SessionDoneProps } from "@/components/session/done";
import { Button } from "@/components/ui/button";
import { useMotionMode } from "@/lib/motion/use-calm";
import type { SessionResult } from "@/lib/study/session";
import { freeSkipsLeft, weekOf, weeksInARow } from "@/lib/study/week";

// Saturday 14 November 2026, 15:48 in Helsinki, as in the prototype.
const NOW = new Date("2026-11-14T13:48:00Z");
const GOAL = 4;

// Three earlier weeks that each kept the goal.
const PAST = [
  "2026-10-19", "2026-10-21", "2026-10-22", "2026-10-24",
  "2026-10-26", "2026-10-27", "2026-10-29", "2026-10-31",
  "2026-11-02", "2026-11-04", "2026-11-05", "2026-11-07",
].map((d) => `${d}T10:00:00Z`);

const MON_WED = ["2026-11-09T10:00:00Z", "2026-11-11T10:00:00Z"];
const THU = "2026-11-12T10:00:00Z";
const TODAY = "2026-11-14T13:40:00Z";

function week(reviews: string[]) {
  const all = [...PAST, ...reviews];
  return {
    week: weekOf(all, GOAL, NOW),
    weeksInARow: weeksInARow(all, GOAL, NOW),
    freeSkipsLeft: freeSkipsLeft(all, GOAL, NOW),
  };
}

/** Today counted for the first time, and it made the goal (4 of 4). */
const GOAL_MET = week([...MON_WED, THU, TODAY]);
/** Today counted for the first time, goal not met yet (3 of 4). */
const GOAL_OPEN = week([...MON_WED, TODAY]);

const ICON = (d: string) => (
  <svg className="ic !size-[18px]" viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} />
  </svg>
);

const CONCEPTS: Record<string, DoneConcept> = {
  c1: { name: "Sampling and estimates", icon: ICON("M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z") },
  c2: { name: "Distributions", icon: ICON("M3 16c3 0 3-8 6-8s3 8 6 8 3-4 6-4") },
  c3: { name: "Regression", icon: ICON("M4 19L19 5M13 5h6v6") },
  c4: { name: "Hypothesis tests", icon: ICON("M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z") },
};

const CLIMBS_BIG: SessionResult["climbs"] = [
  { concept: "c2", from: 0.62, to: 0.78 }, // Recall -> Explain it
  { concept: "c3", from: 0.42, to: 0.49 }, // Recognise -> Fill the gap
  { concept: "c1", from: 0.66, to: 0.7 }, // stays on Recall
];

const CLIMBS_SMALL: SessionResult["climbs"] = [
  { concept: "c4", from: 0.31, to: 0.36 }, // stays on Recognise
];

function res(over: Partial<SessionResult>): SessionResult {
  return { cards: 8, seconds: 252, best: 5, perfect: false, climbs: CLIMBS_BIG, reviews: [], ...over };
}

const BASE = {
  examShort: "stats",
  forecastBefore: 58,
  forecastAfter: 62,
  target: 80,
  targetGrade: 4,
  planEnd: 88,
  examDay: "Friday",
  concepts: CONCEPTS,
  backLabel: "Back to the exam",
} as const;

type State = { id: string; label: string; props: Omit<SessionDoneProps, "focusTitle"> };

const STATES: State[] = [
  {
    id: "perfect-more-goal",
    label: "Perfect bite, another bite left, goal met",
    props: { ...BASE, result: res({ perfect: true, best: 8 }), mode: "bite", ...GOAL_MET, dayNew: true, goalNew: true, nextBiteMinutes: 4 },
  },
  {
    id: "perfect-last-open",
    label: "Perfect bite, plan done, goal not met",
    props: { ...BASE, result: res({ perfect: true, best: 8 }), mode: "bite", ...GOAL_OPEN, dayNew: true, goalNew: false, nextBiteMinutes: null },
  },
  {
    id: "normal-more-open",
    label: "Bite done, another bite left, goal not met",
    props: { ...BASE, result: res({}), mode: "bite", ...GOAL_OPEN, dayNew: true, goalNew: false, nextBiteMinutes: 4 },
  },
  {
    id: "normal-last-goal",
    label: "Bite done, plan done, goal met",
    props: { ...BASE, result: res({ cards: 10, seconds: 318, best: 6 }), mode: "bite", ...GOAL_MET, dayNew: true, goalNew: true, nextBiteMinutes: null },
  },
  {
    id: "practice-open",
    label: "Practice, goal not met, small climb",
    props: {
      ...BASE,
      forecastBefore: 62,
      forecastAfter: 63,
      result: res({ cards: 6, seconds: 171, best: 3, climbs: CLIMBS_SMALL }),
      mode: "tile",
      ...GOAL_OPEN,
      dayNew: true,
      goalNew: false,
      nextBiteMinutes: 4,
    },
  },
  {
    id: "practice-goal",
    label: "Practice, goal met",
    props: { ...BASE, result: res({ cards: 7, seconds: 205, best: 4 }), mode: "concept", ...GOAL_MET, dayNew: true, goalNew: true, nextBiteMinutes: null },
  },
  {
    id: "practice-flat",
    label: "Practice, today already counted, nothing moved",
    props: {
      ...BASE,
      forecastBefore: 63,
      forecastAfter: 63,
      result: res({ cards: 1, seconds: 41, best: 1, climbs: [] }),
      mode: "extra",
      ...GOAL_MET,
      dayNew: false,
      goalNew: false,
      nextBiteMinutes: null,
    },
  },
];

export default function SessionDonePreview() {
  const mode = useMotionMode();
  const [pick, setPick] = useState(STATES[0].id);
  const [replay, setReplay] = useState(0);
  const state = STATES.find((s) => s.id === pick) ?? STATES[0];

  return (
    <main className="min-h-dvh space-y-6 bg-paper px-4 py-10">
      <DoodleDefs />
      <header className="mx-auto max-w-[760px] space-y-3">
        <h1 className="type-h26 text-ink">Session done</h1>
        <p className="text-[14px] text-ink-2">
          Pick an ending. Now is SAT 14 NOV 15:48, goal {GOAL} days. Motion: {mode}. Replay plays
          the cap jump, confetti, rolling numbers and today&apos;s dot again; with reduced motion
          it only fades.
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Ending">
          {STATES.map((s) => (
            <Button
              key={s.id}
              size="sm"
              variant={s.id === pick ? "primary" : "secondary"}
              aria-pressed={s.id === pick}
              data-state-id={s.id}
              onClick={() => {
                setPick(s.id);
                setReplay((n) => n + 1);
              }}
            >
              {s.label}
            </Button>
          ))}
        </div>
        <Button variant="text" size="sm" onClick={() => setReplay((n) => n + 1)}>
          Replay
        </Button>
      </header>
      <div className="mx-auto max-w-[560px] rounded-[24px] border border-solid border-line bg-paper p-5">
        <SessionDone key={`${pick}-${replay}`} {...state.props} focusTitle={false} />
      </div>
    </main>
  );
}
