"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PhaseStrip } from "@/components/study/phase-strip";

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

const CASES = [
  { name: "Learn, 20 days left", daysLeft: 20, next: "Strengthen starts Tue 24." },
  { name: "Strengthen, 7 days left", daysLeft: 7, next: "Final review starts Tue 17." },
  { name: "Final review, 2 days left", daysLeft: 2, next: "Exam day is Thu 19." },
  { name: "Exam day, 0 days left", daysLeft: 0, next: "" },
] as const;

export default function PhaseStripPage() {
  // Changing the key remounts the strips, so the cap drop-in plays again.
  const [run, setRun] = useState(0);
  return (
    <main className="mx-auto max-w-[760px] space-y-8 bg-paper px-4 py-10 text-ink">
      <header className="space-y-3">
        <h1 className="font-display text-2xl">Phase strip</h1>
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
        <section key={w} className="space-y-6">
          <h2 className="font-mono font-medium uppercase tracking-[0.04em] text-ink-3">{w} wide</h2>
          {CASES.map((c) => (
            <div key={`${c.name}-${run}`} style={{ maxWidth: w }} data-case={c.daysLeft}>
              <p className="mb-2 text-sm text-ink-3">{c.name}</p>
              <PhaseStrip daysLeft={c.daysLeft} next={c.next} />
            </div>
          ))}
        </section>
      ))}
    </main>
  );
}
