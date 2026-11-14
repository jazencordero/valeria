"use client";

import { DoodleDefs } from "@/components/doodle";
import { BiteCard, type BiteCardProps } from "@/components/study/bite-card";

const STATES: { label: string; props: BiteCardProps }[] = [
  {
    label: "First bite, another follows",
    props: {
      state: "bite",
      minutes: 5,
      cards: 8,
      gain: 4,
      focus: "Sourcing",
      next: { number: 2, of: 2, minutes: 4 },
    },
  },
  {
    label: "One more bite, the last one",
    props: { state: "bite", more: true, minutes: 4, cards: 7, gain: 3, focus: "Sourcing" },
  },
  {
    label: "Plan done",
    props: { state: "done", nextReviews: "Next reviews tomorrow." },
  },
];

const WIDTHS = [360, 760];

export default function BiteCardPreview() {
  return (
    <main className="space-y-10 bg-paper px-4 py-10">
      <DoodleDefs />
      <header className="mx-auto max-w-[760px] space-y-1">
        <h1 className="type-h26 text-ink">Today&rsquo;s bite</h1>
        <p className="text-[14px] text-ink-2">
          The bite block on the exam page: first bite, one more bite, and plan done, at 360 and
          760 px.
        </p>
      </header>
      {WIDTHS.map((w) => (
        <section key={w} className="space-y-4" aria-label={`${w} px wide`}>
          <h2 className="mono mx-auto max-w-[760px] text-ink-3 [font-variation-settings:normal]">
            {w} PX
          </h2>
          {STATES.map((s) => (
            <div key={s.label} className="mx-auto w-full space-y-2" style={{ maxWidth: w }}>
              <p className="mono text-ink-3">{s.label}</p>
              <BiteCard {...s.props} />
            </div>
          ))}
        </section>
      ))}
    </main>
  );
}
