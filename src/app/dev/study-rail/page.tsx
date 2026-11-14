"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { GradeMode, type GradeModeValue } from "@/components/study/grade-mode";
import { StudyDays } from "@/components/study/study-days";
import { freeSkipsLeft, weekOf, weeksInARow } from "@/lib/study/week";

// Saturday 14 November 2026, 15:48 in Helsinki, as in the prototype.
const NOW = new Date("2026-11-14T13:48:00Z");
const GOAL = 4;

// Three earlier weeks that each kept the goal, so the line reads "3 WEEKS IN A ROW".
const PAST = [
  "2026-10-19", "2026-10-21", "2026-10-22", "2026-10-24",
  "2026-10-26", "2026-10-27", "2026-10-29", "2026-10-31",
  "2026-11-02", "2026-11-04", "2026-11-05", "2026-11-07",
].map((d) => `${d}T10:00:00Z`);

const STATES: { label: string; reviews: string[]; pop?: boolean }[] = [
  {
    label: "Goal not met: Monday and Wednesday, today still open",
    reviews: [...PAST, "2026-11-09T10:00:00Z", "2026-11-11T10:00:00Z"],
  },
  {
    label: "One to go: Monday, Wednesday and Thursday",
    reviews: [...PAST, "2026-11-09T10:00:00Z", "2026-11-11T10:00:00Z", "2026-11-12T10:00:00Z"],
  },
  {
    label: "Met: today made the week (today's dot pops in)",
    reviews: [
      ...PAST,
      "2026-11-09T10:00:00Z",
      "2026-11-11T10:00:00Z",
      "2026-11-12T10:00:00Z",
      "2026-11-14T08:00:00Z",
    ],
    pop: true,
  },
];

const WIDTHS = [300, 360];

export default function StudyRailPreview() {
  const [gm, setGm] = useState<GradeModeValue>("two");
  const [replay, setReplay] = useState(0);

  return (
    <main className="space-y-10 bg-paper px-4 py-10">
      <header className="mx-auto max-w-[760px] space-y-3">
        <h1 className="type-h26 text-ink">Exam page rail</h1>
        <p className="text-[14px] text-ink-2">
          Study days (goal not met, one to go, met) and how you grade. Now is SAT 14 NOV 15:48,
          goal 4 days. Press the other grade option to switch. Replay pops today&apos;s dot in
          again; with reduced motion it fades.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" onClick={() => setReplay((n) => n + 1)}>
            Replay today&apos;s dot
          </Button>
          <p className="mono text-ink-3" aria-live="polite">
            {gm === "two" ? "GRADING: MISSED · GOT IT" : "GRADING: ANKI, 4 BUTTONS"}
          </p>
        </div>
      </header>
      {WIDTHS.map((w) => (
        <section key={w} className="space-y-4" aria-label={`${w} px wide`}>
          <h2 className="mono mx-auto max-w-[760px] text-ink-3 [font-variation-settings:normal]">
            {w} PX
          </h2>
          <div className="mx-auto flex max-w-[760px] flex-wrap gap-6">
            {STATES.map((s) => (
              <figure key={s.label} className="space-y-2" style={{ width: w }}>
                <figcaption className="text-[13px] text-ink-2">{s.label}</figcaption>
                <StudyDays
                  key={s.pop ? `pop-${replay}` : "still"}
                  week={weekOf(s.reviews, GOAL, NOW)}
                  weeksInARow={weeksInARow(s.reviews, GOAL, NOW)}
                  freeSkipsLeft={freeSkipsLeft(s.reviews, GOAL, NOW)}
                  popToday={s.pop}
                />
              </figure>
            ))}
            <figure className="space-y-2" style={{ width: w }}>
              <figcaption className="text-[13px] text-ink-2">How you grade</figcaption>
              <GradeMode value={gm} onChange={setGm} />
            </figure>
          </div>
        </section>
      ))}
    </main>
  );
}
