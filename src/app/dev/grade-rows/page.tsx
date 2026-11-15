"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RollingNumber } from "@/components/ui/rolling-number";
import { GradedList, type RowItem } from "@/components/grades/graded-list";
import { LeftRows } from "@/components/grades/left-rows";
import { fmt1 } from "@/components/grades/trajectory-chart";
import { NEEDS_WEIGHTS, trajectory, type WhatIfs } from "@/lib/grades/model";

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

type Case = { key: string; label: string; name: string; items: RowItem[] };

// Made-up sample courses.
const CASES: Case[] = [
  {
    key: "some",
    label: "Some graded: swing bars from the start",
    name: "Organic chemistry",
    items: [
      { id: "a1", name: "Assignment 1", weight: 0.1, score: 90 },
      { id: "a2", name: "Assignment 2", weight: 0.1, score: 74 },
      { id: "a3", name: "Assignment 3", weight: 0.2, score: null, when: "Fri 21 Nov", handedIn: true },
      { id: "ex", name: "Exam", weight: 0.6, score: null, when: "Exam week" },
    ],
  },
  {
    key: "none",
    label: "Nothing graded: needs a what-if first",
    name: "Linear algebra",
    items: [
      { id: "p1", name: "Problem sets", weight: 0.4, score: null, when: "Weekly" },
      { id: "ex", name: "Exam", weight: 0.6, score: null, when: "Exam week" },
    ],
  },
  {
    key: "all",
    label: "Everything graded: no what-ifs",
    name: "Academic writing",
    items: [
      { id: "e1", name: "Essay 1", weight: 0.4, score: 88 },
      { id: "e2", name: "Essay 2", weight: 0.6, score: 79 },
    ],
  },
];

function CourseCase({ c }: { c: Case }) {
  const [whatIfs, setWhatIfs] = useState<WhatIfs>({});
  const [releases, setReleases] = useState(0);
  const t = trajectory(c.items, whatIfs);
  const heading = t == null || t === NEEDS_WEIGHTS ? "–" : fmt1(t);

  return (
    <section data-case={c.key} className="space-y-3">
      <h2 className="font-mono font-medium uppercase tracking-[0.04em] text-ink-3">{c.label}</h2>
      <div className="rounded-[14px] border border-solid border-line bg-surface px-4 pb-5 pt-4">
        <p className="text-[15px] text-ink-2">
          {c.name}: heading for{" "}
          <span data-testid="summary" className="font-mono text-ink">
            <RollingNumber value={heading} />
          </span>
          <span className="mono ml-2 text-ink-3" data-testid="releases">
            {releases} {releases === 1 ? "release" : "releases"}
          </span>
        </p>
        <LeftRows
          items={c.items}
          whatIfs={whatIfs}
          onRelease={(id, value) => {
            setWhatIfs((w) => ({ ...w, [id]: value }));
            setReleases((n) => n + 1);
          }}
          onReset={() => setWhatIfs({})}
        />
        <GradedList items={c.items} />
      </div>
    </section>
  );
}

export default function GradeRowsPage() {
  return (
    <main className="space-y-10 px-4 py-10">
      <header className="mx-auto max-w-[720px] space-y-3">
        <h1 className="type-h30">What is left and graded</h1>
        <p className="text-ink-2">
          Drag a slider or Tab to it and use the arrow keys, Home, End, Page Up and Page Down. The
          card recalculates live; the summary rolls when you let go.
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
        {CASES.map((c) => (
          <CourseCase key={c.key} c={c} />
        ))}
      </div>
    </main>
  );
}
