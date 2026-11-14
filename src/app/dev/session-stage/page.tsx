"use client";

import { useRef, useState } from "react";
import { CardBasic } from "@/components/session/card-basic";
import { SessionFrame, type SessionFrameHandle } from "@/components/session/frame";
import { SessionStage, type StageExit } from "@/components/session/stage";
import { DoodleDefs } from "@/components/doodle";
import { Button } from "@/components/ui/button";
import { useMotionMode } from "@/lib/motion/use-calm";
import type { SectionKind } from "@/lib/study/bite";

// Made-up sample content.
type Sample = { section: SectionKind; names: string[]; rung: number; q: string; a: string; source: string };

const DECK: Sample[] = [
  {
    section: "warm",
    names: ["Opportunity cost"],
    rung: 4,
    q: "Define opportunity cost in one sentence.",
    a: "The value of the best alternative you give up when you choose something.",
    source: "Lecture 1, slide 4",
  },
  {
    section: "learn",
    names: ["Price elasticity"],
    rung: 2,
    q: "What does a price elasticity of demand of −2 tell you?",
    a: "A 1% rise in price cuts the quantity demanded by about 2%. Demand is elastic.",
    source: "Lecture 3, slide 9",
  },
  {
    section: "learn",
    names: ["Marginal cost"],
    rung: 1,
    q: "What is marginal cost?",
    a: "The extra cost of making one more unit.",
    source: "Lecture 5, slide 2",
  },
];

const BOSS: Sample = {
  section: "boss",
  names: ["Supply", "Demand"],
  rung: 3,
  q: "A frost destroys half the orange crop. What happens to the price and quantity of orange juice, and why?",
  a: "Supply shifts left, so the price rises and the quantity sold falls. Demand has not moved; only supply has.",
  source: "Lecture 4, slide 12",
};

/** Cards per demo run: the edges go 2, 2, 1, 0, then it starts over. */
const RUN = 4;

export default function SessionStagePage() {
  const mode = useMotionMode();
  const frame = useRef<SessionFrameHandle>(null);
  const [n, setN] = useState(0);
  const [card, setCard] = useState<Sample>(DECK[0]);
  const [exit, setExit] = useState<StageExit>("pass");
  const [bossNext, setBossNext] = useState(false);
  const [cheers, setCheers] = useState(0);
  // The card's "Show answer" goes in the footer, so the stack edges match the card.
  const [actionsEl, setActionsEl] = useState<HTMLDivElement | null>(null);

  const after = RUN - 1 - (n % RUN);

  const grade = (how: StageExit) => {
    const next = n + 1;
    setExit(how);
    setCard(bossNext ? BOSS : DECK[next % DECK.length]);
    setBossNext(false);
    setN(next);
    if (how === "miss") {
      frame.current?.miss();
      frame.current?.react("wince");
    } else {
      frame.current?.react("nod");
    }
  };

  return (
    <>
      <DoodleDefs />
      <SessionFrame
        ref={frame}
        cards={Array.from({ length: RUN }, (_, i) => ({ section: i === RUN - 1 ? "boss" : "learn" }) as const)}
        index={n % RUN}
        counts={{ new: 2, learning: 1, due: 1 }}
        hint={`motion: ${mode} · last exit: ${n === 0 ? "none" : exit} · cheers: ${cheers}`}
        onStop={() => {
          setN(0);
          setCard(DECK[0]);
        }}
        actions={
          <div className="grid gap-2">
            <div ref={setActionsEl} />
            <div className="grid grid-cols-3 gap-2">
              <Button variant="secondary" onClick={() => grade("miss")} data-testid="stage-miss">
                Miss
              </Button>
              <Button variant="secondary" onClick={() => grade("hard")} data-testid="stage-hard">
                Hard
              </Button>
              <Button onClick={() => grade("pass")} data-testid="stage-pass">
                Pass
              </Button>
            </div>
            <Button
              variant={bossNext ? "primary" : "secondary"}
              aria-pressed={bossNext}
              onClick={() => setBossNext((b) => !b)}
              data-testid="stage-boss-next"
            >
              {bossNext ? "Next is boss: on" : "Next is boss"}
            </Button>
            <p className="mono text-center text-ink-3 min-[700px]:hidden" data-testid="motion-mode">
              motion: {mode} · {after} after this
            </p>
          </div>
        }
      >
        <SessionStage
          cardKey={`card-${n}`}
          after={after}
          exit={exit}
          boss={card.section === "boss"}
          onBossEnter={() => {
            setCheers((c) => c + 1);
            frame.current?.react("cheer");
          }}
        >
          <CardBasic
            card={card}
            section={card.section}
            conceptNames={card.names}
            rung={card.rung}
            onRevealed={() => {}}
            actionsEl={actionsEl}
          />
        </SessionStage>
      </SessionFrame>
    </>
  );
}
