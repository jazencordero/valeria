"use client";

import { useEffect, useRef, useState } from "react";
import {
  CardExplain,
  type CardExplainHandle,
  type CardExplainProps,
  type ExplainCheck,
} from "@/components/session/card-explain";
import { DoodleDefs } from "@/components/doodle";
import { Button } from "@/components/ui/button";
import { useMotionMode } from "@/lib/motion/use-calm";
import { useSessionKeys } from "@/components/session/use-session-keys";
import type { Grade } from "@/lib/study/memory";

// Made-up sample content. The check is mocked: nothing here calls the route.
const CARD: CardExplainProps["card"] = {
  q: "Explain strategic alignment between business and IT in your own words.",
  rubric: [
    ["IT goals follow the business goals", ["business goal", "strategy", "follow"]],
    ["It is a two-way, ongoing process", ["two-way", "ongoing", "both"]],
    ["Shared ownership of decisions", ["shared", "together", "ownership"]],
  ],
  model:
    "Strategic alignment means IT plans and spends in service of the business strategy, and the business shapes " +
    "its strategy knowing what IT can do. It is ongoing and two-way, with both sides owning the decisions.",
  source: "Lecture 4, slide 9",
  why: "Exams ask for both directions, not just IT following the business.",
};
const LABELS = CARD.rubric.map(([label]) => label);
const ID = "00000000-0000-4000-8000-000000000035";

function fixed(had: string[], fallback = false): ExplainCheck {
  return async () => ({ had, missing: LABELS.filter((l) => !had.includes(l)), fallback });
}

const failing: ExplainCheck = async () => {
  throw new Error("busy");
};

/** Live mock: a keyword match like the fallback, after a short wait, so the spinner shows. */
const mockLive: ExplainCheck = (_id, text) =>
  new Promise((resolve) => {
    const t = text.toLowerCase();
    const had = CARD.rubric.filter(([, keys]) => keys.some((k) => t.includes(k))).map(([l]) => l);
    setTimeout(() => resolve({ had, missing: LABELS.filter((l) => !had.includes(l)), fallback: true }), 700);
  });

type PanelSpec = { title: string; text: string; check: ExplainCheck };

const PANELS: PanelSpec[] = [
  {
    title: "Had",
    text: "IT follows the business strategy, and it is two-way and ongoing. Both sides share ownership.",
    check: fixed(LABELS),
  },
  {
    title: "Missing",
    text: "IT should follow the business goals.",
    check: fixed([LABELS[0]]),
  },
  { title: "Neutral (wrote nothing)", text: "", check: fixed([]) },
  { title: "Quick check only", text: "It is ongoing.", check: fixed([LABELS[1]], true) },
  { title: "Check failed", text: "IT follows the business.", check: failing },
];

function Panel({ spec }: { spec: PanelSpec }) {
  const card = useRef<CardExplainHandle>(null);
  const [graded, setGraded] = useState<Grade | null>(null);
  useEffect(() => {
    card.current?.check();
  }, []);
  return (
    <section className="min-w-0 space-y-3" data-testid={`panel-${spec.title.split(" ")[0].toLowerCase()}`}>
      <p className="mono text-ink-3">
        {spec.title.toUpperCase()}
        {graded ? ` · graded ${graded}` : ""}
      </p>
      <CardExplain
        ref={card}
        cardId={ID}
        card={CARD}
        section="learn"
        conceptNames={["Strategic alignment"]}
        rung={3}
        initialText={spec.text}
        check={spec.check}
        onRevealed={() => {}}
        gradeMode="four"
        next={{ 1: "1 min", 2: "10 min", 3: "2 d", 4: "5 d" }}
        onGrade={setGraded}
        autoFocus={false}
      />
    </section>
  );
}

function Live() {
  const card = useRef<CardExplainHandle>(null);
  const [round, setRound] = useState(0);
  const [phase, setPhase] = useState<"front" | "graded">("front");
  const [log, setLog] = useState<string[]>([]);
  const add = (l: string) => setLog((x) => [l, ...x].slice(0, 5));

  useSessionKeys(
    { phase, cardType: "explain", gradeMode: "two" },
    {
      onCheck: () => card.current?.check(),
      onGrade: (g) => {
        add(`graded ${g}`);
        setPhase("front");
        setRound((n) => n + 1);
      },
    },
  );

  const check: ExplainCheck = (id, text) => {
    add(`request sent (${text.length} chars)`);
    return mockLive(id, text);
  };

  return (
    <section className="max-w-[640px] space-y-3" data-testid="panel-live">
      <p className="mono text-ink-3">TRY IT · WRITE, THEN CMD OR CTRL + ENTER · 1 OR 2 TO GRADE</p>
      <CardExplain
        key={round}
        ref={card}
        cardId={ID}
        card={CARD}
        section="boss"
        conceptNames={["Strategic alignment"]}
        rung={4}
        check={check}
        onRevealed={() => setPhase("graded")}
        onChecked={(o) => add(`marks: ${o.marks.join(", ")}${o.fallback ? " (quick check)" : ""}`)}
        gradeMode="two"
        next={{ 1: "1 min", 3: "3 d" }}
        onGrade={(g) => {
          add(`graded ${g}`);
          setPhase("front");
          setRound((n) => n + 1);
        }}
      />
      <ul className="font-mono text-[12px] text-ink-3" data-testid="live-log">
        {log.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </section>
  );
}

export default function SessionExplainPage() {
  const mode = useMotionMode();
  const [run, setRun] = useState(0);
  return (
    <main className="mx-auto max-w-6xl space-y-10 px-4 py-10 min-[700px]:px-6">
      <DoodleDefs />
      <header className="space-y-2">
        <h1 className="type-h30">Session card: explain it</h1>
        <p className="text-ink-2">
          Write from memory, check it, see each rubric point marked, the model answer and the source. Then she grades
          herself. The check is mocked here.
        </p>
        <p className="font-mono text-sm text-ink-3" data-testid="motion-mode">
          motion: {mode} · add ?fast=1 for instant
        </p>
        <Button size="sm" variant="secondary" onClick={() => setRun((n) => n + 1)}>
          Replay
        </Button>
      </header>

      <div className="grid gap-8 min-[1000px]:grid-cols-2" key={run}>
        {PANELS.map((p) => (
          <Panel key={p.title} spec={p} />
        ))}
      </div>

      <Live />
    </main>
  );
}
