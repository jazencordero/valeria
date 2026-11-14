"use client";

/**
 * Preview for M3-48: "WHERE YOU GAIN MOST" and the "How it is going" sheet.
 * Made-up concepts. Cases: the three gain cards (one wide row from 700 px,
 * stacked below), a tie kept in list order, fewer than three concepts, and the
 * button that opens the sheet. Inside the sheet, "Practise this" and a lecture
 * link both close it first.
 */
import { useState } from "react";
import { DoodleDefs } from "@/components/doodle";
import { GainMost } from "@/components/study/gain-most";
import { ProgressSheet, type ProgressConcept } from "@/components/study/progress-sheet";
import { practiseMinutes } from "@/components/study/concept-detail";
import { Button } from "@/components/ui/button";
import { focusConcept } from "@/lib/study/ladder";
import { freeSkipsLeft, weekOf, weeksInARow } from "@/lib/study/week";

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

const CONCEPTS: ProgressConcept[] = [
  { id: "c1", name: "Data governance", lecture: 1, weight: 0.1, mastery: 0.93, minutes: practiseMinutes(2) },
  { id: "c2", name: "Contract terms", lecture: 2, weight: 0.15, mastery: 0.48, minutes: practiseMinutes(6) },
  { id: "c3", name: "Exponential smoothing", lecture: 3, weight: 0.25, mastery: 0.36, minutes: practiseMinutes(8) },
  { id: "c4", name: "Value of data", lecture: 4, weight: 0.2, mastery: 0.12, minutes: practiseMinutes(4) },
  { id: "c5", name: "Reading a chart", lecture: 5, weight: 0.05, mastery: 0.6, minutes: practiseMinutes(3) },
  {
    id: "c6",
    name: "Difference in differences",
    lecture: 6,
    weight: 0.25,
    mastery: 0,
    minutes: null,
    cardsLecture: 6,
  },
].map((c) => ({ ...c, lectureHref: `/dev/progress-bits#lecture-${c.lecture}` }));

const TIE = [
  { id: "t1", name: "Supply curves", weight: 0.2, mastery: 0.5 },
  { id: "t2", name: "Price elasticity", weight: 0.2, mastery: 0.5 },
  { id: "t3", name: "Market power", weight: 0.2, mastery: 0.5 },
  { id: "t4", name: "Game theory", weight: 0.2, mastery: 0.5 },
];

const TWO = CONCEPTS.slice(0, 2);

const NOW = "2026-11-12T10:00:00";
const DAYS = ["2026-11-03", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-11"];

export default function ProgressBitsPage() {
  const [run, setRun] = useState(0);
  const [practised, setPractised] = useState<string | null>(null);
  const week = weekOf(DAYS, 4, NOW);

  return (
    <main className="mx-auto max-w-[760px] space-y-10 bg-paper px-4 py-10 text-ink">
      <DoodleDefs />
      <header className="space-y-3">
        <h1 className="font-display text-2xl">Progress bits</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setRun((r) => r + 1)}>
            Replay
          </Button>
          <Button variant="secondary" onClick={() => setTheme("light")}>Light</Button>
          <Button variant="secondary" onClick={() => setTheme("dark")}>Dark</Button>
          <Button variant="secondary" onClick={() => setTheme("system")}>System</Button>
        </div>
        <p className="text-sm text-ink-3" aria-live="polite" data-practised={practised ?? ""}>
          {practised
            ? `Practise pressed: ${CONCEPTS.find((c) => c.id === practised)?.name}`
            : "Nothing practised yet."}
        </p>
      </header>

      <section data-case="main" className="space-y-4" key={`main-${run}`}>
        <h2 className="font-mono text-xs font-medium uppercase tracking-[0.04em] text-ink-3">
          Progress tab: gain cards and the button
        </h2>
        <GainMost concepts={CONCEPTS} />
        <ProgressSheet
          concepts={CONCEPTS}
          focusId={focusConcept(CONCEPTS)?.id ?? null}
          daysLeft={9}
          phaseNext="Final review starts Tue 17."
          week={week}
          weeksInARow={weeksInARow(DAYS, 4, NOW)}
          freeSkipsLeft={freeSkipsLeft(DAYS, 4, NOW)}
          onPractise={setPractised}
        />
      </section>

      <section data-case="tie" className="space-y-4" key={`tie-${run}`}>
        <h2 className="font-mono text-xs font-medium uppercase tracking-[0.04em] text-ink-3">
          A four-way tie keeps list order
        </h2>
        <GainMost concepts={TIE} />
      </section>

      <section data-case="two" className="space-y-4" key={`two-${run}`}>
        <h2 className="font-mono text-xs font-medium uppercase tracking-[0.04em] text-ink-3">
          Only two concepts
        </h2>
        <GainMost concepts={TWO} />
      </section>
    </main>
  );
}
