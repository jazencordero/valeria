"use client";

import { useEffect, useRef, useState } from "react";
import { Greeting } from "@/components/home/greeting";
import { Button } from "@/components/ui/button";
import { useMotionMode } from "@/lib/motion/use-calm";

const SENTENCES = [
  "Hi Valeria. One thing is due tonight, then you are clear until Tuesday.",
  "Nice. Statistics forecast is up to 74%.",
  "Morning. Nothing is due today. A good day to get ahead on the essay.",
] as const;

function clearTyped() {
  try {
    window.sessionStorage.removeItem("ready.greeting.typed");
  } catch {
    // Storage blocked: nothing to clear.
  }
}

export default function GreetingPage() {
  const mode = useMotionMode();
  const [index, setIndex] = useState(0);
  const [look, setLook] = useState("0");
  const box = useRef<HTMLDivElement>(null);

  // Read the eye offset off the greeting's data-look, for checking.
  useEffect(() => {
    const root = box.current?.querySelector<HTMLElement>("[data-look]");
    if (!root) return;
    const read = () => setLook(root.dataset.look ?? "0");
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["data-look"] });
    return () => observer.disconnect();
  }, []);

  return (
    <main className="mx-auto max-w-xl space-y-8 px-5 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Greeting</h1>
        <p className="ink-2">
          Vitonen greets on Home. The first time a sentence shows in this tab
          the bubble springs in and types; a new sentence types again. On a
          wide screen with a mouse, the eyes look toward the pointer&apos;s half
          of the screen. With reduced motion on, nothing moves.
        </p>
        <p className="font-mono text-sm ink-3" data-testid="motion-mode">
          motion: {mode}
        </p>
        <p className="font-mono text-sm ink-3" data-testid="look-readout">
          eyes: {look} px
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setIndex((i) => (i + 1) % SENTENCES.length)}
            data-testid="next-sentence"
          >
            Change the sentence
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              clearTyped();
              window.location.reload();
            }}
          >
            Forget and reload
          </Button>
        </div>
      </header>

      <div ref={box} className="rounded-[20px] bg-paper p-4">
        <Greeting sentence={SENTENCES[index]} />
      </div>
    </main>
  );
}
