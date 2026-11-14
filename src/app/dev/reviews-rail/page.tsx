"use client";

import { Button } from "@/components/ui/button";
import { Heatmap, type HeatDay } from "@/components/study/heatmap";
import { NextReviews, type ReviewDay } from "@/components/study/next-reviews";

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

const REVIEWS: ReviewDay[] = [
  { label: "Today", count: 6 },
  { label: "Tomorrow", count: 4 },
  { label: "Tue 17", count: 3 },
  { label: "Thu 19", count: 5, note: "last pass" },
];

// Sun 1 Nov to Sat 14 Nov, today last. Counts cover every opacity step.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const COUNTS = [0, 4, 7, 0, 9, 12, 5, 0, 3, 6, 14, 0, 8, 1];
const HEAT: HeatDay[] = COUNTS.map((count, i) => ({
  label: `${WEEKDAYS[i % 7]} ${i + 1} Nov`,
  count,
}));
const HEAT_EMPTY: HeatDay[] = HEAT.map((d) => ({ ...d, count: 0 }));

const CASES = [
  { name: "With sample data", reviews: REVIEWS, heat: HEAT },
  { name: "No data", reviews: [] as ReviewDay[], heat: HEAT_EMPTY },
];

export default function ReviewsRailPage() {
  return (
    <main className="mx-auto max-w-[760px] space-y-8 bg-paper px-4 py-10 text-ink">
      <header className="space-y-3">
        <h1 className="font-display text-2xl">Reviews rail</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setTheme("light")}>Light</Button>
          <Button variant="secondary" onClick={() => setTheme("dark")}>Dark</Button>
          <Button variant="secondary" onClick={() => setTheme("system")}>System</Button>
        </div>
      </header>
      {CASES.map((c) => (
        <section key={c.name} className="space-y-3" data-case={c.name}>
          <h2 className="font-mono font-medium uppercase tracking-[0.04em] text-ink-3">{c.name}</h2>
          <div className="flex flex-wrap gap-6">
            {[320, 480].map((w) => (
              <div key={w} className="flex w-full flex-col gap-4" style={{ maxWidth: w }}>
                <p className="text-sm text-ink-3">{w} wide</p>
                <NextReviews days={c.reviews} />
                <Heatmap days={c.heat} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
