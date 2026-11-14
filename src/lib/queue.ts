/**
 * What to do first: the order of the queue.
 *
 * Pure functions only. The current time is passed in as `now`; nothing here
 * reads the clock. Weekday names are in Europe/Helsinki time (via `dates.ts`).
 *
 * No effort-aware ordering: a big task due later never jumps ahead of a small
 * one due sooner. Order is by due time only.
 */

import { listDate } from "./dates";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a handed-in assignment stays in `done`. */
export const DONE_WINDOW_MS = 7 * DAY_MS;

/** How long an unopened assignment counts as New. */
export const NEW_WINDOW_MS = 3 * DAY_MS;

/**
 * The fields the queue needs from one assignment. Structural on purpose, with
 * the snake_case names of the database row, so a row can be passed in as is
 * once the schema exists.
 */
export type QueueAssignment = {
  id: string;
  /** When it is due. `null` when the course set no due date. */
  due_at: Date | null;
  /**
   * When it was handed in. This is the only "handed in" signal: `null` means
   * open, a date means handed in. There is no separate status flag, so a
   * handed-in assignment without a hand-in time cannot exist here; a caller
   * that only knows "submitted" must pass its best time (for example the sync
   * time) or the assignment stays open.
   */
  submitted_at: Date | null;
  /** When our sync first saw it. */
  first_seen_at: Date;
  /** When she first opened it in the app. `null` means never opened. */
  seen_at: Date | null;
  /**
   * True when it arrived in the very first sync of her account. Everything in
   * that sync is already known to her, so none of it is New.
   */
  from_first_sync: boolean;
};

export type Queue<A extends QueueAssignment = QueueAssignment> = {
  /** The earliest-due open assignment, or `null` when nothing is open. */
  first: A | null;
  /** The other open assignments, earliest due first; no due date last. */
  then: A[];
  /** Handed in within the last 7 days, newest hand-in first. */
  done: A[];
};

function byDue(a: QueueAssignment, b: QueueAssignment): number {
  if (a.due_at && b.due_at) {
    const diff = a.due_at.getTime() - b.due_at.getTime();
    if (diff !== 0) return diff;
  } else if (a.due_at) {
    return -1;
  } else if (b.due_at) {
    return 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function bySubmittedDesc(a: QueueAssignment, b: QueueAssignment): number {
  const diff = (b.submitted_at?.getTime() ?? 0) - (a.submitted_at?.getTime() ?? 0);
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Split assignments into what to do first, what comes after, and what was
 * recently handed in.
 * - Open (no `submitted_at`): sorted by `due_at`, earliest first, overdue ones
 *   included (they sort first). No due date goes last. Ties break on `id` so
 *   the order is stable.
 * - Done: `submitted_at` within the last 7 days of `now` (exactly 7 days ago
 *   still counts), newest first. Older hand-ins are left out entirely.
 */
export function buildQueue<A extends QueueAssignment>(assignments: readonly A[], now: Date): Queue<A> {
  const nowMs = now.getTime();
  const open = assignments.filter((a) => a.submitted_at === null).sort(byDue);
  const done = assignments
    .filter((a) => a.submitted_at !== null && nowMs - a.submitted_at.getTime() <= DONE_WINDOW_MS)
    .sort(bySubmittedDesc);
  return { first: open[0] ?? null, then: open.slice(1), done };
}

/**
 * New badge: first seen under 3 days ago (exactly 3 days is no longer New),
 * never opened, and not part of the very first sync.
 */
export function isNew(a: QueueAssignment, now: Date): boolean {
  if (a.from_first_sync) return false;
  if (a.seen_at !== null) return false;
  return now.getTime() - a.first_seen_at.getTime() < NEW_WINDOW_MS;
}

const WEEKDAY_NAMES: Record<string, string> = {
  MON: "Monday",
  TUE: "Tuesday",
  WED: "Wednesday",
  THU: "Thursday",
  FRI: "Friday",
  SAT: "Saturday",
  SUN: "Sunday",
};

/**
 * The weekday of the next deadline after `first`, in Helsinki time, written
 * as a capitalised word ("Tuesday"), for "Nothing else is due before Tuesday".
 *
 * The next deadline is the earliest due time in `then` that is not already
 * past at `now` (an overdue item in `then` is not something she is clear
 * until). Returns `null` when there is no `first`, or nothing after it has a
 * future due date.
 *
 * A deadline 7 or more days ahead still gives just its weekday; the caller
 * decides whether that sentence still makes sense.
 */
export function clearUntil(queue: Queue, now: Date): string | null {
  if (!queue.first) return null;
  const nowMs = now.getTime();
  const next = queue.then.find((a) => a.due_at !== null && a.due_at.getTime() >= nowMs);
  if (!next?.due_at) return null;
  // listDate starts with the Helsinki weekday, e.g. "TUE 17 · 23:59".
  return WEEKDAY_NAMES[listDate(next.due_at).slice(0, 3)];
}
