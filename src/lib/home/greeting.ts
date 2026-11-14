/**
 * The one-sentence greeting on Home, by rule. No AI: every number and name
 * comes from the arguments.
 *
 * Pure: the current time is passed in as `now`, never read from the clock.
 * Weekdays, "today", "tonight", "tomorrow" and "yesterday" are Helsinki
 * calendar days (via `dates.ts`).
 *
 * Priority, first match wins:
 * 1. Just handed in: "Handed in, 5 hours early. Next up is Tuesday's memo, or
 *    a 5-minute bite for Friday's exam."
 * 2. Just studied: "Nice. Friday's exam forecast is up to 68%."
 * 3. Something late: "Hi Aino. Case memo 2 was due yesterday. Start there."
 *    The ticket lists this after the "nothing due for 2+ days" case, but that
 *    case is never true while something is late, and a late item is the most
 *    urgent thing on the page, so it wins over everything that is not a
 *    reaction to what she just did. Only the oldest late item is named.
 * 4. Something due today or tomorrow: "Hi Aino. One thing is due tonight,
 *    then you are clear until Tuesday." The ticket says "today"; tomorrow uses
 *    the same pattern ("due tomorrow"), since the "2 or more days" case below
 *    would otherwise leave tomorrow with no sentence. "tonight" when the
 *    earliest of those is due at 17:00 or later, "today" before that.
 * 5. Nothing due for 2 or more days: "Hi Aino. Nothing is due before Thursday.
 *    A good day for a bite." Open items without any due date: "Nothing has a
 *    due date. A good day for a bite."
 * 6. Nothing open: "Hi Aino. Nothing open. Enjoy it."
 *
 * Naming a day:
 * - A due time 2 to 6 calendar days ahead is its weekday ("Tuesday").
 * - 7 or more days away (either way) it gets the date too ("Tuesday 24 Nov"),
 *   so the weekday is never ambiguous.
 * - Late: "was due earlier today", "was due yesterday", "was due on Tuesday".
 * - Possessive "next up" / exam names: today's, tomorrow's, Tuesday's
 *   followed by the title exactly as given ("Tuesday's memo"). Pass short
 *   titles. With no due date, a due time already past, or 7+ days ahead, the
 *   title is used alone ("Next up is Case memo 2"). An exam is "<day>'s exam";
 *   past or 7+ days ahead it falls back to its title as given, else "your exam".
 *
 * Counts: "One thing", "Two things" ... "Ten things" in words, 11 and up in
 * digits ("11 things").
 *
 * No first name (missing or blank): "Hi there."
 */

import { daysBetween, listDate, dateLine, type DateInput } from "../dates";
import type { Queue, QueueAssignment } from "../queue";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** An assignment in the queue, with the short title the greeting can name. */
export type GreetingAssignment = QueueAssignment & { title: string };

/** The hand-in she just made. */
export type JustHandedIn = {
  title: string;
  submittedAt: DateInput;
  /** `null` when the course set no due date. */
  dueAt: DateInput | null;
};

/** The study session she just finished. */
export type JustStudied = {
  /** Used only when the exam is past or 7+ days away. */
  examTitle?: string;
  /** The new forecast as a percentage, 0 to 100. Rounded to a whole number. */
  forecast: number;
  examAt: DateInput;
};

/** The next exam, for the "or a 5-minute bite" offer. */
export type NextExam = {
  /** Used only when the exam is 7+ days away. */
  title?: string;
  at: DateInput;
};

export type GreetingInput = {
  firstName?: string | null;
  queue: Queue<GreetingAssignment>;
  now: Date;
  justHandedIn?: JustHandedIn | null;
  justStudied?: JustStudied | null;
  nextExam?: NextExam | null;
};

const WEEKDAY: Record<string, string> = {
  MON: "Monday",
  TUE: "Tuesday",
  WED: "Wednesday",
  THU: "Thursday",
  FRI: "Friday",
  SAT: "Saturday",
  SUN: "Sunday",
};

const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

const ms = (d: DateInput) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "One thing is", "Two things are", "11 things are". */
function thingsAre(n: number): string {
  const word = n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
  return n === 1 ? `${word} thing is` : `${word} things are`;
}

/** "Tuesday" within 6 days either way, "Tuesday 24 Nov" further. */
function dayName(at: DateInput, now: Date): string {
  const weekday = WEEKDAY[listDate(at).slice(0, 3)];
  if (Math.abs(daysBetween(now, at)) < 7) return weekday;
  // dateLine is "TUE 24 NOV · 23:59".
  const [, day, mon] = dateLine(at).split(" ");
  return `${weekday} ${day} ${capitalise(mon.toLowerCase())}`;
}

