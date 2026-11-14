"use client";

import { useState } from "react";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { useMotionMode } from "@/lib/motion/use-calm";

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="font-semibold text-ink">{title}</p>
      <p className="mt-1 text-[14px] text-ink-2">{body}</p>
    </div>
  );
}

const grade: TabItem[] = [
  {
    id: "overview",
    label: "Overview",
    content: <Card title="Overview" body="Where the course grade stands now." />,
  },
  {
    id: "whatif",
    label: "What if",
    content: <Card title="What if" body="Try a score and see the grade move." />,
  },
  {
    id: "graded",
    label: "Graded",
    content: <Card title="Graded" body="Everything that already has a mark." />,
  },
];

const exam: TabItem[] = [
  {
    id: "today",
    label: "Today",
    content: <Card title="Today" body="The next study session for this exam." />,
  },
  {
    id: "progress",
    label: "Progress",
    content: <Card title="Progress" body="A chart draws here on first view." />,
  },
  {
    id: "lectures",
    label: "Lectures",
    count: 4,
    content: <Card title="Lectures" body="Four lectures for this exam." />,
  },
  {
    id: "practise",
    label: "Practise",
    content: <Card title="Practise" body="Cards and questions to practise." />,
  },
  {
    id: "notes",
    label: "Notes",
    count: 2,
    content: <Card title="Notes" body="Two notes so far." />,
  },
];

export default function TabsPage() {
  const mode = useMotionMode();
  const [shown, setShown] = useState<string[]>([]);

  return (
    <main className="mx-auto max-w-2xl space-y-10 px-4 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Tabs</h1>
        <p className="text-ink-2">
          A pill track with a marker that springs to the chosen tab. Left and
          Right wrap, Home and End jump. The chosen tab is remembered for the
          session. On phones the track sticks to the top, and with more than
          three tabs it scrolls sideways.
        </p>
        <p className="font-mono text-sm text-ink-3" data-testid="motion-mode">
          motion: {mode}
        </p>
      </header>

      <section className="space-y-2" data-testid="three">
        <h2 className="type-h22">Three tabs (grade page)</h2>
        <Tabs tabs={grade} memoryKey="dev-grade" label="Grade sections" />
      </section>

      <section className="space-y-2" data-testid="five">
        <h2 className="type-h22">Five tabs with counts (exam page)</h2>
        <Tabs
          tabs={exam}
          memoryKey="dev-exam"
          label="Exam sections"
          onShown={(id) => setShown((s) => [...s, id])}
        />
        <p className="font-mono text-sm text-ink-3" data-testid="shown-log">
          first shown: {shown.join(", ")}
        </p>
      </section>

      <div className="h-[120vh]" aria-hidden="true" />
    </main>
  );
}
