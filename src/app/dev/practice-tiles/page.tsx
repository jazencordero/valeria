"use client";

import { useState } from "react";
import { DoodleDefs } from "@/components/doodle";
import { PracticeTiles, type PracticeType } from "@/components/study/practice-tiles";

const COUNTS: Record<PracticeType, number> = { basic: 24, cloze: 12, explain: 0, mcq: 9 };

const WIDTHS = [360, 1000];

export default function PracticeTilesPreview() {
  const [started, setStarted] = useState<string | null>(null);
  return (
    <main className="space-y-10 bg-paper px-4 py-10">
      <DoodleDefs />
      <header className="mx-auto max-w-[1000px] space-y-1">
        <h1 className="type-h26 text-ink">Ways to practise</h1>
        <p className="text-[14px] text-ink-2">
          Four practice tiles at 360 and 1000 px. Explain it has no cards, so it shows its note.
          Press another tile to start it; hover a tile on a wide screen to wiggle its doodle.
        </p>
        <p className="mono text-ink-3" aria-live="polite">
          {started ? `Started: ${started}` : "Nothing started yet"}
        </p>
      </header>
      {WIDTHS.map((w) => (
        <section key={w} className="space-y-4" aria-label={`${w} px wide`}>
          <h2 className="mono mx-auto max-w-[1000px] text-ink-3 [font-variation-settings:normal]">
            {w} PX
          </h2>
          <div className="mx-auto w-full" style={{ maxWidth: w }}>
            <PracticeTiles counts={COUNTS} initialNote="explain" onStart={setStarted} />
          </div>
        </section>
      ))}
    </main>
  );
}
