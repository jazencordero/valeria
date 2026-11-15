"use client";

import { useState } from "react";
import { CardBasic } from "@/components/session/card-basic";
import { CardCloze } from "@/components/session/card-cloze";
import { revealHint } from "@/components/session/card-head";
import { SessionFrame } from "@/components/session/frame";
import { DoodleDefs } from "@/components/doodle";
import { Button } from "@/components/ui/button";
import { useMotionMode } from "@/lib/motion/use-calm";
import type { SectionKind } from "@/lib/study/bite";

// Made-up sample content.
type Sample =
  | { id: string; title: string; type: "basic"; section: SectionKind; names: string[]; rung: number; q: string; a: string; source: string; why?: string }
  | { id: string; title: string; type: "cloze"; section: SectionKind; names: string[]; rung: number; q: string; source: string; why?: string };

const SAMPLES: Sample[] = [
  {
    id: "basic-learn",
    title: "Recall, new",
    type: "basic",
    section: "learn",
    names: ["Price elasticity"],
    rung: 2,
    q: "What does a price elasticity of demand of −2 tell you?",
    a: "A 1% rise in price cuts the quantity demanded by about 2%. Demand is elastic.",
    source: "Lecture 3, slide 9",
  },
  {
    id: "basic-warm",
    title: "Recall, warm-up",
    type: "basic",
    section: "warm",
    names: ["Opportunity cost"],
    rung: 4,
    q: "Define opportunity cost in one sentence.",
    a: "The value of the best alternative you give up when you choose something.",
    source: "Lecture 1, slide 4",
  },
  {
    id: "basic-boss",
    title: "Recall, boss question",
    type: "basic",
    section: "boss",
    names: ["Supply", "Demand"],
    rung: 3,
    q: "A frost destroys half the orange crop. What happens to the price and quantity of orange juice, and why?",
    a: "Supply shifts left, so the price rises and the quantity sold falls. Demand has not moved; only supply has.",
    source: "Lecture 4, slide 12",
  },
  {
    id: "cloze-learn",
    title: "Fill the gap, three blanks",
    type: "cloze",
    section: "learn",
    names: ["Price elasticity"],
    rung: 1,
    q: "Demand is {{price elastic}} when the quantity demanded changes by a larger percentage than the {{price}}, which is common for {{luxury goods}}.",
    source: "Lecture 3, slide 11",
  },
  {
    id: "cloze-warm",
    title: "Fill the gap, one blank",
    type: "cloze",
    section: "warm",
    names: ["Marginal cost"],
    rung: 0,
    q: "The cost of making one more unit is called the {{marginal cost}}.",
    source: "Lecture 5, slide 2",
  },
  {
    id: "basic-model",
    title: "Recall, multi-line answer with a why",
    type: "basic",
    section: "learn",
    names: ["Linear programming"],
    rung: 2,
    q: "Write the model for the bakery: bread earns 3, cake earns 2, the oven has 4 hours, the mixer 6.",
    a: "max z = 3x + 2y\nsubject to x + y \u2264 4 (oven)\nx + 3y \u2264 6 (mixer)\nx \u2264 3 (flour)\nx \u2265 0\ny \u2265 0",
    why: "The objective adds up what each product earns.\nEach resource gives one constraint.\nThe last two rule out negative amounts.",
    source: "Lecture 6, slide 8",
  },
  {
    id: "cloze-why",
    title: "Fill the gap, with a why",
    type: "cloze",
    section: "learn",
    names: ["Linear programming"],
    rung: 1,
    q: "A constraint that holds with equality at the optimum is called {{binding}}.",
    why: "Its resource is used up completely.\nLoosening it would improve the objective.",
    source: "Lecture 6, slide 12",
  },
];

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

