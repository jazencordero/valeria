"use client";

import { useRef, useState } from "react";
import { SECTION_LABEL, SessionFrame, type SessionFrameHandle } from "@/components/session/frame";
import { Button } from "@/components/ui/button";
import { useMotionMode } from "@/lib/motion/use-calm";
import type { SectionKind } from "@/lib/study/bite";

const SECTIONS: SectionKind[] = ["warm", "warm", "learn", "learn", "learn", "learn", "boss"];

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export default function SessionFramePage() {
  const mode = useMotionMode();
  const frame = useRef<SessionFrameHandle>(null);
  const [open, setOpen] = useState(true);
  const [stops, setStops] = useState(0);
  const [cards, setCards] = useState(() => SECTIONS.map((section) => ({ section })));
  const [index, setIndex] = useState(2);
  const [streak, setStreak] = useState(0);

  const current = cards[Math.min(index, cards.length - 1)];

  const reopen = () => {
    setCards(SECTIONS.map((section) => ({ section })));
    setIndex(2);
    setStreak(0);
    setOpen(true);
  };

  const pass = () => {
    setIndex((i) => Math.min(cards.length, i + 1));
    setStreak((n) => n + 1);
    frame.current?.react("nod");
  };

  const miss = () => {
    // A miss goes back in the pile: one more segment.
    setCards((c) => [...c.slice(0, index + 2), { section: current.section }, ...c.slice(index + 2)]);
    setIndex((i) => Math.min(cards.length + 1, i + 1));
    setStreak(0);
    frame.current?.miss();
    frame.current?.react("wince");
  };

  if (!open) {
    return (
      <main className="mx-auto max-w-4xl space-y-6 px-5 py-10">
        <h1 className="type-h30">Session frame</h1>
        <p className="ink-2">Stopped {stops} time{stops === 1 ? "" : "s"}.</p>
        <Button onClick={reopen}>Open the frame again</Button>
      </main>
    );
  }

  return (
    <SessionFrame
      ref={frame}
      cards={cards}
      index={index}
      counts={{ new: 3, learning: 2, due: 2 }}
      streak={streak}
      hint="Space to reveal · 1–4 to grade"
      onStop={() => {
        setStops((n) => n + 1);
        setOpen(false);
      }}
      actions={
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={miss} data-testid="demo-miss-card">
            Missed
          </Button>
          <Button onClick={pass} data-testid="demo-pass-card">
            Got it
          </Button>
        </div>
      }
    >
      <div className="mt-10 space-y-6 rounded-3xl border border-solid border-line bg-surface p-6 shadow-[var(--shadow-card)]">
        <p className="mono ink-3">{SECTION_LABEL[current.section]} · SUPPLY + DEMAND</p>
        <h1 className="font-display text-[24px] leading-tight font-semibold">Session frame</h1>
        <p className="ink-2 text-[15px]">
          Close or Escape opens the stop confirm; Escape again closes it. The cap peeked in
          at the start. Everything behind the frame is inert, so the demo controls live here.
        </p>
        <p className="font-mono text-sm ink-3" data-testid="motion-mode">
          motion: {mode} · stopped {stops}
        </p>

        <div className="space-y-2">
          <p className="mono ink-3">TOASTS</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => frame.current?.miss()} data-testid="toast-miss">
              Miss toast
            </Button>
            <Button
              size="sm"
              onClick={() => {
                frame.current?.climb("Price elasticity", 3);
                frame.current?.react("cheer");
              }}
              data-testid="toast-climb"
            >
              Climb toast
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <p className="mono ink-3">IN A ROW</p>
          <div className="flex flex-wrap gap-2">
            {[0, 2, 4, 5, 10].map((n) => (
              <Button
                key={n}
                size="sm"
                variant={streak === n ? "primary" : "secondary"}
                onClick={() => setStreak(n)}
                data-testid={`pill-${n}`}
              >
                {n === 0 ? "Hide pill" : `Pill at ${n}`}
              </Button>
            ))}
            <Button size="sm" variant="secondary" onClick={() => setStreak((n) => n + 1)}>
              +1
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <p className="mono ink-3">THEME</p>
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
          </div>
        </div>
      </div>
    </SessionFrame>
  );
}
