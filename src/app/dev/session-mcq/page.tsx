"use client";

import { useRef, useState } from "react";
import { CardMcq, PickPrompt, type CardMcqProps, type McqResult } from "@/components/session/card-mcq";
import { FeedbackStrip, type FeedbackGrade } from "@/components/session/feedback-strip";
import { SECTION_LABEL, SessionFrame, type SessionFrameHandle } from "@/components/session/frame";
import { Button } from "@/components/ui/button";
import { useMotionMode } from "@/lib/motion/use-calm";
import type { SectionKind } from "@/lib/study/bite";

// Made-up sample content.
type Demo = { card: CardMcqProps["card"]; section: SectionKind; concept: string; boss: boolean };

const ELASTIC: Demo = {
  section: "learn",
  concept: "Price elasticity",
  boss: false,
  card: {
    q: "Demand for a good is elastic. The price goes up 10%. What happens to revenue?",
    opts: [
      ["It goes up", false],
      ["It goes down", true],
      ["It stays the same", false],
      ["It doubles", false],
    ],
    why: "Elastic means quantity falls by more than 10%, so price times quantity shrinks.",
    source: "Lecture 3, slide 14",
  },
};

const SURPLUS: Demo = {
  section: "warm",
  concept: "Consumer surplus",
  boss: false,
  card: {
    q: "Consumer surplus is the area between the demand curve and what?",
    opts: [
      ["The supply curve", false],
      ["The price line", true],
      ["The quantity axis", false],
    ],
    why: "It is what buyers would have paid minus what they did pay, so it sits above the price.",
    source: "Lecture 2, slide 9",
  },
};

const BOSS: Demo = {
  section: "boss",
  concept: "Tax incidence",
  boss: true,
  card: {
    q: "A tax is put on a good with very inelastic demand. Who carries most of it?",
    opts: [
      ["Buyers", true],
      ["Sellers", false],
      ["The government", false],
      ["Split evenly, always", false],
    ],
    why: "The side that cannot walk away pays. Inelastic buyers keep buying, so the price they pay rises by most of the tax.",
    source: "Exam 2024, question 3",
  },
};

const MODEL: Demo = {
  section: "learn",
  concept: "Linear programming",
  boss: false,
  card: {
    q: "Which constraint is binding at the optimum x = 3, y = 1?",
    opts: [
      ["x + y \u2264 4", true],
      ["x + 3y \u2264 9", false],
      ["y \u2264 5", false],
    ],
    why: "x + y = 3 + 1 = 4, so it holds with equality.\nx + 3y = 6 is below 9, so it has slack.\ny = 1 is far below 5.",
    source: "Lecture 6, slide 12",
  },
};

const DECK = [SURPLUS, ELASTIC, BOSS];

function Head({ demo }: { demo: Demo }) {
  return (
    <p className="mono text-ink-3">
      {SECTION_LABEL[demo.section]} · {demo.concept.toUpperCase()}
    </p>
  );
}

function Panel({ title, demo, pick, grade }: { title: string; demo: Demo; pick: number; grade: FeedbackGrade }) {
  const [continued, setContinued] = useState(0);
  return (
    <section className="min-w-0 space-y-3" data-testid={`panel-${title.toLowerCase()}`}>
      <p className="mono text-ink-3">
        {title.toUpperCase()} · continued {continued}
      </p>
      {/* A fixed state (this pick is right or wrong by its file position), so the file order stays. */}
      <CardMcq card={demo.card} head={<Head demo={demo} />} initialPick={pick} keys={false} seed={null} />
      <FeedbackStrip
        grade={grade}
        concept={demo.concept}
        boss={demo.boss}
        passed={0}
        keys={false}
        autoFocus={false}
        onContinue={() => setContinued((n) => n + 1)}
        key={continued}
      />
    </section>
  );
}

function Live() {
  const [round, setRound] = useState(0);
  const [result, setResult] = useState<McqResult | null>(null);
  const [passed, setPassed] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const demo = DECK[round % DECK.length];

  return (
    <section className="max-w-[640px] space-y-3" data-testid="panel-live">
      <p className="mono text-ink-3">TRY IT · KEYS 1–4, THEN ENTER OR SPACE</p>
      <CardMcq
        key={round}
        card={demo.card}
        head={<Head demo={demo} />}
        onResult={(r) => {
          setResult(r);
          if (r.correct) setPassed((n) => n + 1);
          setLog((l) => [`${demo.concept}: picked ${"ABCD"[r.picked]}, ${r.correct ? "right" : "missed"}`, ...l].slice(0, 4));
        }}
      />
      {result ? (
        <FeedbackStrip
          key={`fb-${round}`}
          grade={result.grade}
          concept={demo.concept}
          boss={demo.boss}
          passed={result.correct ? passed - 1 : passed}
          hint
          onContinue={() => {
            setResult(null);
            setRound((n) => n + 1);
          }}
        />
      ) : (
        <PickPrompt />
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
  const [result, setResult] = useState<McqResult | null>(null);
  const [passed, setPassed] = useState(0);
  const [streak, setStreak] = useState(0);
  const done = index >= DECK.length;
  const demo = DECK[Math.min(index, DECK.length - 1)];

  return (
    <SessionFrame
      ref={frame}
      cards={DECK.map((d) => ({ section: d.section }))}
      index={index}
      counts={{ new: 1, learning: 1, due: 1 }}
      streak={streak}
      hint={result ? "Enter to continue" : "1–4 to pick"}
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
            boss={demo.boss}
            passed={result.correct ? passed - 1 : passed}
            onContinue={() => {
              setResult(null);
              setIndex((i) => i + 1);
            }}
          />
        ) : (
          <PickPrompt />
        )
      }
    >
      {done ? (
        <p className="mt-16 text-center font-display text-[24px] font-semibold">That was the deck.</p>
      ) : (
        <div className="mt-10">
          <CardMcq
            key={index}
            card={demo.card}
            head={<Head demo={demo} />}
            onResult={(r) => {
              setResult(r);
              if (r.correct) {
                setPassed((n) => n + 1);
                setStreak((n) => n + 1);
                frame.current?.react("nod");
              } else {
                setStreak(0);
                frame.current?.react("wince");
              }
            }}
          />
        </div>
      )}
    </SessionFrame>
  );
}

export default function SessionMcqPage() {
  const mode = useMotionMode();
  const [framed, setFramed] = useState(false);

  if (framed) return <InFrame onClose={() => setFramed(false)} />;

  return (
    <main className="mx-auto max-w-6xl space-y-10 px-4 py-10 min-[700px]:px-6">
      <header className="space-y-2">
        <h1 className="type-h30">Session card: quiz me</h1>
        <p className="text-ink-2">Options A to D, then the why, then the feedback strip and Continue.</p>
        <p className="font-mono text-sm text-ink-3" data-testid="motion-mode">
          motion: {mode} · add ?fast=1 for instant
        </p>
        <Button size="sm" variant="secondary" onClick={() => setFramed(true)} data-testid="open-frame">
          Open in the session frame
        </Button>
      </header>

      <div className="grid gap-8 min-[1000px]:grid-cols-3">
        <Panel title="Right" demo={ELASTIC} pick={1} grade={3} />
        <Panel title="Wrong" demo={ELASTIC} pick={2} grade={1} />
        <Panel title="Boss" demo={BOSS} pick={0} grade={3} />
        <Panel title="Three options, multi-line why" demo={MODEL} pick={0} grade={3} />
      </div>

      <Live />
    </main>
  );
}
