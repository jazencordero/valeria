"use client";

/**
 * Preview for M3-27, the concept detail. Made-up concepts. Fixed cases: rung 0,
 * rung 2 and rung 5, and the disabled button in both wordings ("come with
 * lecture 6" and "still being made"). Below them, the path and the detail
 * together: tap a node to open it, another to cross-fade, the same to close.
 */
import { useState } from "react";
import { DoodleDefs } from "@/components/doodle";
import { ConceptDetail, practiseMinutes, type DetailConcept } from "@/components/study/concept-detail";
import { ConceptPath } from "@/components/study/concept-path";
import { Button } from "@/components/ui/button";
import { focusConcept } from "@/lib/study/ladder";

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

type Case = {
  key: string;
  label: string;
  concept: DetailConcept;
  cards: number;
  cardsLecture?: number;
};

const CASES: Case[] = [
  {
    key: "rung0",
    label: "Rung 0, not started",
    concept: { id: "c-r0", name: "Value of data", lecture: 5, weight: 0.2, mastery: 0.12 },
    cards: 3,
  },
  {
    key: "rung2",
    label: "Rung 2, fill the gap",
    concept: { id: "c-r2", name: "Contract terms", lecture: 3, weight: 0.15, mastery: 0.48 },
    cards: 6,
  },
  {
    key: "rung5",
    label: "Rung 5, exam-ready",
    concept: { id: "c-r5", name: "Data governance", lecture: 1, weight: 0.1, mastery: 0.93 },
    cards: 1,
  },
  {
    key: "disabled-lecture",
    label: "No cards yet, they come with a later lecture",
    concept: { id: "c-d1", name: "Difference in differences", lecture: 6, weight: 0.1, mastery: 0 },
    cards: 0,
    cardsLecture: 6,
  },
  {
    key: "disabled-made",
    label: "No cards yet, still being made",
    concept: { id: "c-d2", name: "Reading a chart", lecture: 4, weight: 0.05, mastery: 0 },
    cards: 0,
  },
];

const PATH = CASES.map((c) => c.concept).sort((a, b) => a.lecture - b.lecture);

function caseOf(id: string | null): Case | undefined {
  return CASES.find((c) => c.concept.id === id);
}

export default function ConceptDetailPage() {
  const [run, setRun] = useState(0);
  const [selected, setSelected] = useState<string | null>(PATH[2].id);
  const [practised, setPractised] = useState<string | null>(null);
  const sel = caseOf(selected);

  return (
    <main className="mx-auto max-w-[480px] space-y-10 bg-paper px-4 py-10 text-ink">
      <DoodleDefs />
      <header className="space-y-3">
        <h1 className="font-display text-2xl">Concept detail</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setRun((r) => r + 1)}>
            Replay
          </Button>
          <Button variant="secondary" onClick={() => setTheme("light")}>Light</Button>
          <Button variant="secondary" onClick={() => setTheme("dark")}>Dark</Button>
          <Button variant="secondary" onClick={() => setTheme("system")}>System</Button>
        </div>
        <p className="text-sm text-ink-3" aria-live="polite" data-practised={practised ?? ""}>
          {practised ? `Practise pressed: ${caseOf(practised)?.concept.name}` : "Nothing practised yet."}
        </p>
      </header>

      {CASES.map((c) => (
        <section key={`${c.key}-${run}`} data-case={c.key} className="space-y-1">
          <h2 className="font-mono text-xs font-medium uppercase tracking-[0.04em] text-ink-3">
            {c.label}
          </h2>
          <ConceptDetail
            concept={c.concept}
            minutes={practiseMinutes(c.cards)}
            cardsLecture={c.cardsLecture}
            lectureHref={`/dev/concept-detail#lecture-${c.concept.lecture}`}
            onPractise={setPractised}
          />
        </section>
      ))}

      <section data-case="path" className="space-y-3">
        <h2 className="font-mono text-xs font-medium uppercase tracking-[0.04em] text-ink-3">
          With the path: open, cross-fade, close
        </h2>
        <ConceptPath
          concepts={PATH}
          focusId={focusConcept(PATH)?.id ?? null}
          selectedId={selected}
          detailsId="pd-live"
          onSelect={(id) => setSelected((s) => (s === id ? null : id))}
        />
        <ConceptDetail
          id="pd-live"
          concept={sel?.concept ?? null}
          minutes={sel ? practiseMinutes(sel.cards) : null}
          cardsLecture={sel?.cardsLecture}
          lectureHref={sel ? `/dev/concept-detail#lecture-${sel.concept.lecture}` : undefined}
          onPractise={setPractised}
        />
      </section>
    </main>
  );
}