/** "today's", "tomorrow's", "Tuesday's"; `null` when past or 7+ days ahead. */
function possessive(at: DateInput, now: Date): string | null {
  if (ms(at) < now.getTime()) return null;
  const days = daysBetween(now, at);
  if (days === 0) return "today's";
  if (days === 1) return "tomorrow's";
  if (days < 7) return `${WEEKDAY[listDate(at).slice(0, 3)]}'s`;
  return null;
}

function examName(at: DateInput, title: string | undefined, now: Date): string {
  const pos = possessive(at, now);
  if (pos) return `${pos} exam`;
  return title?.trim() || "your exam";
}

function hello(firstName: string | null | undefined): string {
  const name = firstName?.trim();
  return name ? `Hi ${name}.` : "Hi there.";
}

/** "5 hours early", "1 day early", "12 minutes late", "on time". Rounded down. */
function handInTiming(submittedAt: DateInput, dueAt: DateInput): string {
  const diff = ms(dueAt) - ms(submittedAt);
  const abs = Math.abs(diff);
  if (abs < MINUTE_MS) return "on time";
  const side = diff > 0 ? "early" : "late";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ${side}`;
  if (abs >= DAY_MS) return unit(Math.floor(abs / DAY_MS), "day");
  if (abs >= HOUR_MS) return unit(Math.floor(abs / HOUR_MS), "hour");
  return unit(Math.floor(abs / MINUTE_MS), "minute");
}

function nextUp(queue: Queue<GreetingAssignment>, nextExam: NextExam | null | undefined, now: Date): string {
  const first = queue.first;
  let task: string | null = null;
  if (first) {
    const pos = first.due_at ? possessive(first.due_at, now) : null;
    task = pos ? `${pos} ${first.title}` : first.title;
  }
  const exam =
    nextExam && ms(nextExam.at) >= now.getTime()
      ? `a 5-minute bite for ${examName(nextExam.at, nextExam.title, now)}`
      : null;
  if (task && exam) return `Next up is ${task}, or ${exam}.`;
  if (task) return `Next up is ${task}.`;
  if (exam) return `Next up is ${exam}.`;
  return "Nothing else is open.";
}

/** "was due yesterday", "was due earlier today", "was due on Tuesday". */
function wasDue(due: Date, now: Date): string {
  const days = daysBetween(due, now);
  if (days <= 0) return "was due earlier today";
  if (days === 1) return "was due yesterday";
  return `was due on ${dayName(due, now)}`;
}

/** The Helsinki hour of a due time, from listDate "TUE 17 · 23:59". */
function hourOf(at: DateInput): number {
  return Number(listDate(at).split("· ")[1].slice(0, 2));
}

/**
 * One sentence for the top of Home. See the file comment for the six cases
 * and their priority.
 */
export function greeting(input: GreetingInput): string {
  const { firstName, queue, now, justHandedIn, justStudied, nextExam } = input;
  const nowMs = now.getTime();

  if (justHandedIn) {
    const timing = justHandedIn.dueAt ? `Handed in, ${handInTiming(justHandedIn.submittedAt, justHandedIn.dueAt)}.` : "Handed in.";
    return `${timing} ${nextUp(queue, nextExam, now)}`;
  }

  if (justStudied) {
    const exam = capitalise(examName(justStudied.examAt, justStudied.examTitle, now));
    return `Nice. ${exam} forecast is up to ${Math.round(justStudied.forecast)}%.`;
  }

  const hi = hello(firstName);
  const open = queue.first ? [queue.first, ...queue.then] : [];
  if (open.length === 0) return `${hi} Nothing open. Enjoy it.`;

  const dated = open.filter((a): a is GreetingAssignment & { due_at: Date } => a.due_at !== null);
  const late = dated.filter((a) => a.due_at.getTime() < nowMs);
  if (late.length > 0) {
    // The queue is in due order, so the first late one is the oldest.
    const oldest = late[0];
    return `${hi} ${capitalise(oldest.title)} ${wasDue(oldest.due_at, now)}. Start there.`;
  }

  if (dated.length === 0) return `${hi} Nothing has a due date. A good day for a bite.`;

  const soonest = dated[0];
  const days = daysBetween(now, soonest.due_at);
  if (days <= 1) {
    const sameDayItems = dated.filter((a) => daysBetween(now, a.due_at) === days);
    const when = days === 0 ? (hourOf(soonest.due_at) >= 17 ? "tonight" : "today") : "tomorrow";
    const after = dated.find((a) => daysBetween(now, a.due_at) > days);
    const clear = after ? `then you are clear until ${dayName(after.due_at, now)}` : "then you are clear";
    return `${hi} ${thingsAre(sameDayItems.length)} due ${when}, ${clear}.`;
  }

  return `${hi} Nothing is due before ${dayName(soonest.due_at, now)}. A good day for a bite.`;
}
