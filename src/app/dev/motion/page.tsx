"use client";

import { motion } from "motion/react";
import { useState } from "react";
import { presets } from "@/lib/motion/transitions";
import { useMotionMode } from "@/lib/motion/use-calm";

const NAMES = ["rise", "fade", "pop", "sheetUp"] as const;
type Name = (typeof NAMES)[number];

const NOTES: Record<Name, string> = {
  rise: "Content arriving. 280 ms, out.",
  fade: "Plain fade. 180 ms, out.",
  pop: "Rewards only. Reward spring.",
  sheetUp: "Bottom sheet. 520 ms, in-out.",
};

function Demo({ name, run }: { name: Name; run: number }) {
  const mode = useMotionMode();
  const [took, setTook] = useState<number | null>(null);
  const [startedAt] = useState(() => performance.now());

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="type-h22">{name}</h2>
        <span
          className="font-mono text-sm ink-3"
          data-testid={`took-${name}`}
          data-run={run}
        >
          {took === null ? "running" : `done in ${took} ms`}
        </span>
      </div>
      <p className="ink-2">{NOTES[name]}</p>
      <div className="relative h-28 overflow-hidden rounded-2xl border border-line bg-paper">
        <motion.div
          {...presets[name](mode)}
          onAnimationComplete={() =>
            setTook(Math.round(performance.now() - startedAt))
          }
          className={
            name === "sheetUp"
              ? "absolute inset-x-0 bottom-0 h-20 rounded-t-2xl bg-surface shadow-[var(--shadow-sheet)]"
              : "absolute left-1/2 top-1/2 size-16 -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-accent"
          }
        />
      </div>
    </div>
  );
}

export default function MotionPage() {
  const mode = useMotionMode();
  const [run, setRun] = useState(0);

  return (
    <main className="mx-auto max-w-3xl space-y-10 px-5 py-10">
      <header className="space-y-2">
        <h1 className="type-h30">Motion</h1>
        <p className="ink-2">
          Mode: <strong data-testid="motion-mode">{mode}</strong>. Turn on
          reduced motion in the OS for calm 150 ms fades, or add{" "}
          <code className="font-mono">?fast=1</code> to finish everything at
          once.
        </p>
        <button
          type="button"
          onClick={() => setRun((r) => r + 1)}
          className="rounded-full bg-[var(--btn)] px-5 py-2 text-[var(--btn-ink)]"
        >
          Replay
        </button>
      </header>

      {NAMES.map((name) => (
        <Demo key={`${name}-${run}-${mode}`} name={name} run={run} />
      ))}
    </main>
  );
}
