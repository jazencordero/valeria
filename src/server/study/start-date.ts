/**
 * The day an exam's new cards open (ticket M3-53).
 *
 * A hand-made bundle can say "start new material on this day" (`startNewOn`, stored in
 * `exams.start_new_on` as a Helsinki calendar day, `YYYY-MM-DD`). Before that day a session
 * must not introduce a card she has never graded; cards she has already graded are reviewed as
 * usual. From 00:00 Helsinki time on that day, new cards are allowed. An exam with no start day
 * has no hold.
 *
 * Pure: the caller passes the exam row (or just its `startNewOn`) and `now`.
 */
import { daysBetween, TIME_ZONE } from "@/lib/dates";

/**
 * Thrown when a session is asked for an exam whose Helsinki day is over (`examOver`): nothing
 * is started. `/study/new` catches it and sends her to the exam's page, which says so.
 */
export class ExamOver extends Error {
  constructor(public readonly examId: string) {
    super(`Exam ${examId} is over.`);
    this.name = "ExamOver";
  }
}

/** True from 00:00 Helsinki time on the day after the exam's day: the exam is over. */
export function examOver(exam: { at: Date }, now: Date): boolean {
  return daysBetween(now, exam.at) < 0;
}

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Helsinki calendar day of an instant, as `YYYY-MM-DD`. */
export function helsinkiDay(at: Date): string {
  const parts: Record<string, string> = {};
  for (const p of dayFormat.formatToParts(at)) if (p.type !== "literal") parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** False before the exam's `startNewOn` (a Helsinki day); true from that day on, or with no start day. */
export function newCardsAllowed(exam: { startNewOn?: string | null }, now: Date): boolean {
  const start = exam.startNewOn;
  if (!start) return true;
  return helsinkiDay(now) >= start.slice(0, 10);
}
