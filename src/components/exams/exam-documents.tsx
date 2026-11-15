/**
 * Exam documents (M3-54): the quiet list at the end of the exam page's Today
 * tab. One row per document her bundle brought (study plan, exam-day sheet,
 * mock exams, answers): the title and its reading minutes. Each row opens
 * `/exams/<id>/documents/<slug>` (`DocumentReader`). Nothing renders when the
 * exam has none.
 *
 * Plain data in, in the order given (the page loads them by `position`). No
 * hooks and no "use client", so the server can use `readingMinutes` too.
 * M9-23 moves this list into the Notes tab.
 */
import Link from "next/link";

export type ExamDocumentRow = {
  slug: string;
  title: string;
  /** Reading minutes, at least 1 (`readingMinutes`). */
  minutes: number;
};

export type ExamDocumentsProps = {
  examId: string;
  documents: readonly ExamDocumentRow[];
  className?: string;
};

/** Words a minute for "N min". */
export const WORDS_PER_MINUTE = 200;

/** Words in a Markdown text, without its markers (#, *, |, `, list dashes and numbers). */
export function wordCount(markdown: string): number {
  return markdown.replace(/^\s*\d+[.)]\s/gm, " ").match(/[\p{L}\p{N}]+(?:['’.,:-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/** Reading minutes at about 200 words a minute; never less than 1. */
export function readingMinutes(markdown: string): number {
  return Math.max(1, Math.round(wordCount(markdown) / WORDS_PER_MINUTE));
}

export const documentHref = (examId: string, slug: string) =>
  `/exams/${encodeURIComponent(examId)}/documents/${encodeURIComponent(slug)}`;

const LABEL =
  "mono mb-1 font-medium uppercase tracking-[0.04em] text-ink-3 [font-variation-settings:normal]";

const Chevron = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className="h-4 w-4 flex-none fill-none stroke-current text-ink-3"
    style={{ strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }}
  >
    <path d="M9.5 5.5L16 12l-6.5 6.5" />
  </svg>
);

export function ExamDocuments({ examId, documents, className = "" }: ExamDocumentsProps) {
  if (documents.length === 0) return null;
  const labelId = `exam-documents-${examId}`;
  return (
    <section aria-labelledby={labelId} className={className} data-exam-documents="">
      <h3 id={labelId} className={LABEL}>
        Exam documents
      </h3>
      <ul className="list-none p-0">
        {documents.map((d) => (
          <li key={d.slug} data-document={d.slug} className="border-b border-solid border-line">
            <Link
              href={documentHref(examId, d.slug)}
              className={
                "group flex min-h-[48px] items-center gap-3 py-2.5 text-ink no-underline " +
                "focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              }
            >
              <span className="min-w-0 flex-1 text-[15px] leading-[1.35] font-medium [overflow-wrap:anywhere] group-hover:underline group-hover:decoration-ink-3 group-hover:underline-offset-2">
                {d.title}
              </span>
              <span className="mono flex-none text-ink-3">{d.minutes} min</span>
              <Chevron />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
