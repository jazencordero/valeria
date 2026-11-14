"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ForecastChart, type ForecastChartData } from "@/components/study/forecast-chart";
import { Sparkline } from "@/components/study/sparkline";

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/** 13 days before today, easing from `from` up to just under `to`. */
function ramp(from: number, to: number, wobble = 2): number[] {
  return Array.from({ length: 13 }, (_, i) => {
    const t = i / 13;
    const w = ((i * 7) % 5) - 2;
    return Math.round((from + (to - from) * t * t + (w * wobble) / 2) * 10) / 10;
  });
}

type Case = { name: string; data: ForecastChartData };

const CASES: Case[] = [
  {
    name: "35% forecast, 9 days left",
    data: { history: ramp(8, 33), forecast: 35, daysLeft: 9, target: 80, examDay: "DEC 12" },
  },
  {
    name: "64% forecast, 12 days left",
    data: { history: ramp(30, 61), forecast: 64, daysLeft: 12, target: 80, examDay: "DEC 15" },
  },
  {
    name: "88% forecast, 5 days left",
    data: { history: ramp(55, 86), forecast: 88, daysLeft: 5, target: 80, examDay: "DEC 8" },
  },
  {
    name: "Edge: 82% next to the target, 2 days left",
    data: { history: ramp(60, 81, 1), forecast: 82, daysLeft: 2, target: 80, examDay: "DEC 5" },
  },
  {
    name: "Edge: 20% forecast, 1 day left, target 60%",
    data: { history: ramp(0, 18, 1), forecast: 20, daysLeft: 1, target: 60, examDay: "TOMORROW" },
  },
];

const WIDTHS = [360, 760];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="font-mono text-ink-3 font-medium uppercase tracking-[0.04em]">{title}</h2>
      {children}
    </section>
  );
}

export default function ForecastChartPage() {
  // Changing the key remounts the charts, so the first-show motion plays again.
  const [run, setRun] = useState(0);

  return (
    <main className="space-y-12 px-4 py-10">
      <header className="mx-auto max-w-2xl space-y-3">
        <h1 className="type-h30">Sparkline and the forecast chart</h1>
        <p className="text-ink-2">
          History, a bite a day, if you stop, the target and exam day. Each forecast at 360 and
          760 px wide.
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
        </div>
      </header>

      <div key={run} className="space-y-14">
        {CASES.map(({ name, data }) => (
          <Section key={name} title={name}>
            <div className="flex items-end gap-3">
              <Sparkline
                history={data.history}
                forecast={data.forecast}
                daysLeft={data.daysLeft}
                target={data.target}
              />
              <span className="font-mono text-[12px] text-ink-3">sparkline 132 × 40</span>
            </div>
            <div className="flex flex-wrap items-start gap-8">
              {WIDTHS.map((w) => (
                <div
                  key={w}
                  data-width={w}
                  className="max-w-full rounded-2xl border border-line bg-surface p-4"
                  style={{ width: w + 34 }}
                >
                  <p className="mb-2 font-mono text-[12px] text-ink-3">{w} px</p>
                  <ForecastChart {...data} style={{ width: w, maxWidth: "100%" }} />
                </div>
              ))}
            </div>
          </Section>
        ))}
      </div>
    </main>
  );
}