function SampleCard({
  s,
  keyboard,
  autoFocus,
  actionsEl,
  onRevealed,
}: {
  s: Sample;
  keyboard: boolean;
  autoFocus?: boolean;
  actionsEl?: Element | null;
  onRevealed: () => void;
}) {
  const common = {
    section: s.section,
    conceptNames: s.names,
    rung: s.rung,
    keyboard,
    autoFocus,
    actionsEl,
    onRevealed,
  };
  return s.type === "basic" ? (
    <CardBasic card={{ q: s.q, a: s.a, source: s.source, why: s.why }} {...common} />
  ) : (
    <CardCloze card={{ q: s.q, source: s.source, why: s.why }} {...common} />
  );
}

export default function SessionCardsAPage() {
  const mode = useMotionMode();
  const [spaceOn, setSpaceOn] = useState(SAMPLES[0].id);
  const [runs, setRuns] = useState<Record<string, number>>({});
  const [fired, setFired] = useState<Record<string, number>>({});
  const [framed, setFramed] = useState<string | null>(null);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const [frameRevealed, setFrameRevealed] = useState(false);
  const [frameRun, setFrameRun] = useState(0);
  const nextInFrame = () => {
    setFrameRevealed(false);
    setFrameRun((n) => n + 1);
  };

  const reset = (id: string) => {
    setRuns((r) => ({ ...r, [id]: (r[id] ?? 0) + 1 }));
    setFired((f) => ({ ...f, [id]: 0 }));
  };
  const markFired = (id: string) => setFired((f) => ({ ...f, [id]: (f[id] ?? 0) + 1 }));

  const framedSample = SAMPLES.find((s) => s.id === framed);
  if (framedSample) {
    return (
      <SessionFrame
        cards={[{ section: framedSample.section }]}
        index={0}
        counts={{ new: 1, learning: 0, due: 0 }}
        hint={revealHint()}
        onStop={() => {
          setFramed(null);
          setFrameRevealed(false);
        }}
        actions={
          <div ref={setFooter}>
            {frameRevealed ? (
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" onClick={nextInFrame}>
                  Missed
                </Button>
                <Button onClick={nextInFrame}>Got it</Button>
              </div>
            ) : null}
          </div>
        }
      >
        <SampleCard
          key={`${framedSample.id}-${frameRun}-frame`}
          s={framedSample}
          keyboard
          autoFocus
          actionsEl={footer}
          onRevealed={() => setFrameRevealed(true)}
        />
      </SessionFrame>
    );
  }

  return (
    <main className="mx-auto max-w-[688px] space-y-10 px-4 py-10">
      <DoodleDefs />
      <header className="space-y-3">
        <h1 className="type-h30">Session cards: recall and fill the gap</h1>
        <p className="text-[15px] text-ink-2">
          Each card calls <code>onRevealed</code> once, when the whole answer shows; the session then shows
          the grade buttons. Space reveals on the card picked below, unless focus is on another button.
        </p>
        <p className="font-mono text-sm text-ink-3" data-testid="motion-mode">
          motion: {mode}
        </p>
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
      </header>

      {SAMPLES.map((s) => (
        <section key={s.id} className="space-y-3" data-testid={`sample-${s.id}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="mono text-ink-3">{s.title.toUpperCase()}</h2>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
                <input
                  type="radio"
                  name="space"
                  checked={spaceOn === s.id}
                  onChange={() => setSpaceOn(s.id)}
                />
                Space
              </label>
              <Button variant="secondary" size="sm" onClick={() => reset(s.id)}>
                Reset
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setFramed(s.id)}>
                In the frame
              </Button>
            </div>
          </div>
          <SampleCard
            key={`${s.id}-${runs[s.id] ?? 0}`}
            s={s}
            keyboard={spaceOn === s.id}
            onRevealed={() => markFired(s.id)}
          />
          <p className="font-mono text-[13px] text-ink-3" data-testid={`fired-${s.id}`}>
            onRevealed fired {fired[s.id] ?? 0}×
          </p>
        </section>
      ))}
    </main>
  );
}
