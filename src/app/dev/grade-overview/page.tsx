"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { GradeHead } from "@/components/grades/grade-head";
import { Overview, type GradeTarget } from "@/components/grades/overview";
import type { CourseColor } from "@/components/shell/side-nav";
import {
  mattersMost,
  NEEDS_WEIGHTS,
  soFar,
  trajectory,
  verdict,
  type GradeItem,
} from "@/lib/grades/model";

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

type Item = GradeItem & { name: string };

type Course = {
  key: string;
  label: string;
  name: string;
  code: string;
  dot: CourseColor;
  target: GradeTarget;
  items: Item[];
};

const COURSES: Course[] = [
  {
    key: "on",
    label: "On track (try 5 for within reach)",
    name: "Organic chemistry",
    code: "CHEM-A1250",
    dot: "butter",
    target: 4,
    items: [
      { id: "a1", name: "Assignment 1", weight: 0.2, score: 84 },
      { id: "a2", name: "Assignment 2", weight: 0.2, score: 76 },
      { id: "ex", name: "Exam", weight: 0.6, score: null },
    ],
  },
  {
    key: "within",
    label: "Within reach",
    name: "Statistics basics",
    code: "MS-A0503",
    dot: "sky",
    target: 4,
    items: [
      { id: "h1", name: "Homework", weight: 0.25, score: 78 },
      { id: "q1", name: "Quizzes", weight: 0.15, score: 71 },
      { id: "ex", name: "Exam", weight: 0.6, score: null },
    ],
  },
  {
    key: "out",
    label: "Out of reach (try 3)",
    name: "Cell biology",
    code: "CHEM-E8125",
    dot: "mint",
    target: 5,
    items: [
      { id: "l1", name: "Lab reports", weight: 0.3, score: 58 },
      { id: "mid", name: "Midterm", weight: 0.3, score: 62 },
      { id: "ex", name: "Exam", weight: 0.4, score: null },
    ],
  },
  {
    key: "all",
    label: "Everything graded",
    name: "Academic writing",
    code: "LC-1320",
    dot: "blush",
    target: 5,
    items: [
      { id: "e1", name: "Essay 1", weight: 0.4, score: 88 },
      { id: "e2", name: "Essay 2", weight: 0.6, score: 79 },
    ],
  },
  {
    key: "none",
    label: "Nothing graded yet",
    name: "Linear algebra",
    code: "MS-A0011",
    dot: "butter",
    target: 5,
    items: [
      { id: "p1", name: "Problem sets", weight: 0.4, score: null },
      { id: "ex", name: "Exam", weight: 0.6, score: null },
    ],
  },
];

/** What the screen would get from the page: model.ts outputs as plain data. */
function gradeData(items: Item[], target: GradeTarget) {
  const sf = soFar(items);
  const t = trajectory(items);
  const traj = sf == null || sf === NEEDS_WEIGHTS || t === NEEDS_WEIGHTS ? null : t;
  const mm = mattersMost(items);
  return {
    trajectory: traj,
    transcript: traj == null ? null : Math.floor(traj + 1e-9),
    verdict: verdict(items, target),
    mattersMost: mm && mm !== NEEDS_WEIGHTS ? { name: mm.name, weight: mm.weight ?? 0 } : null,
  };
}

function CourseCase({ course }: { course: Course }) {
  const [target, setTarget] = useState<GradeTarget>(course.target);
  const d = gradeData(course.items, target);
  return (
    <section data-case={course.key} className="space-y-3">
      <h2 className="font-mono font-medium uppercase tracking-[0.04em] text-ink-3">
        {course.label}
      </h2>
      <div className="rounded-[14px] border border-solid border-line bg-surface px-4 pb-6 pt-1">
        <GradeHead
          name={course.name}
          code={course.code}
          dot={course.dot}
          trajectory={d.trajectory}
          transcript={d.transcript}
          verdict={d.verdict}
          target={target}
          onBack={() => {}}
        />
        <Overview
          className="mt-6"
          verdict={d.verdict}
          target={target}
          onTargetChange={setTarget}
          mattersMost={d.mattersMost}
        />
      </div>
    </section>
  );
}

export default function GradeOverviewPage() {
  return (
    <main className="space-y-10 px-4 py-10">
      <header className="mx-auto max-w-[720px] space-y-3">
        <h1 className="type-h30">Grade page top and Overview</h1>
        <p className="text-ink-2">
          The four verdicts and a course with nothing graded. Change &ldquo;Aiming for&rdquo; and
          the numbers roll and the facts rewrite.
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
        </div>
      </header>
      <div className="mx-auto max-w-[720px] space-y-10">
        {COURSES.map((c) => (
          <CourseCase key={c.key} course={c} />
        ))}
      </div>
    </main>
  );
}
