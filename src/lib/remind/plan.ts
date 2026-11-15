/**
 * Reminders and the one daily nudge (M7-07). Pure: the current time is passed
 * in as `now`, what was already sent is passed in as `sentLog`; nothing here
 * reads the clock, the database or the network. The cron route
 * (src/app/api/cron/remind/route.ts) feeds it and sends what it returns.
 *
 *   dueReminders(items, now, sentLog)  // deadlines and exams: the day before, and 3 h before
 *   nudge(exams, now, sentToday)       // at most one "cards are slipping" a day, at 17:00
 *
 * All times are Europe/Helsinki wall-clock times; daylight saving is the
 * runtime's job (Intl), as in src/lib/dates.ts.
 *
 * Rules and choices:
 * - Two reminders per deadline, exam or quiz that is not handed in or
 *   finished: `day_before` at 18:00 on the Helsinki calendar day before its
 *   day, and `3h` three hours before it. An item marked `done`, or whose time
 *   has come, gets nothing. (The route passes `itemsForUser`, which already
 *   leaves out handed-in and graded assignments.)
 * - Never twice: a reminder's key is the item id (`ref`) plus its `kind`
 *   ('day_before' | '3h'), the same pair `reminder_log` is unique on. Anything
 *   in `sentLog` is never returned again. If she moves an exam after its
 *   reminder went out, it is not sent again for the new time.
 * - Not late beyond reason: a reminder is sent only within WINDOW_MS (1 hour)
 *   after its time. The tick runs once an hour, so every reminder is caught
 *   by the first run after its time; one that missed that run (push not set
 *   up yet, the run failed) is dropped rather than sent hours late.
 * - Quiet hours, 21:00 to 08:00: nothing is sent then (checked against `now`).
 *   A `3h` reminder meant for 20:00 to 20:59 (an item from 23:00 to 23:59,
 *   the usual Moodle deadline) goes out at 20:00 instead, so the hourly run
 *   can still send it before 21:00; it then says the true time left
 *   ("3 h 59 min left"). A `3h` reminder whose time falls in quiet hours (an
 *   item between 00:00 and 10:59) is dropped, not moved: every such item already had its
 *   `day_before` reminder at 18:00 the evening before, at most 17 hours
 *   earlier, and a second push that same evening would only repeat it.
 *   The 18:00 and 17:00 times are never quiet themselves, but a run up to an
 *   hour late still checks `now`.
 * - The nudge: once a Helsinki day at most (`sentToday`, the route keeps it in
 *   `reminder_log` as kind 'nudge' with the day as `ref`), fixed at 17:00 with
 *   the same 1-hour window, only when cards are slipping. Copy is exactly
 *   "3 Holt-Winters cards are slipping. 2 minutes." ("1 … card is slipping.")
 *   and nothing else: never "we miss you".
 * - Slipping card: a card she has graded (it has a memory, a last review and
 *   is not New), in an exam or quiz that has not started, that is due now:
 *   its stored (exam-aimed) due time has come, or its predicted recall now is
 *   below the recall wanted with this many days left (`wantedRecall`, the rule
 *   `aimedDue` schedules by). Cards she never graded are new, not slipping.
 * - Which concept the nudge names: a card counts for its first concept (as on
 *   the exam page); cards without a concept are not counted. The concept with
 *   the most slipping cards wins; ties go to the sooner exam, then the
 *   earlier concept. Minutes are `biteMinutes(count)` from src/lib/study/bite.ts
 *   (0.6 min a card, at least 2).
 */
import { timeLeft, TIME_ZONE, type DateInput } from "@/lib/dates";
import { biteMinutes } from "@/lib/study/bite";
import { wantedRecall } from "@/lib/study/exam-aim";
import { recallAt, type MemoryState } from "@/lib/study/memory";

export type ReminderKind = "day_before" | "3h" | "nudge";

export type RemindItem = {
  id: string | number;
  kind: "deadline" | "exam" | "quiz";
  title: string;
  /** Course code or name; may be empty. */
  course: string;
  /** When it is due, or when the exam starts. */
  at: DateInput;
  /** True when handed in or finished: no reminders. */
  done?: boolean;
};

