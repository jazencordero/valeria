"use client";

import { useState } from "react";
import { DoodleDefs } from "@/components/doodle";
import { LecturePage } from "@/components/lecture/lecture-page";
import { LectureReader, type LectureReaderProps, type LectureSection, type LectureView } from "@/components/lecture/reader";
import { Button } from "@/components/ui/button";
import type { LecturePageData } from "@/server/data/lecture";

// Made-up sample data. Never real course content.
// The first section has every teaching part (M9-26); the other two have none.
const START_HERE: LectureReaderProps["startHere"] = [
  {
    kind: "p",
    text: "This lecture is about why a plan that looks right on paper still ends up somewhere else. The answer is almost always a loop: the result of what you did comes back and changes what you do next.",
  },
  {
    kind: "p",
    text: "It matters because the rest of the course draws systems as loops. If you can tell the two kinds apart, the later diagrams read like sentences.",
  },
  {
    kind: "dl",
    items: [
      { term: "System", def: "Parts that affect each other over time, like a shower and the person adjusting it." },
      { term: "Cause", def: "One thing changing makes another thing change." },
      { term: "Goal", def: "The value somebody, or something, is trying to reach." },
    ],
  },
];

const TEACHING: Pick<LectureSection, "keyPoints" | "fromScratch" | "example" | "stuck"> = {
  keyPoints: [
    "A loop is a chain of causes that ends where it began.",
    "A balancing loop pulls a value back toward a goal.",
    "A reinforcing loop pushes a value further the way it is already going.",
    "The sign of the whole chain decides which kind it is, not any single link.",
  ],
  fromScratch: [
    {
      kind: "p",
      text: "Think of a shower. The water is too cold, so you turn the tap toward hot. It gets warmer, so you turn less. Your hand and the water temperature keep answering each other: that back-and-forth is a loop.",
    },
    {
      kind: "p",
      text: "Now put numbers on it. You want 38 degrees and the water is 30, a gap of 8. Each turn of the tap closes half of the gap.",
    },
    { kind: "ul", items: ["After one turn: 34 degrees, gap 4.", "After two turns: 36 degrees, gap 2.", "After three turns: 37 degrees, gap 1."] },
    { kind: "p", text: "The gap shrinks every time. A loop that shrinks the gap to a goal is a balancing loop." },
  ],
  example: {
    title: "Savings with 10 % interest a year",
    steps: [
      "Start with 100 euros.",
      "Year 1: interest is 10 % of 100, which is 10. The balance is 110.",
      "Year 2: interest is 10 % of 110, which is 11. The balance is 121.",
      "Year 3: interest is 10 % of 121, which is 12.10. The balance is 133.10.",
    ],
    result: "The interest itself grows each year (10, 11, 12.10): more balance gives more interest, which gives more balance. That is a reinforcing loop.",
  },
  stuck: [
    {
      q: "How do I tell the two kinds apart quickly?",
      a: "Ask what happens after a small push. If the system pushes back toward where it was, it is balancing. If it keeps going the same way, it is reinforcing.",
    },
    {
      q: "Is a reinforcing loop always good?",
      a: "No. It only means more leads to more. Debt growing with interest is reinforcing too.",
    },
    {
      q: "What does polarity mean here?",
      a: "Whether a link keeps the direction of a change (plus) or flips it (minus). Count the minus links around the loop.",
    },
  ],
};

const BASE: LectureReaderProps = {
  course: "Systems Thinking",
  n: 5,
  title: "Feedback loops and why plans drift",
  lmsName: "MyCourses",
  status: "ready",
  file: { id: "sample-file-5", name: "L5_feedback_loops.pdf" },
  minutes: 6,
  minutesWithHelp: 11,
  startHere: START_HERE,
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
      ...TEACHING,
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

/** The same page with no teaching parts: what the AI job (M9-05) writes. */
const PLAIN: LectureReaderProps = {
  ...BASE,
  minutesWithHelp: undefined,
  startHere: undefined,
  sections: BASE.sections?.map((s) => ({ heading: s.heading, blocks: s.blocks, terms: s.terms, source: s.source })),
};

/** The whole lecture page (header, reading progress, notes on a selection), with stand-in actions. */
const PAGE: LecturePageData = {
  courseId: "sample-course",
  course: BASE.course,
  lectureId: "sample-lecture-5",
  n: BASE.n,
  title: BASE.title,
  status: "ready",
  read: false,
  file: BASE.file ?? null,
  opensOn: null,
  minutes: 6,
  minutesWithHelp: 11,
  startHere: START_HERE ?? [],
  slideCount: 24,
  breath: BASE.breath ?? null,
  sections: BASE.sections ?? [],
  slideTitles: BASE.slideTitles ?? [],
  cards: 0,
  practiseHref: null,
  next: null,
  backHref: "#back",
  href: "#lecture-5",
  notes: [],
};

const STATES: { id: string; label: string; props: LectureReaderProps; view?: LectureView; page?: boolean }[] = [
  { id: "first-visit", label: "First visit", props: { ...BASE, read: false } },
  { id: "read", label: "Read before", props: BASE },
  { id: "plain", label: "No teaching parts", props: PLAIN },
  { id: "page", label: "Whole page", props: BASE, page: true },
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

      {current.page ? (
        // The lecture page measures the app's scrolling column, `#main`; this box stands in for it.
        <div id="main" className="mt-8 h-[70vh] overflow-y-auto rounded-xl border border-line" data-testid={`state-${current.id}`}>
          <LecturePage
            lecture={PAGE}
            lmsName="MyCourses"
            markRead={async (lectureId) => ({
              ok: true,
              courseId: PAGE.courseId,
              lectureId,
              readAt: new Date(),
              current: null,
              advanced: null,
            })}
            remove={async () => ({ ok: true })}
            saveHl={async (_lectureId, text) => ({ ok: true, text })}
            loadHl={async () => ({ ok: true, texts: ["closes half of the gap", "sign of the whole chain"] })}
          />
        </div>
      ) : (
        <div className="mt-8 border-t border-line pt-4" data-testid={`state-${current.id}`}>
          <LectureReader key={current.id} {...current.props} defaultView={current.view} />
        </div>
      )}
    </main>
  );
}
