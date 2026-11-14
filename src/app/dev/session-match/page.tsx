"use client";

import { useRef, useState, type ReactNode } from "react";
import { CardMatch, MatchPrompt, matchSub, type CardMatchProps, type MatchResult } from "@/components/session/card-match";
import { FeedbackStrip } from "@/components/session/feedback-strip";
import { SECTION_LABEL, SessionFrame, type SessionFrameHandle } from "@/components/session/frame";
import { Button } from "@/components/ui/button";
import { useMotionMode } from "@/lib/motion/use-calm";
import type { SectionKind } from "@/lib/study/bite";

// Made-up sample content.
type Demo = { card: CardMatchProps["card"]; section: SectionKind; concept: string };

const ELASTIC: Demo = {
  section: "learn",
  concept: "Price elasticity",
  card: {
    q: "Match each word to what it means.",
    pairs: [
      ["Elastic", "Quantity reacts a lot to a price change"],
      ["Inelastic", "Quantity barely moves when price changes"],
      ["Unit elastic", "Revenue stays the same when price changes"],
      ["Substitute", "A good bought instead of another one"],
    ],
    order: [2, 0, 3, 1],
  },
};

const MARKETS: Demo = {
  section: "warm",
  concept: "Market structures",
  card: {
    q: "Which market is which?",
    pairs: [
      ["Monopoly", "One seller, no close substitutes"],
      ["Oligopoly", "A few big sellers watching each other"],
      ["Perfect competition", "Many sellers, the same product, no say over price"],
    ],
    order: [1, 2, 0],
  },
};

const DECK = [MARKETS, ELASTIC];

function Head({ demo }: { demo: Demo }) {
  return (
    <p className="mono text-ink-3">
      {SECTION_LABEL[demo.section]} · {demo.concept.toUpperCase()}
    </p>
  );
}

function Panel({
  title,
  footer,
  ...props
}: { title: string; footer?: ReactNode } & Omit<CardMatchProps, "card" | "head">) {
  return (
    <section className="min-w-0 space-y-3" data-testid={`panel-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <p className="mono text-ink-3">{title.toUpperCase()}</p>
      <CardMatch card={ELASTIC.card} head={<Head demo={ELASTIC} />} {...props} />
      {footer ?? <MatchPrompt />}
    </section>
  );
}

function Live() {
  const [round, setRound] = useState(0);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const demo = DECK[round % DECK.length];

  return (
    <section className="max-w-[640px] space-y-3" data-testid="panel-live">
      <p className="mono text-ink-3">TRY IT · TAP, OR TAB AND ENTER</p>
      <CardMatch
        key={round}
        card={demo.card}
        head={<Head demo={demo} />}
        onResult={(r) => {
          setResult(r);
          setLog((l) => [`${demo.concept}: grade ${r.grade}, ${r.slips} slips`, ...l].slice(0, 4));
        }}
      />
      {result ? (
        <FeedbackStrip
          key={`fb-${round}`}
          grade={result.grade}
          concept={demo.concept}
          sub={matchSub(result.slips)}
          passed={round}
          hint
          onContinue={() => {
            setResult(null);
            setRound((n) => n + 1);
          }}
        />
      ) : (
        <MatchPrompt />
      )}
      <ul className="font-mono text-[12px] text-ink-3" data-testid="live-log">
        {log.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </section>
  );
}

function InFrame({ onClose }: { onClose: () => void }) {
  const frame = useRef<SessionFrameHandle>(null);
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [streak, setStreak] = useState(0);
  const done = index >= DECK.length;
  const demo = DECK[Math.min(index, DECK.length - 1)];

  return (
    <SessionFrame
      ref={frame}
      cards={DECK.map((d) => ({ section: d.section }))}
      index={index}
      counts={{ new: 1, learning: 1, due: 0 }}
      streak={streak}
      hint={result ? "Enter to continue" : "Tab and Enter to pick"}
      onStop={onClose}
      actions={
        done ? (
          <Button size="lg" block onClick={onClose}>
            Back to the preview
          </Button>
        ) : result ? (
          <FeedbackStrip
            key={`fb-${index}`}
            grade={result.grade}
            concept={demo.concept}
            sub={matchSub(result.slips)}
            passed={index}
            onContinue={() => {
              setResult(null);
              setIndex((i) => i + 1);
            }}
          />
        ) : (
          <MatchPrompt />
        )
      }
    >
      {done ? (
        <p className="mt-16 text-center font-display text-[24px] font-semibold">That was the deck.</p>
      ) : (
        <div className="mt-10">
          <CardMatch
            key={index}
            card={demo.card}
            head={<Head demo={demo} />}
            onResult={(r) => {
              setResult(r);
              setStreak((n) => n + 1);
              frame.current?.react(r.slips ? "nod" : "cheer");
            }}
          />
        </div>
      )}
    </SessionFrame>
  );
}

export default function SessionMatchPage() {
  const mode = useMotionMode();
  const [framed, setFramed] = useState(false);

  if (framed) return <InFrame onClose={() => setFramed(false)} />;

  return (
    <main className="mx-auto max-w-6xl space-y-10 px-4 py-10 min-[700px]:px-6">
      <header className="space-y-2">
        <h1 className="type-h30">Session card: match pairs</h1>
        <p className="text-ink-2">Tap a term, then its meaning. Right pairs turn mint; wrong ones shake and count a slip.</p>
        <p className="font-mono text-sm text-ink-3" data-testid="motion-mode">
          motion: {mode} · add ?fast=1 for instant
        </p>
        <Button size="sm" variant="secondary" onClick={() => setFramed(true)} data-testid="open-frame">
          Open in the session frame
        </Button>
      </header>

      <div className="grid gap-8 min-[1000px]:grid-cols-3">
        <Panel title="Start" />
        <Panel title="Select" initialSelected={0} />
        <Panel title="Correct" initialMatched={[0]} />
        <Panel title="Wrong" initialMatched={[0]} initialWrong={[1, 2]} initialSlips={1} />
        <Panel
          title="Done"
          initialMatched={[0, 1, 2, 3]}
          footer={
            <FeedbackStrip grade={3} concept={ELASTIC.concept} keys={false} autoFocus={false} onContinue={() => {}} />
          }
        />
        <Panel
          title="Done with slips"
          initialMatched={[0, 1, 2, 3]}
          initialSlips={2}
          footer={
            <FeedbackStrip
              grade={2}
              concept={ELASTIC.concept}
              sub={matchSub(2)}
              keys={false}
              autoFocus={false}
              onContinue={() => {}}
            />
          }
        />
      </div>

      <Live />
    </main>
  );
}
