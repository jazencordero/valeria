"use client";

import { useState } from "react";
import { DoodleDefs } from "@/components/doodle";
import { LectureReader, type LectureReaderProps, type LectureView } from "@/components/lecture/reader";
import { Button } from "@/components/ui/button";

// Made-up sample data. Never real course content.
const BASE: LectureReaderProps = {
  course: "Systems Thinking",
  n: 5,
  title: "Feedback loops and why plans drift",
  lmsName: "MyCourses",
  status: "ready",
  file: { id: "sample-file-5", name: "L5_feedback_loops.pdf" },
  minutes: 6,
  slideCount: 24,
  breath:
    "Most systems steer themselves through loops. A balancing loop pulls a number back toward a goal; a reinforcing loop pushes it further the way it is already going. Plans drift when a loop has a delay nobody counted.",
  sections: [
    {
      heading: "Two kinds of loop",
      blocks: [
        {
          kind: "p",
          text: "A loop is a chain of causes that comes back to where it started. What matters is the sign of the whole chain, not of any one link.",
        },
        {
          kind: "ul",
          items: [
            "Balancing: more of A leads, round the loop, to less of A. A thermostat.",
            "Reinforcing: more of A leads to even more of A. Interest on savings.",
          ],
        },
      ],
      terms: ["balancing loop", "reinforcing loop", "polarity"],
      source: "SLIDES 3-8",
    },
    {
      heading: "Delays",
      blocks: [
        {
          kind: "p",
          text: "A delay sits between a change and its effect. With a long delay a balancing loop overshoots: you keep correcting after the correction has already worked.",
        },
        {
          kind: "dl",
          items: [
            { term: "Information delay", def: "The time before you notice something changed." },
            { term: "Material delay", def: "The time before the thing you ordered actually arrives." },
          ],
        },
      ],
      terms: ["overshoot", "oscillation"],
      source: "SLIDES 9-16",
    },
    {
      heading: "Reading a loop diagram",
      blocks: [
        {
          kind: "p",
          text: "Follow the arrows, count the minus signs. An even count means reinforcing, an odd count means balancing. Two parallel lines on an arrow mark a delay.",
        },
      ],
      source: "SLIDES 17-24",
    },
  ],
  slideTitles: [
    "What this lecture covers",
    "Recap: stocks and flows",
    "A loop, defined",
    "Balancing loops",
    "Reinforcing loops",
    "Counting the signs",
    "Example: a thermostat",
    "Example: word of mouth",
  ],
  read: true,
  cards: 12,
  practiseHref: "#practise",
  next: { n: 6, href: "#lecture-6" },
  notesCount: 2,
  // Stand-in for the note cards another ticket builds.
  notes: (
    <ul className="grid list-none gap-3">
      <li className="rounded-xl border border-line bg-surface p-4">Odd number of minus signs: balancing.</li>
      <li className="rounded-xl border border-line bg-surface p-4">Delays cause overshoot, not the loop itself.</li>
    </ul>
  ),
};

const STATES: { id: string; label: string; props: LectureReaderProps; view?: LectureView }[] = [
  { id: "read", label: "Read", props: BASE },
  { id: "read-nocards", label: "Read, no cards", props: { ...BASE, read: false, cards: 0, next: null } },
  { id: "slides", label: "Slides", props: BASE, view: "slides" },
  { id: "notes", label: "Notes, empty", props: { ...BASE, notesCount: 0, notes: undefined }, view: "notes" },
  {
    id: "not-posted",
    label: "Not posted",
    props: { ...BASE, n: 7, title: "Leverage points", status: "not-posted", file: null, opensOn: "Mon 16 Nov" },
  },
  {
    id: "writing",
    label: "Still being written",
    props: { ...BASE, n: 6, title: "Archetypes", status: "writing", file: { id: "sample-file-6", name: "L6_archetypes.pdf" } },
  },
];

function setTheme(theme: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export default function LectureReaderPage() {
  const [state, setState] = useState(STATES[0].id);
  const current = STATES.find((s) => s.id === state) ?? STATES[0];

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <DoodleDefs />
      <header className="space-y-3">
        <h1 className="type-h30">Lecture reader</h1>
        <p className="ink-2">Every state of the lecture page. Sample data only.</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="State">
          {STATES.map((s) => (
            <Button
              key={s.id}
              variant={s.id === state ? "primary" : "secondary"}
              size="sm"
              aria-pressed={s.id === state}
              onClick={() => setState(s.id)}
            >
              {s.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Theme">
          <Button variant="text" size="sm" onClick={() => setTheme("light")}>
            Light
          </Button>
          <Button variant="text" size="sm" onClick={() => setTheme("dark")}>
            Dark
          </Button>
          <Button variant="text" size="sm" onClick={() => setTheme("system")}>
            System
          </Button>
        </div>
      </header>

      <div className="mt-8 border-t border-line pt-4" data-testid={`state-${current.id}`}>
        <LectureReader key={current.id} {...current.props} defaultView={current.view} />
      </div>
    </main>
  );
}
