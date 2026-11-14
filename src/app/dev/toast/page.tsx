"use client";

import { Button } from "@/components/ui/button";
import { Toaster, clearToast, showToast } from "@/components/ui/toast";
import { useMotionMode } from "@/lib/motion/use-calm";

const samples = [
  "Added to Sample Course. First review today.",
  "Saved.",
  "Card added. First review today.",
];

export default function ToastPreview() {
  const mode = useMotionMode();
  return (
    <main className="mx-auto max-w-xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="type-h26 font-display text-ink">Toast</h1>
        <p className="text-[14px] text-ink-2">
          One dark pill at the bottom centre. Rises in 200 ms, stays 2.6 s,
          fades in 200 ms. A newer toast replaces the older one. Motion mode:{" "}
          <span className="font-mono">{mode}</span>
        </p>
      </header>

      <section className="space-y-3">
        <p className="text-[14px] text-ink-2">Show one:</p>
        <div className="flex flex-wrap gap-2">
          {samples.map((text) => (
            <Button key={text} size="sm" onClick={() => showToast(text)}>
              {text}
            </Button>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-[14px] text-ink-2">
          Replace: shows one, then another 1 s later.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              showToast("First toast.");
              setTimeout(() => showToast("Second toast replaces it."), 1000);
            }}
          >
            Show two in a row
          </Button>
          <Button size="sm" variant="secondary" onClick={() => clearToast()}>
            Clear
          </Button>
        </div>
      </section>

      <Toaster />
    </main>
  );
}
