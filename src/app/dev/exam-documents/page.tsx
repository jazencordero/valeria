"use client";

import type { ReactNode } from "react";
import { DocumentReader } from "@/components/exams/document-reader";
import { ExamDocuments, readingMinutes, type ExamDocumentRow } from "@/components/exams/exam-documents";

// Made-up sample documents. Never real course content.
const EXAM_ID = "00000000-0000-4000-8000-000000000054";

const words = (n: number) => Array.from({ length: n }, (_, i) => (i % 7 === 0 ? "loop" : "word")).join(" ");

const SEVEN: ExamDocumentRow[] = [
  { slug: "study-plan", title: "Study plan", minutes: readingMinutes(words(640)) },
  { slug: "exam-day-sheet", title: "Exam-day sheet", minutes: readingMinutes(words(150)) },
  { slug: "mock-exam-1", title: "Mock exam 1", minutes: readingMinutes(words(1180)) },
  { slug: "mock-exam-1-answers", title: "Mock exam 1: answers", minutes: readingMinutes(words(1520)) },
  { slug: "mock-exam-2", title: "Mock exam 2", minutes: readingMinutes(words(1010)) },
  { slug: "mock-exam-2-answers", title: "Mock exam 2: answers", minutes: readingMinutes(words(1400)) },
  {
    slug: "formula-sheet-and-the-things-teachers-say-every-year",
    title: "Formula sheet and the things the teachers say every single year",
    minutes: readingMinutes(words(420)),
  },
];

const LONG_TABLE = `# Mock exam 1: answers

Worked answers for the made-up mock exam. Read the **marking notes** before the answers.

## Marking notes

- Each question is worth **6 points**.
- Partial credit for a correct loop diagram, even with the wrong sign.
- Write units: \`days\`, \`units/week\`.

## Points per question

| Question | Topic | Full answer | Partial answer | Common mistake | Points | Time to spend |
|---|---|---|---|---|---|---|
| 1 | Balancing loops | Names the goal, the gap and the correction | Names the goal only | Calls it reinforcing | 6 | 12 min |
| 2 | Delays | Shows the overshoot and why it happens | Draws the overshoot without the delay | Forgets the delay box | 6 | 15 min |
| 3 | Stocks and flows | Inflow minus outflow, with units | Right shape, no units | Adds stock to flow | 6 | 10 min |
| 4 | Feedback in plans | Explains drift with one loop | Lists causes without a loop | Blames one person | 6 | 14 min |
| 5 | Policy levers | Picks the delay as the lever and says why | Picks a lever without a reason | Picks the stock | 6 | 9 min |

## A worked example

1. Find the stock: **orders waiting**.
2. Find the flows: orders in, orders shipped.
3. Mark the delay between ordering and arriving.

\`\`\`
stock(t+1) = stock(t) + inflow(t) - outflow(t)
\`\`\`

### What a full answer says

The loop is balancing: more orders waiting leads, after a delay, to more shipping, which brings the stock back toward the goal. Without counting the delay you keep ordering after the correction has already worked.

| Term | Meaning |
|---|---|
| Stock | What has piled up at one moment |
| Flow | How fast it changes |
`;

function Frame({ width, children }: { width: number; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="mono text-ink-3">{width} PX</p>
      <div className="overflow-hidden rounded-[20px] border border-line bg-paper" style={{ width, maxWidth: "100%" }}>
        {children}
      </div>
    </div>
  );
}

export default function ExamDocumentsPreview() {
  return (
    <main className="space-y-12 bg-paper px-4 py-10">
      <section className="mx-auto max-w-[760px] space-y-3">
        <h2 className="type-h22 text-ink">The list, seven documents</h2>
        <div className="rounded-[20px] border border-line bg-surface p-5">
          <ExamDocuments examId={EXAM_ID} documents={SEVEN} />
        </div>
      </section>

      <section className="mx-auto max-w-[760px] space-y-3">
        <h2 className="type-h22 text-ink">The list, none</h2>
        <div className="rounded-[20px] border border-dashed border-line p-5" data-testid="none">
          <ExamDocuments examId={EXAM_ID} documents={[]} />
        </div>
        <p className="mono text-ink-3">Nothing renders above.</p>
      </section>

      <section className="space-y-3">
        <h2 className="type-h22 mx-auto max-w-[760px] text-ink">The reader, a long table</h2>
        <Frame width={390}>
          <DocumentReader examId={EXAM_ID} title="Mock exam 1: answers" bodyMd={LONG_TABLE} minutes={readingMinutes(LONG_TABLE)} />
        </Frame>
        <Frame width={1200}>
          <DocumentReader examId={EXAM_ID} title="Mock exam 1: answers" bodyMd={LONG_TABLE} minutes={readingMinutes(LONG_TABLE)} />
        </Frame>
      </section>
    </main>
  );
}