export type SentEntry = { ref: string; kind: string };

export type Reminder = {
  /** `reminder_log.ref`: the item id, or the Helsinki day (`YYYY-MM-DD`) for a nudge. */
  ref: string;
  kind: ReminderKind;
  /** When it was meant to go out. */
  at: Date;
  title: string;
  body: string;
  /** A path in this app for the notification to open. */
  url: string;
};

export type NudgeCard = {
  conceptIds: readonly string[];
  /** Null for a card she has never graded. `dueAt` is the stored, exam-aimed due time. */
  memory: { fsrs: MemoryState; dueAt: DateInput } | null;
};

export type NudgeExam = {
  exam: { id: string; title: string; at: DateInput };
  /** In exam order. */
  concepts: readonly { id: string; name: string }[];
  cards: readonly NudgeCard[];
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long after its time a reminder may still go out. */
export const WINDOW_MS = HOUR_MS;
/** Quiet from 21:00 up to (not including) 08:00. */
export const QUIET_FROM = 21;
export const QUIET_UNTIL = 8;
export const DAY_BEFORE_HOUR = 18;
export const BEFORE_MS = 3 * HOUR_MS;
export const NUDGE_HOUR = 17;

const REMINDER_URL = "/calendar";
const NUDGE_URL = "/exams";

// ---------------------------------------------------------------------------
// Helsinki wall clock

const partsFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

type Local = { year: number; month: number; day: number; hour: number; minute: number };

function ms(input: DateInput): number {
  return input instanceof Date ? input.getTime() : new Date(input).getTime();
}

function local(at: number): Local {
  const out: Record<string, number> = {};
  for (const p of partsFormat.formatToParts(new Date(at))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour === 24 ? 0 : out.hour, minute: out.minute };
}

function offsetAt(at: number): number {
  const p = local(at);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(at / MINUTE_MS) * MINUTE_MS;
}

/** The instant of a Helsinki wall-clock time; `day` may be out of range (Date.UTC rolls it over). */
function helsinki(year: number, month: number, day: number, hour: number): number {
  const guess = Date.UTC(year, month - 1, day, hour);
  let at = guess - offsetAt(guess);
  const second = offsetAt(at);
  if (guess - second !== at) at = guess - second;
  return at;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function clock(at: number): string {
  const { hour, minute } = local(at);
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** The Helsinki calendar day of an instant, `YYYY-MM-DD`. */
export function helsinkiDay(at: DateInput): string {
  const { year, month, day } = local(ms(at));
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** True from 21:00 to 07:59 Helsinki time. */
export function isQuiet(at: DateInput): boolean {
  const { hour } = local(ms(at));
  return hour >= QUIET_FROM || hour < QUIET_UNTIL;
}

/** 18:00 Helsinki on the calendar day before the item's day. */
export function dayBeforeAt(at: DateInput): Date {
  const { year, month, day } = local(ms(at));
  return new Date(helsinki(year, month, day - 1, DAY_BEFORE_HOUR));
}

/** 17:00 Helsinki on the day of `now`. */
export function nudgeAt(now: DateInput): Date {
  const { year, month, day } = local(ms(now));
  return new Date(helsinki(year, month, day, NUDGE_HOUR));
}

/**
 * When the `3h` reminder of an item at `at` is meant to go out: 3 hours before,
 * except that a time from 20:00 to 20:59 moves to 20:00, so the hourly run
 * still sends it before quiet hours start (a 23:59 deadline is told at 20:00).
 * A time in quiet hours is left as it is; `dueReminders` drops it.
 */
export function threeHoursBefore(at: DateInput): number {
  const before = ms(at) - BEFORE_MS;
  const p = local(before);
  if (p.hour !== QUIET_FROM - 1) return before;
  return helsinki(p.year, p.month, p.day, QUIET_FROM - 1);
}

/** True while a reminder meant for `at` may go out at `now`. */
function inWindow(at: number, now: number): boolean {
  return at <= now && now < at + WINDOW_MS;
}

/** True during the hour the nudge may go out; the route loads decks only then. */
export function isNudgeHour(now: DateInput): boolean {
  return inWindow(nudgeAt(now).getTime(), ms(now)) && !isQuiet(now);
}

// ---------------------------------------------------------------------------
// Deadlines and exams

function what(kind: RemindItem["kind"]): string {
  return kind === "deadline" ? "Due" : "Starts";
}

function prefix(course: string): string {
  const c = course.trim();
  return c ? `${c} · ` : "";
}

/** The reminders to send now, soonest item first. */
export function dueReminders(
  items: readonly RemindItem[],
  now: DateInput,
  sentLog: readonly SentEntry[],
): Reminder[] {
  const t = ms(now);
  if (isQuiet(t)) return [];
  const sent = new Set(sentLog.map((e) => `${e.kind}\n${e.ref}`));
  const out: Reminder[] = [];

  for (const item of [...items].sort((a, b) => ms(a.at) - ms(b.at))) {
    const at = ms(item.at);
    if (item.done || !Number.isFinite(at) || at <= t) continue;
    const ref = String(item.id);

    const dayBefore = dayBeforeAt(at).getTime();
    if (inWindow(dayBefore, t) && !sent.has(`day_before\n${ref}`)) {
      out.push({
        ref,
        kind: "day_before",
        at: new Date(dayBefore),
        title: item.title,
        body: `${prefix(item.course)}${what(item.kind)} tomorrow at ${clock(at)}.`,
        url: REMINDER_URL,
      });
    }

    const before = threeHoursBefore(at);
    if (!isQuiet(before) && inWindow(before, t) && !sent.has(`3h\n${ref}`)) {
      out.push({
        ref,
        kind: "3h",
        at: new Date(before),
        title: item.title,
        body: `${prefix(item.course)}${what(item.kind)} at ${clock(at)} · ${timeLeft(at, t)}.`,
        url: REMINDER_URL,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The daily nudge

function graded(card: NudgeCard): card is NudgeCard & { memory: NonNullable<NudgeCard["memory"]> } {
  const m = card.memory;
  return !!m && m.fsrs.lastReviewAt !== null && m.fsrs.state !== 0;
}

/** Whether a card counts as slipping at `now` for an exam at `examAt` (see the header). */
export function isSlipping(card: NudgeCard, examAt: DateInput, now: DateInput): boolean {
  const t = ms(now);
  const exam = ms(examAt);
  if (exam <= t || !graded(card)) return false;
  if (ms(card.memory.dueAt) <= t) return true;
  return recallAt(card.memory.fsrs, new Date(t)) < wantedRecall((exam - t) / DAY_MS);
}

/** The sentence: "3 Holt-Winters cards are slipping. 2 minutes." */
export function nudgeText(concept: string, count: number): string {
  const cards = count === 1 ? "card is" : "cards are";
  return `${count} ${concept} ${cards} slipping. ${biteMinutes(count)} minutes.`;
}

/** Today's nudge, or null: already sent today, not 17:00, quiet, or nothing slipping. */
export function nudge(exams: readonly NudgeExam[], now: DateInput, sentToday: boolean): Reminder | null {
  if (sentToday || !isNudgeHour(now)) return null;
  const t = ms(now);

  let best: { exam: NudgeExam; name: string; count: number } | null = null;
  const upcoming = exams.filter((e) => ms(e.exam.at) > t).sort((a, b) => ms(a.exam.at) - ms(b.exam.at));
  for (const exam of upcoming) {
    const counts = new Map<string, number>();
    for (const card of exam.cards) {
      const first = card.conceptIds[0];
      if (first === undefined || !isSlipping(card, exam.exam.at, t)) continue;
      counts.set(first, (counts.get(first) ?? 0) + 1);
    }
    for (const concept of exam.concepts) {
      const count = counts.get(concept.id) ?? 0;
      if (count > (best?.count ?? 0)) best = { exam, name: concept.name, count };
    }
  }
  if (!best) return null;

  return {
    ref: helsinkiDay(t),
    kind: "nudge",
    at: nudgeAt(t),
    title: best.exam.exam.title,
    body: nudgeText(best.name, best.count),
    url: NUDGE_URL,
  };
}
