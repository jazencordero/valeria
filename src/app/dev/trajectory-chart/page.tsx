"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  TrajectoryChart,
  type TrajectoryChartItem,
} from "@/components/grades/trajectory-chart";
import {
  chartSeries,
  NEEDS_WEIGHTS,
  type GradeItem,
  type WhatIfs,
} from "@/lib/grades/model";

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

type Item = GradeItem & TrajectoryChartItem;

type Course = {
  name: string;
  items: Item[];
  whatIfs?: WhatIfs;
  target: number;
};

const COURSES: Course[] = [
  {
    name: "Graded work: two in, three to go",
    target: 5,
    items: [
      { id: "a1", short: "A1", name: "Assignment 1", weight: 0.1, score: 88 },
      { id: "q1", short: "Quiz", name: "Quiz 1", weight: 0.1, score: 79 },
      { id: "lab", short: "Lab", name: "Lab report", weight: 0.2, score: null },
      { id: "a2", short: "A2", name: "Assignment 2", weight: 0.1, score: null },
      { id: "ex", short: "Exam", name: "Final exam", weight: 0.5, score: null },
    ],
  },
  {
    name: "Nothing graded yet",
    target: 4,
    items: [
      { id: "p1", short: "P1", name: "Project part 1", weight: 0.3, score: null },
      { id: "p2", short: "P2", name: "Project part 2", weight: 0.3, score: null },
      { id: "ex", short: "Exam", name: "Final exam", weight: 0.4, score: null },
    ],
  },
  {
    name: "Edge: nothing graded, one what-if set",
    target: 3,
    whatIfs: { p1: 72 },
    items: [
      { id: "p1", short: "P1", name: "Project part 1", weight: 0.3, score: null },
      { id: "p2", short: "P2", name: "Project part 2", weight: 0.3, score: null },
      { id: "ex", short: "Exam", name: "Final exam", weight: 0.4, score: null },
    ],
  },
  {
    name: "Edge: everything graded",
    target: 4,
    items: [
      { id: "h1", short: "H1", name: "Homework 1", weight: 0.25, score: 92 },
      { id: "h2", short: "H2", name: "Homework 2", weight: 0.25, score: 61 },
      { id: "mid", short: "Mid", name: "Midterm", weight: 0.2, score: 70 },
      { id: "ex", short: "Exam", name: "Final exam", weight: 0.3, score: 84 },
    ],
  },
];

const WIDTHS = [340, 700];
const TARGETS = [5, 3, 4, 1];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="font-mono text-ink-3 font-medium uppercase tracking-[0.04em]">{title}</h2>
      {children}
    </section>
  );
}

export default function TrajectoryChartPage() {
  // Changing the key remounts the charts, so the first-show motion plays again.
  const [run, setRun] = useState(0);
  // Index into TARGETS for the first course; the button slides its target line.
  const [tIdx, setTIdx] = useState(0);

  return (
    <main className="space-y-12 px-4 py-10">
      <header className="mx-auto max-w-2xl space-y-3">
        <h1 className="type-h30">Trajectory chart</h1>
        <p className="text-ink-2">
          Running grade, projection, the 50 to 100% band and the target. Each course at 340 and
          700 px wide.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setTheme("light")}>
            Light
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setTheme("dark")}>
            Dark
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setTheme("system")}>
            System
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setRun((n) => n + 1)}>
            Replay
          </Button>
          <Button
            variant="secondary"
            size="sm"
            data-testid="change-target"
            onClick={() => setTIdx((i) => (i + 1) % TARGETS.length)}
          >
            Change target ({TARGETS[tIdx]} to {TARGETS[(tIdx + 1) % TARGETS.length]})
          </Button>
        </div>
      </header>

      <div key={run} className="space-y-14">
        {COURSES.map((c, ci) => {
          const series = chartSeries(c.items, c.whatIfs);
          const target = ci === 0 ? TARGETS[tIdx] : c.target;
          return (
            <Section key={c.name} title={c.name}>
              {series === NEEDS_WEIGHTS ? (
                <p className="text-ink-3">Needs weights.</p>
              ) : (
                <div className="flex flex-wrap items-start gap-8">
                  {WIDTHS.map((w) => (
                    <div
                      key={w}
                      data-width={w}
                      className="max-w-full rounded-2xl border border-line bg-surface p-4"
                      style={{ width: w + 34 }}
                    >
                      <p className="mb-2 font-mono text-[12px] text-ink-3">{w} px</p>
                      <TrajectoryChart
                        items={c.items}
                        series={series}
                        target={target}
                        style={{ width: w, maxWidth: "100%" }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </Section>
          );
        })}
      </div>
    </main>
  );
}
