"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { ExamHeader } from "@/components/study/exam-header";
import { ProgressHead } from "@/components/study/progress-head";
import { gradeFor, planCurve, verdict } from "@/lib/study/forecast";

/** 13 days before today, easing from `from` up to just under `to`. */
function ramp(from: number, to: number): number[] {
  return Array.from({ length: 13 }, (_, i) => {
    const t = i / 13;
    return Math.round((from + (to - from) * t * t + (((i * 7) % 5) - 2)) * 10) / 10;
  });
}

type Exam = {
  name: string;
  course: string;
  sub: string;
  forecast: number;
  daysLeft: number;
  target: number;
  dayName: string;
  examDay: string;
};

const TARGET = 80;

const EXAMS: Exam[] = [
  {
    name: "Ready",
    course: "Cell biology",
    sub: "Exam · Mon 16 Nov 13:00",
    forecast: 86,
    daysLeft: 2,
    target: TARGET,
    dayName: "Monday",
    examDay: "NOV 16",
  },
  {
    name: "On track",
    course: "Organic chemistry",
    sub: "Exam · Fri 20 Nov 09:00",
    forecast: 64,
    daysLeft: 6,
    target: TARGET,
    dayName: "Friday",
    examDay: "NOV 20",
  },
  {
    name: "Tight",
    course: "Statistics basics",
    sub: "Exam · Tue 17 Nov 10:00",
    forecast: 41,
    daysLeft: 3,
    target: TARGET,
    dayName: "Tuesday",
    examDay: "NOV 17",
  },
];

const planEndOf = (f: number, d: number) => {
  const c = planCurve(f, d);
  return c[c.length - 1];
};

const verdictOf = (e: Exam, f = e.forecast) => verdict(f, e.target, planEndOf(f, e.daysLeft)).text;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="font-mono font-medium uppercase tracking-[0.04em] text-ink-3">{title}</h2>
      {children}
    </section>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-line bg-paper p-4 sm:p-6">{children}</div>;
}

export default function ExamHeaderPage() {
  const onTrack = EXAMS[1];
  // Each bite remounts the rolled header with the old and new forecast.
  const [bite, setBite] = useState(0);
  const [shown, setShown] = useState<string[]>([]);
  const progressShown = shown.includes("progress");

  const chartFor = (e: Exam) => ({
    history: ramp(Math.max(0, e.forecast - 34), e.forecast - 3),
    forecast: e.forecast,
    daysLeft: e.daysLeft,
    target: e.target,
    examDay: e.examDay,
  });

  return (
    <main className="mx-auto max-w-[760px] space-y-12 px-4 py-10">
      <header className="space-y-2">
        <h1 className="type-h30">Exam page header and the Progress headline</h1>
        <p className="text-ink-2">
          The header chip in its three verdicts, the ring rolling after a bite, and the top of the
          Progress tab.
        </p>
      </header>

      <Section title="Header, three verdicts">
        {EXAMS.map((e) => (
          <div key={e.name} className="space-y-2" data-verdict={e.name}>
            <p className="mono text-ink-3">{e.name}</p>
            <Frame>
              <ExamHeader
                course={e.course}
                sub={e.sub}
                forecast={e.forecast}
                verdict={verdictOf(e)}
                onBack={() => {}}
              />
            </Frame>
          </div>
        ))}
      </Section>

      <Section title="After a bite: 64 rolls to 68">
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setBite((n) => n + 1)}>
            Play the roll
          </Button>
        </div>
        <Frame>
          <ExamHeader
            key={bite}
            course={onTrack.course}
            sub={onTrack.sub}
            forecast={68}
            rollFrom={64}
            verdict={verdictOf(onTrack, 68)}
            onBack={() => {}}
          />
        </Frame>
        <Frame>
          <ProgressHead
            key={bite}
            forecast={68}
            rollFrom={64}
            grade={gradeFor(68)}
            planEnd={Math.round(planEndOf(68, onTrack.daysLeft))}
            dayName={onTrack.dayName}
            chart={chartFor({ ...onTrack, forecast: 68 })}
          />
        </Frame>
      </Section>

      <Section title="Progress headline, in the exam tabs">
        <p className="text-ink-2">The chart draws the first time the Progress tab is shown.</p>
        <Frame>
          <ExamHeader
            course={onTrack.course}
            sub={onTrack.sub}
            forecast={onTrack.forecast}
            verdict={verdictOf(onTrack)}
            onBack={() => {}}
          />
          <Tabs
            className="mt-5"
            label="Exam"
            tabs={[
              {
                id: "today",
                label: "Today",
                content: <p className="text-ink-2">Today&apos;s bite sits here.</p>,
              },
              {
                id: "progress",
                label: "Progress",
                content: (
                  <ProgressHead
                    forecast={onTrack.forecast}
                    grade={gradeFor(onTrack.forecast)}
                    planEnd={Math.round(planEndOf(onTrack.forecast, onTrack.daysLeft))}
                    dayName={onTrack.dayName}
                    chart={chartFor(onTrack)}
                    shown={progressShown}
                  />
                ),
              },
              {
                id: "material",
                label: "Material",
                content: <p className="text-ink-2">Lectures and cards sit here.</p>,
              },
            ]}
            onShown={(id) => setShown((s) => (s.includes(id) ? s : [...s, id]))}
          />
        </Frame>
      </Section>

      <Section title="Progress headline, each verdict">
        {EXAMS.map((e) => (
          <Frame key={e.name}>
            <ProgressHead
              forecast={e.forecast}
              grade={gradeFor(e.forecast)}
              planEnd={Math.round(planEndOf(e.forecast, e.daysLeft))}
              dayName={e.dayName}
              chart={chartFor(e)}
            />
          </Frame>
        ))}
      </Section>
    </main>
  );
}
