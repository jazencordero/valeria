/**
 * Preview of the Notes tab (M9-14) with made-up notes: the grid (search and
 * the course chips filter this page's own data through the URL, like the
 * real tab), each card state, and the empty state. Delete here only hides
 * the card; nothing is stored.
 */
import { Suspense } from "react";
import { DoodleDefs } from "@/components/doodle";
import type { NoteCardData } from "@/components/notes/note-card";
import { GENERAL_FILTER, NotesGrid } from "@/components/notes/notes-grid";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

const COURSES = [
  { id: "c-fm", name: "Forecasting Methods" },
  { id: "c-sit", name: "Strategic IT Management" },
  { id: "c-sca", name: "Supply Chain Analytics" },
  { id: "c-dsd", name: "Digital Service Design" },
];

type DevNote = NoteCardData & { courseId: string | null };

const NOTES: DevNote[] = [
  {
    id: "n1",
    courseId: "c-sit",
    title: "Lock-in: how to argue it in the exam",
    body: "Switching costs: data migration, retraining, contract exit fees\nBargaining power: vendor sets prices once you depend on them\nReduce it: open standards, exit clauses, multi-sourcing",
    quote: null,
    highlighted: true,
    attachLabel: "Lecture 5 · Sourcing and vendors",
    date: "THU 12 NOV",
  },
  {
    id: "n2",
    courseId: "c-dsd",
    title: "Questions for Thursday's session",
    body: "Do we draw one blueprint per persona?\nHow much back stage detail does the draft need?",
    quote: null,
    highlighted: false,
    attachLabel: "Digital Service Design",
    date: "WED 11 NOV",
  },
  {
    id: "n3",
    courseId: "c-fm",
    title: "A3 plan",
    body: "Clean the weekly data first\nRun Holt-Winters and the seasonal baseline\nCompare with MAPE, then write it up",
    quote: null,
    highlighted: false,
    attachLabel: "Assignment 3",
    date: "FRI 13 NOV",
  },
  {
    id: "n4",
    courseId: "c-sca",
    title: null,
    body: "Bullwhip: small changes in demand grow up the chain.",
    quote: "Order variance increases as one moves up the supply chain.",
    highlighted: false,
    attachLabel: "Lecture 2 · Demand and the bullwhip effect",
    date: "TODAY",
  },
  {
    id: "n5",
    courseId: null,
    title: "Things to ask the study advisor about the exchange semester and the credit transfer",
    body: "",
    quote: null,
    highlighted: true,
    attachLabel: "General",
    date: "MON 9 NOV",
  },
  {
    id: "n6",
    courseId: "c-fm",
    title: "Quiz 4 formulas",
    body: "MAE = mean |e|\nRMSE = sqrt(mean e²)\nMAPE = mean |e / y| × 100\nTheil's U compares with the naive forecast\nWatch out: MAPE breaks when y is near zero",
    quote: null,
    highlighted: false,
    attachLabel: "Quiz 4 · Forecasting Methods",
    date: "SUN 8 NOV",
  },
];

async function fakeRemove(id: string) {
  "use server";
  void id;
  return { ok: true } as const;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mono mb-3 font-medium uppercase tracking-[0.04em] text-ink-3">{title}</h2>
      {children}
    </section>
  );
}

async function FilteredGrid({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";
  const course = typeof params.course === "string" && params.course ? params.course : null;
  const needle = q.trim().toLowerCase();
  const shown = NOTES.filter((n) => {
    const c = n.courseId ?? GENERAL_FILTER;
    const text = `${n.title ?? ""}\n${n.body}\n${n.quote ?? ""}`.toLowerCase();
    return (course === null || c === course) && (!needle || text.includes(needle));
  }).map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    quote: n.quote,
    highlighted: n.highlighted,
    attachLabel: n.attachLabel,
    date: n.date,
  }));

  return <NotesGrid notes={shown} courses={COURSES} query={q} course={course} remove={fakeRemove} />;
}

export default function NotesDevPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="mx-auto max-w-[1040px] px-[var(--pad)] py-10">
      <DoodleDefs />
      <h1 className="type-h30">Notes tab</h1>
      <p className="mt-1.5 text-[15px] text-ink-2">
        Made-up notes. Search and chips filter through the URL; Delete asks once and only hides the card.
      </p>

      <Section title="Grid: all states (highlighted, untitled with a quote, long title, clamped body)">
        <Suspense fallback={null}>
          <FilteredGrid searchParams={searchParams} />
        </Suspense>
      </Section>

      <Section title="Empty">
        <NotesGrid notes={[]} courses={COURSES} query="" course={null} remove={fakeRemove} />
      </Section>
    </main>
  );
}
