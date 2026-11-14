"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Chip, ChipRow } from "@/components/ui/chip";
import { DoneRow } from "@/components/ui/done-row";
import { DueTag } from "@/components/ui/due-tag";
import { Tag } from "@/components/ui/tag";

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

function FileIcon() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3.5h6.5L18 8v12.5H7z" />
      <path d="M13.5 3.5V8H18" />
    </svg>
  );
}

const COURSES = [
  ["all", "All"],
  ["fm", "Forecasting Methods"],
  ["sit", "Strategic IT Management"],
  ["sca", "Supply Chain Analytics"],
  ["dsd", "Digital Service Design"],
] as const;

const SOURCES = ["A3_brief.pdf", "Lecture 6 Exponential smoothing.pdf", "weekly_demand.csv"];
const CALENDARS = ["Google", "Apple", "Outlook"];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="mono ink-3 font-medium uppercase tracking-[0.04em]">{title}</h2>
      {children}
    </section>
  );
}

export default function BitsPage() {
  const [course, setCourse] = useState<string>("all");
  const [sources, setSources] = useState<string[]>(["A3_brief.pdf"]);
  const [calendar, setCalendar] = useState("Google");

  return (
    <main className="mx-auto max-w-2xl space-y-10 px-4 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Small pieces</h1>
        <p className="ink-2">Chip, tag, badge, due tag and done row, in every tone.</p>
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

      <Section title="Chip: filter">
        <ChipRow aria-label="Filter by course" data-testid="filters">
          {COURSES.map(([id, name]) => (
            <Chip
              key={id}
              kind="filter"
              pressed={course === id}
              onPressedChange={() => setCourse(id)}
            >
              {name}
            </Chip>
          ))}
        </ChipRow>
      </Section>

      <Section title="Chip: source">
        <div className="flex flex-wrap gap-1.5">
          {SOURCES.map((name) => (
            <Chip
              key={name}
              kind="source"
              icon={<FileIcon />}
              pressed={sources.includes(name)}
              onPressedChange={(on) =>
                setSources((s) => (on ? [...s, name] : s.filter((x) => x !== name)))
              }
            >
              {name}
            </Chip>
          ))}
        </div>
      </Section>

      <Section title="Chip: choice">
        <div className="flex flex-wrap gap-1.5">
          {CALENDARS.map((name) => (
            <Chip
              key={name}
              kind="choice"
              pressed={calendar === name}
              onPressedChange={() => setCalendar(name)}
            >
              {name}
            </Chip>
          ))}
        </div>
      </Section>

      <Section title="Chip: disabled">
        <div className="flex flex-wrap gap-1.5">
          <Chip kind="filter" pressed={false} disabled>
            Off
          </Chip>
          <Chip kind="filter" pressed disabled>
            On
          </Chip>
        </div>
      </Section>

      <Section title="Tag">
        <div className="flex flex-wrap items-center gap-3">
          <Tag>NEW</Tag>
          <Tag tone="strong">MATTERS MOST</Tag>
        </div>
      </Section>

      <Section title="Badge">
        <div className="flex flex-wrap items-center gap-3">
          <Badge count={0} />
          <Badge count={2} />
          <Badge count={3} label="3 open" />
          <Badge count={12} />
          <Badge count={128} />
        </div>
      </Section>

      <Section title="Due tag">
        <div className="flex flex-col items-start gap-3">
          <DueTag tone="urgent">DUE TODAY 21:00</DueTag>
          <DueTag tone="soon">DUE TUE 23:59</DueTag>
        </div>
      </Section>

      <Section title="Done row">
        <div>
          <DoneRow title="Assignment 3 handed in" meta="15:52 · 5 h 8 min early" />
          <DoneRow title="Calendar and reminders are on" meta="6 dates in Google Calendar · reminders to a.very.long.student.address@example.com" />
          <DoneRow title="Assignment 3 handed in" />
        </div>
        <ul className="list-none">
          <DoneRow as="li" title="Assignment 3 handed in" meta="15:52 · Forecasting Methods" />
        </ul>
      </Section>
    </main>
  );
}
