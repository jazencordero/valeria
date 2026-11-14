"use client";

import { useState } from "react";
import { DraftCard } from "@/components/chat/draft-card";
import { Button } from "@/components/ui/button";

/* The prototype's draft (main-flow.html 4258-4265), with the sections the chat is told to write:
   headings, and a conclusion left for her. */
const TITLE = "Assignment3 Forecasting";
const DRAFT = [
  "## Summary",
  "",
  "We forecast weekly demand for products A, B and C for weeks 45 to 52, from 104 weeks of history. Holt-Winters has the lower error for A (6.8%) and B (9.1%). Product C is too erratic for it, and the seasonal naive baseline does better (12.0%). We would trust Holt-Winters for A and B, and the baseline for C.",
  "",
  "## Data and methods",
  "",
  "- `weekly_demand.csv`, 104 weeks per product.",
  "- Holt-Winters with a 52-week season.",
  "- Seasonal naive as the baseline.",
  "",
  "## Results",
  "",
  "MAPE",
  "| Product | Holt-Winters | Seasonal naive |",
  "|---|---|---|",
  "| A | **6.8%** | 11.2% |",
  "| B | **9.1%** | 9.4% |",
  "| C | 14.3% | **12.0%** |",
  "",
  "## Conclusion",
  "",
  "[Your conclusion goes here. Write it in your own words.]",
].join("\n");

function State({ name, note, children }: { name: string; note: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3" data-testid={`state-${name.toLowerCase()}`}>
      <h2 className="type-h22">{name}</h2>
      <p className="ink-2 text-[15px]">{note}</p>
      <div className="max-w-[420px]">{children}</div>
    </section>
  );
}

export default function DraftCardPage() {
  const [handIns, setHandIns] = useState(0);
  const [written, setWritten] = useState(false);
  const handIn = () => setHandIns((n) => n + 1);

  return (
    <main className="mx-auto max-w-3xl space-y-10 px-5 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Draft card</h1>
        <p className="ink-2">
          The draft the chat wrote, as a file-style card. Only shown where the course allows AI. She cannot
          edit the text here; she asks the chat to change it.
        </p>
        <p className="font-mono text-sm ink-3" data-testid="hand-in-count">
          Hand in tapped: {handIns}
        </p>
      </header>

      <State name="Skeleton" note="The draft is still being written. Both buttons are off.">
        <DraftCard title={TITLE} onHandIn={handIn} />
      </State>

      <State name="Outline" note="The draft's headings. Read it opens the full text.">
        <DraftCard title={TITLE} markdown={DRAFT} onHandIn={handIn} />
      </State>

      <State name="Expanded" note="The full text under the outline. Hide closes it.">
        <DraftCard title={TITLE} markdown={DRAFT} defaultExpanded onHandIn={handIn} />
      </State>

      <State name="Live" note="From skeleton to outline, as it happens in the chat.">
        <div className="space-y-3">
          <Button variant="secondary" size="sm" onClick={() => setWritten((now) => !now)} data-testid="toggle-written">
            {written ? "Back to skeleton" : "Finish writing"}
          </Button>
          <DraftCard title={TITLE} markdown={written ? DRAFT : undefined} onHandIn={handIn} />
        </div>
      </State>

      <State name="Long title, no headings" note="A long name wraps; without headings the first line stands in.">
        <DraftCard
          title="Essay 1: Osmosis in plant cells and what turgor pressure does to a wilting leaf"
          markdown="Osmosis moves water across a membrane towards the side with more solute. In a plant cell this builds turgor pressure."
          onHandIn={handIn}
        />
      </State>
    </main>
  );
}
