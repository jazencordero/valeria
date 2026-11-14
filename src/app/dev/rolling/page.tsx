"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { burst } from "@/components/ui/confetti";
import { RollingNumber } from "@/components/ui/rolling-number";
import { useMotionMode } from "@/lib/motion/use-calm";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="mono ink-3 font-medium uppercase tracking-[0.04em]">{title}</h2>
      {children}
    </section>
  );
}

export default function RollingPage() {
  const mode = useMotionMode();
  const [count, setCount] = useState(128);
  const [pct, setPct] = useState(37);

  return (
    <main className="mx-auto max-w-2xl space-y-10 px-4 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Rolling numbers and confetti</h1>
        <p className="ink-2">
          Changed digits slide up; confetti bursts from the button. With reduced motion neither
          animates.
        </p>
        <p className="mono ink-3" data-testid="motion-mode">
          Motion: {mode}
        </p>
      </header>

      <Section title="Rolling number">
        <div className="flex items-baseline gap-6">
          <span className="type-h30 text-ink" data-testid="count">
            <RollingNumber value={count} />
          </span>
          <span className="type-h26 text-ink" data-testid="pct">
            <RollingNumber value={`${pct}%`} />
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setCount((n) => n + 1)}>
            Add 1
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setCount((n) => n + 7)}>
            Add 7
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setCount((n) => n + 111)}>
            Add 111
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPct((p) => (p >= 90 ? 37 : p + 9))}
          >
            Bump percent
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setCount(9)}>
            Set to 9
          </Button>
        </div>
        <p className="ink-3 text-[13px]">
          Going from 9 to 10 or 999 to 1000 changes the length, so it swaps without a roll.
        </p>
      </Section>

      <Section title="Confetti">
        <Button onClick={(e) => burst(e.currentTarget, 90)}>
          Fire confetti
        </Button>
      </Section>
    </main>
  );
}
