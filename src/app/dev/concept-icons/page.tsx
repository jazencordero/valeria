"use client";

import { Button } from "@/components/ui/button";
import { CONCEPT_ICON_NAMES, ConceptIcon, iconFor } from "@/components/exams/concept-icons";

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

const SAMPLES = [
  "IT governance",
  "Decision rights",
  "Sourcing and vendors",
  "Contracts and SLAs",
  "Data quality",
  "IT value and investment",
  "Time series",
  "Differencing",
  "Control charts",
  "Strategic alignment",
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="mono ink-3 font-medium uppercase tracking-[0.04em]">{title}</h2>
      {children}
    </section>
  );
}

export default function ConceptIconsPage() {
  return (
    <main className="mx-auto max-w-2xl space-y-10 px-4 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Concept icons</h1>
        <p className="ink-2">Nine line icons picked by keyword, and the neutral dot for anything else.</p>
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

      <Section title="Every icon at 16, 22 and 32 px">
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="icons">
          {CONCEPT_ICON_NAMES.map((name) => (
            <li
              key={name}
              className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface p-4 text-ink"
            >
              <div className="flex items-end gap-3">
                <ConceptIcon name={name} />
                <ConceptIcon name={name} size={22} />
                <ConceptIcon name={name} size={32} />
              </div>
              <span className="mono ink-3">{name}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="In a concept tile">
        <ul className="space-y-2" data-testid="samples">
          {SAMPLES.map((concept) => (
            <li key={concept} className="flex items-center gap-3 rounded-2xl bg-surface px-3 py-2">
              <span className="grid size-[26px] flex-none place-items-center rounded-lg bg-accent-wash text-accent">
                <ConceptIcon name={iconFor(concept)} />
              </span>
              <span className="flex-1">{concept}</span>
              <span className="mono ink-3">{iconFor(concept)}</span>
            </li>
          ))}
        </ul>
      </Section>
    </main>
  );
}
