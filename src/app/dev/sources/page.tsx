"use client";

import { SourceChips, SourcesColumn, type SourceFile } from "@/components/work/sources";

const files: SourceFile[] = [
  { id: "f-brief", name: "A3_brief.pdf", mime: "application/pdf", course: "Forecasting Methods", readable: true },
  {
    id: "f-lecture",
    name: "Lecture 6 Exponential smoothing.pdf",
    mime: "application/pdf",
    course: "Forecasting Methods",
    readable: true,
  },
  { id: "f-data", name: "weekly_demand.csv", mime: "text/csv", course: "Forecasting Methods", readable: true },
  { id: "f-scan", name: "whiteboard_notes.jpg", mime: "image/jpeg", course: "Forecasting Methods", readable: false },
];

function Workspace({ title, list, lmsName }: { title: string; list: SourceFile[]; lmsName: string }) {
  return (
    <section className="space-y-3">
      <h2 className="type-h22">{title}</h2>
      <div className="flex h-[420px] overflow-hidden rounded-2xl border border-line bg-paper">
        <SourcesColumn files={list} lmsName={lmsName} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-line bg-surface px-[var(--pad)] py-2.5">
            <p className="text-[18px] font-semibold leading-[1.25]">Assignment 3</p>
            <p className="mono mt-0.5 text-due">Due 21:00 · 5 h 12 min left</p>
          </header>
          <SourceChips files={list} lmsName={lmsName} />
          <div className="flex-1 p-[var(--pad)] text-[15px] text-ink-3">Chat goes here.</div>
        </div>
      </div>
    </section>
  );
}

export default function SourcesPage() {
  return (
    <main className="mx-auto max-w-5xl space-y-10 px-5 py-10">
      <header className="space-y-3">
        <h1 className="type-h30">Sources</h1>
        <p className="ink-2">
          From 700 px the attached course files sit in a left column. Under 700 px they are chips
          above the chat; a chip opens a small popover with the same line and an Open link. Escape
          or a click outside closes it. The last file could not be read yet.
        </p>
      </header>
      <Workspace title="Aalto (MyCourses)" list={files} lmsName="MyCourses" />
      <Workspace title="One file, plain Moodle" list={files.slice(0, 1)} lmsName="Moodle" />
    </main>
  );
}
