"use client";

/**
 * Preview for M3-26, the concept path. Made-up concepts: three (a short exam)
 * and eight (every tone: not started, sky, butter, mint, with a crown on the
 * exam-ready one). Each is shown at 360 and 760 px. Tap a node, or tab to the
 * path and use the arrow keys and Enter.
 */
import { useState } from "react";
import { DoodleDefs } from "@/components/doodle";
import { ConceptPath, type PathConcept } from "@/components/study/concept-path";
import { Button } from "@/components/ui/button";
import { focusConcept } from "@/lib/study/ladder";

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

const THREE: PathConcept[] = [
  { id: "c1", name: "Data governance", lecture: 1, weight: 0.3, mastery: 0.93 },
  { id: "c2", name: "Contract terms", lecture: 2, weight: 0.3, mastery: 0.48 },
  { id: "c3", name: "Value of data", lecture: 3, weight: 0.4, mastery: 0 },
];

const EIGHT: PathConcept[] = [
  { id: "e1", name: "Data governance", lecture: 1, weight: 0.1, mastery: 0.95 },
  { id: "e2", name: "Decision rights", lecture: 1, weight: 0.1, mastery: 0.8 },
  { id: "e3", name: "Sourcing models", lecture: 2, weight: 0.15, mastery: 0.62 },
  { id: "e4", name: "Contract terms", lecture: 3, weight: 0.1, mastery: 0.5 },
  { id: "e5", name: "Value of data", lecture: 4, weight: 0.2, mastery: 0.35 },
  { id: "e6", name: "Time series", lecture: 5, weight: 0.15, mastery: 0.1 },
  { id: "e7", name: "Difference in differences", lecture: 6, weight: 0.1, mastery: 0 },
  { id: "e8", name: "Reading a chart", lecture: 7, weight: 0.1, mastery: 0 },
];

const CASES = [
  { name: "Three concepts", concepts: THREE },
  { name: "Eight concepts, every tone", concepts: EIGHT },
] as const;

export default function ConceptPathPage() {
  // Changing the key remounts the paths, so the first-show draw plays again.
  const [run, setRun] = useState(0);
  const [selected, setSelected] = useState<Record<string, string | null>>({});

  return (
    <main className="mx-auto max-w-[800px] space-y-10 bg-paper px-4 py-10 text-ink">
      <DoodleDefs />
      <header className="space-y-3">
        <h1 className="font-display text-2xl">Concept path</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setRun((r) => r + 1)}>
            Replay
          </Button>
          <Button variant="secondary" onClick={() => setTheme("light")}>Light</Button>
          <Button variant="secondary" onClick={() => setTheme("dark")}>Dark</Button>
          <Button variant="secondary" onClick={() => setTheme("system")}>System</Button>
        </div>
      </header>
      {[360, 760].map((w) => (
        <section key={w} className="space-y-10">
          <h2 className="font-mono font-medium uppercase tracking-[0.04em] text-ink-3">{w} wide</h2>
          {CASES.map((c) => {
            const key = `${w}-${c.concepts.length}`;
            const sel = selected[key] ?? null;
            const selName = c.concepts.find((x) => x.id === sel)?.name;
            return (
              <div key={`${key}-${run}`} style={{ maxWidth: w }} data-case={key}>
                <p className="mb-3 text-sm text-ink-3">{c.name}</p>
                <ConceptPath
                  concepts={c.concepts}
                  focusId={focusConcept(c.concepts)?.id ?? null}
                  selectedId={sel}
                  detailsId={`pd-${key}`}
                  onSelect={(id) =>
                    setSelected((s) => ({ ...s, [key]: s[key] === id ? null : id }))
                  }
                />
                <p
                  id={`pd-${key}`}
                  className="mt-4 text-sm text-ink-2"
                  data-selected={sel ?? ""}
                  aria-live="polite"
                >
                  {selName ? `Selected: ${selName}` : "Nothing selected."}
                </p>
              </div>
            );
          })}
        </section>
      ))}
    </main>
  );
}
