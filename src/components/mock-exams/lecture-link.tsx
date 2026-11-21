/*
 * Mock exams (M3-60): "Reread: Clustering and classification, slide 19". A link to her lecture
 * page when the server resolved one (`href`), plain text otherwise (a page with no lecture,
 * such as the exam essentials).
 */
import Link from "next/link";
import type { LectureRef } from "@/lib/mock-exams/types";
import { slidesText } from "./format";

export type LinkedLecture = LectureRef & { href?: string };

const BOOK = (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 flex-none fill-none stroke-current [stroke-linecap:round] [stroke-width:1.5]">
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5z" />
  </svg>
);

export function LectureLink({ lecture }: { lecture: LinkedLecture }) {
  const text = `Reread: ${slidesText(lecture)}`;
  if (!lecture.href) {
    return (
      <span className="inline-flex min-h-11 items-center gap-2 text-[14px] text-ink-2">
        {BOOK}
        {text}
      </span>
    );
  }
  return (
    <Link
      href={lecture.href}
      className="inline-flex min-h-11 items-center gap-2 text-[14px] text-ink underline decoration-line underline-offset-4 hover:decoration-ink-3"
    >
      {BOOK}
      {text}
    </Link>
  );
}
