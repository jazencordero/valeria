"use client";

import { useState } from "react";
import { Bar } from "@/components/ui/bar";
import { Button } from "@/components/ui/button";
import { Ring, type RingSize } from "@/components/ui/ring";
import { Pips, RUNG_NAMES, RungDot } from "@/components/study/pips";

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

const SIZES: RingSize[] = [36, 48, 76, 92];
const VALUES = [0, 37, 100];
const RUNGS = [0, 1, 2, 3, 4, 5];

const TOPICS = [
  ["Exponential smoothing", 0.82],
  ["ARIMA models", 0.37],
  ["Forecast accuracy", 0.12],
] as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="mono ink-3 font-medium uppercase tracking-[0.04em]">{title}</h2>
      {children}
    </section>
  );
}

export default function RingsPage() {
  // Changing the key remounts everything, so the draw-in plays again.
  const [run, setRun] = useState(0);

  return (
    <main className="mx-auto max-w-2xl space-y-10 px-4 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Rings, bars and rung pips</h1>
        <p className="ink-2">Progress ring in four sizes, the thin bar, and rung pips 0 to 5.</p>
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
        </div>
      </header>

      <div key={run} className="space-y-10">
        <Section title="Ring">
          <div
            className="grid grid-cols-[auto_repeat(3,minmax(0,1fr))] items-center gap-x-4 gap-y-5"
            data-testid="rings"
          >
            <span />
            {VALUES.map((v) => (
              <span key={v} className="mono ink-3">
                {v}%
              </span>
            ))}
            {SIZES.map((size) => (
              <div key={size} className="contents">
                <span className="mono ink-3">{size}px</span>
                {VALUES.map((v) => (
                  <span key={v}>
                    <Ring value={v} size={size} />
                  </span>
                ))}
              </div>
            ))}
          </div>
        </Section>

        <Section title="Bar">
          <div className="grid gap-3" data-testid="bars">
            {TOPICS.map(([name, v]) => (
              <div key={name}>
                <div className="flex justify-between text-[13px] text-ink">
                  <span>{name}</span>
                  <span className="mono ink-2">{Math.round(v * 100)}%</span>
                </div>
                <Bar value={v} label={name} className="mt-1.5" />
              </div>
            ))}
          </div>
        </Section>

        <Section title="Rung pips">
          <ul className="grid gap-2.5" data-testid="pips">
            {RUNGS.map((r) => (
              <li key={r} className="grid grid-cols-[20px_auto_auto_1fr] items-center gap-3">
                <RungDot rung={r} title={RUNG_NAMES[r]} />
                <Pips rung={r} />
                <Pips rung={r} size="sm" />
                <span className="mono ink-2">
                  {r} {RUNG_NAMES[r]}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Rung pips: just climbed">
          <div className="flex items-center gap-3">
            <Pips rung={4} newFrom={2} />
            <span className="mono ink-2">Fill the gap to Explain it</span>
          </div>
        </Section>

        <Section title="Rung pips: inverse">
          <div className="inline-flex items-center gap-2 rounded-full bg-[var(--btn)] px-3 py-2 text-[13px] text-[var(--btn-ink)]">
            <span>
              Exponential smoothing climbed to <b>Recall</b>
            </span>
            <Pips rung={3} size="sm" tone="inverse" />
          </div>
        </Section>
      </div>
    </main>
  );
}
