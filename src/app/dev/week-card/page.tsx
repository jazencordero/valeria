"use client";

import { useRef } from "react";
import { WeekCard, type WeekCardHandle } from "@/components/home/week-card";
import { Button } from "@/components/ui/button";
import { weekModel, type WeekItem } from "@/lib/home/week";

// Saturday 14 November 2026, 15:48 in Helsinki, as in the prototype.
const NOW = new Date("2026-11-14T13:48:00Z");

const STATES: { label: string; items: WeekItem[] }[] = [
  {
    label: "Busy week (the prototype): due today, deadlines Tue and Thu, exam Fri",
    items: [
      { id: "a", kind: "deadline", title: "Reading response", at: "2026-11-14T19:00:00Z", done: false },
      { id: "b", kind: "deadline", title: "Case memo 2", at: "2026-11-17T21:59:00Z", done: false },
      { id: "c", kind: "deadline", title: "Service blueprint draft", at: "2026-11-19T10:00:00Z", done: false },
      { id: "d", kind: "exam", title: "Exam", at: "2026-11-20T07:00:00Z", done: false },
    ],
  },
  {
    label: "Empty week",
    items: [],
  },
  {
    label: "A done item (Monday), one quiz Wednesday",
    items: [
      { id: "e", kind: "deadline", title: "Case memo 1", at: "2026-11-16T21:59:00Z", done: true },
      { id: "f", kind: "quiz", title: "Quiz 4", at: "2026-11-18T10:00:00Z", done: false },
    ],
  },
  {
    label: "An exam only (nothing to hand in)",
    items: [{ id: "g", kind: "exam", title: "Marketing exam", at: "2026-11-18T08:00:00Z", done: false }],
  },
  {
    label: "Only today has something due (no line)",
    items: [{ id: "h", kind: "deadline", title: "Reading response", at: "2026-11-14T19:00:00Z", done: false }],
  },
];

const WIDTHS = [360, 760];

export default function WeekCardPreview() {
  const refs = useRef<(WeekCardHandle | null)[]>([]);
  const pulseAll = () => refs.current.forEach((r) => r?.pulse());

  return (
    <main className="space-y-10 bg-paper px-4 py-10">
      <header className="mx-auto max-w-[760px] space-y-3">
        <h1 className="type-h26 text-ink">This week</h1>
        <p className="text-[14px] text-ink-2">
          The week card on Home: busy week, empty week, a done item, an exam and today only, at
          360 and 760 px. Now is SAT 14 NOV 15:48. Pulse does nothing with reduced motion.
        </p>
        <Button variant="secondary" size="sm" onClick={pulseAll}>
          Pulse markers
        </Button>
      </header>
      {WIDTHS.map((w, wi) => (
        <section key={w} className="space-y-4" aria-label={`${w} px wide`}>
          <h2 className="mono mx-auto max-w-[760px] text-ink-3 [font-variation-settings:normal]">
            {w} PX
          </h2>
          {STATES.map((s, si) => (
            <div key={s.label} className="mx-auto w-full space-y-2" style={{ maxWidth: w }}>
              <p className="mono text-ink-3">{s.label}</p>
              <WeekCard
                week={weekModel(s.items, NOW)}
                ref={(h) => {
                  refs.current[wi * STATES.length + si] = h;
                }}
              />
            </div>
          ))}
        </section>
      ))}
    </main>
  );
}
