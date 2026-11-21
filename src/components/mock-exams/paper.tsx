/*
 * Mock exams (M3-60): the pieces that make a question screen read like the teacher's paper.
 *
 * - `PaperHeader`: two lines left (course, school), two lines right (exam name, author), a rule.
 * - `PaperQuestion`: "2." hanging before the prompt, as on his paper.
 * - `PartLine`: "(a)" / "i." hanging, the text, the points right-aligned in his form "(2p)".
 * - `Formula`: centred on its own line, in the serif italic.
 * - `PaperTable`: a top and a bottom rule and a thin one under the head, no boxes; numbers right.
 * - `SectionContext`: a section's stem, formula, figure and table in paper order.
 *
 * The paper text is the display serif at reading weight; the app chrome around it stays sans.
 * Wording is rendered verbatim.
 */
import type { ReactNode } from "react";
import type { ExamTable, PaperSection } from "@/lib/mock-exams/types";
import { ExamFigure } from "./figure";
import { paperPoints } from "./format";

export function PaperHeader({ header }: { header: { left: string[]; right: string[] } }) {
  return (
    <header
      className="flex items-start justify-between gap-4 border-b border-ink-3 pb-1.5 font-display text-[13px] leading-snug text-ink-2"
      data-testid="paper-header"
    >
      <div className="min-w-0">
        {header.left.map((l) => (
          <div key={l}>{l}</div>
        ))}
      </div>
      <div className="min-w-0 text-right">
        {header.right.map((l) => (
          <div key={l}>{l}</div>
        ))}
      </div>
    </header>
  );
}

/** The paper's body type. */
export const PAPER = "font-display text-[16.5px] leading-[1.55] text-ink [font-variation-settings:'opsz'_14]";

export function PaperQuestion({ number, prompt, children }: { number: number; prompt?: string; children?: ReactNode }) {
  return (
    <section className={`${PAPER} grid grid-cols-[1.6em_1fr]`} aria-labelledby={`q${number}-h`}>
      <h2 id={`q${number}-h`} className="font-[inherit] text-[inherit] font-normal">
        {number}.<span className="sr-only"> Question {number}</span>
      </h2>
      <div className="min-w-0">
        {prompt ? <p>{prompt}</p> : null}
        {children}
      </div>
    </section>
  );
}

export function PartLine({
  label,
  text,
  points,
  id,
  children,
}: {
  label: string;
  text: string;
  points?: number;
  id?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mt-3 grid grid-cols-[2.1em_1fr] gap-x-1">
      <span className="text-ink-2">{label}</span>
      <div className="min-w-0">
        <p id={id}>
          {text}
          {points != null ? (
            <span className="float-right ml-3 whitespace-nowrap pl-2 text-ink-2" data-testid="paper-points">
              {paperPoints(points)}
            </span>
          ) : null}
        </p>
        {children}
      </div>
    </div>
  );
}

export function Formula({ children }: { children: string }) {
  return (
    <div className="my-3 overflow-x-auto text-center italic" role="math" aria-label={children}>
      {children}
    </div>
  );
}

const numeric = (v: string | number) => typeof v === "number" || /^[−-]?\d[\d.,]*%?$/.test(String(v).trim());

export function PaperTable({ table }: { table: ExamTable }) {
  return (
    <div className="my-4 overflow-x-auto" tabIndex={0} role="region" aria-label="Table" data-testid="paper-table">
      <table className="mx-auto w-full min-w-[300px] border-collapse border-y border-ink text-[14.5px] leading-snug">
        <thead>
          <tr className="border-b border-ink-3">
            {table.columns.map((c, i) => (
              <th
                key={c}
                scope="col"
                className={`px-2 py-1 font-normal ${i === 0 ? "text-left" : "text-right"} first:pl-0 last:pr-0`}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="py-0.5 pr-2 text-left font-normal">
                    {c}
                  </th>
                ) : (
                  <td key={i} className={`px-2 py-0.5 tabular-nums last:pr-0 ${numeric(c) ? "text-right" : "text-left"}`}>
                    {c}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SectionContext({ section }: { section: Omit<PaperSection, "parts"> }) {
  return (
    <>
      {section.stem ? <p className="whitespace-pre-line">{section.stem}</p> : null}
      {section.formula ? <Formula>{section.formula}</Formula> : null}
      {section.figure ? <ExamFigure figure={section.figure} /> : null}
      {section.table ? <PaperTable table={section.table} /> : null}
    </>
  );
}

/** A labelled section "(a)" with its context, then its parts (rendered by the caller). */
export function PaperSectionBlock({
  section,
  children,
}: {
  section: Omit<PaperSection, "parts">;
  children: ReactNode;
}) {
  if (!section.label) {
    return (
      <div className="mt-3">
        <SectionContext section={section} />
        {children}
      </div>
    );
  }
  return (
    <div className="mt-3 grid grid-cols-[2.1em_1fr] gap-x-1">
      <span className="text-ink-2">{section.label}</span>
      <div className="min-w-0">
        <SectionContext section={section} />
        {children}
      </div>
    </div>
  );
}
