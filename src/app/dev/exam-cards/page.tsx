"use client";

import { useState, type ReactNode } from "react";
import { ExamCard, type ExamCardConcept } from "@/components/exams/exam-card";
import { ExamTabCard } from "@/components/exams/exam-tab-card";

/** Simple stand-in concept icons for the preview. */
function Icon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.5]"
    >
      <path d={d} />
    </svg>
  );
}

const ICONS = {
  grid: <Icon d="M5 5h6v6H5zM13 5h6v6h-6zM5 13h6v6H5zM13 13h6v6h-6z" />,
  wave: <Icon d="M3 12c3-6 6-6 9 0s6 6 9 0" />,
  arrow: <Icon d="M4 17l6-6 4 4 6-8" />,
  ring: <Icon d="M12 4a8 8 0 1 0 0.01 0M12 9v6" />,
  stack: <Icon d="M4 8l8-4 8 4-8 4zM4 12l8 4 8-4M4 16l8 4 8-4" />,
};

/** 13 days before today, easing from `from` up to just under `to`. */
function ramp(from: number, to: number): number[] {
  return Array.from({ length: 13 }, (_, i) => {
    const t = i / 13;
    const w = ((i * 7) % 5) - 2;
    return Math.round((from + (to - from) * t * t + w) * 10) / 10;
  });
}

const EXAM_CONCEPTS: ExamCardConcept[] = [
  { id: "c1", name: "Sampling and estimates", rung: 4, icon: ICONS.grid },
  { id: "c2", name: "Distributions", rung: 3, icon: ICONS.wave },
  { id: "c3", name: "Regression", rung: 2, icon: ICONS.arrow },
  { id: "c4", name: "Hypothesis tests", rung: 1, icon: ICONS.ring },
  { id: "c5", name: "Study design", rung: 0, icon: ICONS.stack },
];

const QUIZ_CONCEPTS: ExamCardConcept[] = [
  { id: "q1", name: "Cell structure", rung: 5, icon: ICONS.ring },
  { id: "q2", name: "Membranes", rung: 3, icon: ICONS.stack },
  { id: "q3", name: "Enzymes", rung: 2, icon: ICONS.wave },
];

const EXAM = {
  title: "Statistics final",
  course: "Introduction to Statistics",
  when: "MON 15 DEC · 9:00 · 12 DAYS",
  forecast: 64,
  spark: { history: ramp(30, 61), forecast: 64.2, daysLeft: 12 },
  target: 80,
  grade: 4,
  verdict: { text: "On track with a bite a day", ok: true },
  concepts: EXAM_CONCEPTS,
};

const QUIZ = {
  title: "Week 6 quiz",
  course: "Cell Biology",
  when: "THU 4 DEC · 14:00 · 1 DAY",
  forecast: 41,
  spark: { history: ramp(10, 39), forecast: 41, daysLeft: 1 },
  target: 60,
  grade: 3,
  verdict: { text: "Tight. Two bites a day gets you there.", ok: false },
  concepts: QUIZ_CONCEPTS,
};

/** The tab card takes no grade, verdict or icons. */
function tab(e: typeof EXAM) {
  const { title, course, when, forecast, spark, target, concepts } = e;
  return {
    title,
    course,
    when,
    forecast,
    spark,
    target,
    concepts: concepts.map(({ id, name, rung }) => ({ id, name, rung })),
  };
}

const WIDTHS = [360, 760];

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="mx-auto max-w-[760px] space-y-3">
      <h2 className="type-h22 text-ink">{title}</h2>
      {note && <p className="text-[14px] text-ink-2">{note}</p>}
      {children}
    </section>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <p className="mono text-ink-3">{children}</p>;
}

function ControlledExam() {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <Label>CONTROLLED · CONCEPTS {open ? "OPEN" : "CLOSED"}</Label>
      <ExamCard
        kind="exam"
        {...EXAM}
        biteMinutes={5}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}

export default function ExamCardsPreview() {
  return (
    <main className="space-y-12 bg-paper px-4 py-10">
      <header className="mx-auto max-w-[760px] space-y-1">
        <h1 className="type-h26 text-ink">Exam cards</h1>
        <p className="text-[14px] text-ink-2">
          The Home card and the Exams tab card, for an exam and a quiz, at 360
          and 760 px. Tap &ldquo;Concepts&rdquo; to open and close the list.
        </p>
      </header>

      {WIDTHS.map((w) => (
        <div key={w} className="space-y-10">
          <h2 className="mono mx-auto max-w-[760px] text-ink-3">{w} PX</h2>

          <Section title="Home">
            <div className="mx-auto space-y-6" style={{ maxWidth: w }}>
              <div className="space-y-2">
                <Label>EXAM · CONCEPTS CLOSED · TODAY&rsquo;S BITE</Label>
                <ExamCard kind="exam" {...EXAM} biteMinutes={5} />
              </div>
              <div className="space-y-2">
                <Label>EXAM · CONCEPTS OPEN · NO BITE</Label>
                <ExamCard
                  kind="exam"
                  {...EXAM}
                  biteMinutes={null}
                  defaultOpen
                />
              </div>
              <div className="space-y-2">
                <Label>QUIZ · NO BUTTON · TIGHT VERDICT</Label>
                <ExamCard kind="quiz" {...QUIZ} />
              </div>
              <div className="space-y-2">
                <Label>MAKING YOUR CARDS</Label>
                <ExamCard kind="exam" {...EXAM} making={{ lectures: 6 }} />
              </div>
              {w === WIDTHS[0] && <ControlledExam />}
            </div>
          </Section>

          <Section title="Exams tab">
            <div className="mx-auto space-y-6" style={{ maxWidth: w }}>
              <div className="space-y-2">
                <Label>EXAM · STRENGTHEN</Label>
                <ExamTabCard
                  href="#exam"
                  phase="Strengthen"
                  {...tab(EXAM)}
                  counts={{ new: 12, learning: 5, due: 8 }}
                />
              </div>
              <div className="space-y-2">
                <Label>QUIZ · FINAL REVIEW</Label>
                <ExamTabCard
                  href="#quiz"
                  phase="Final review"
                  {...tab(QUIZ)}
                  counts={{ new: 0, learning: 3, due: 1 }}
                />
              </div>
              <div className="space-y-2">
                <Label>MAKING YOUR CARDS · 1 LECTURE</Label>
                <ExamTabCard
                  href="#making"
                  phase="Learn"
                  {...tab(EXAM)}
                  counts={{ new: 0, learning: 0, due: 0 }}
                  making={{ lectures: 1 }}
                />
              </div>
            </div>
          </Section>
        </div>
      ))}
    </main>
  );
}
