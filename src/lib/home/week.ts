/**
 * The "THIS WEEK" card on Home: a 7-day strip, the agenda under it and one
 * line. Source: prototype main-flow.html HTML 1486-1506.
 *
 * Pure: the current time is passed in as `now`, never read from the clock.
 * Days are Helsinki calendar days (via `dates.ts`). Seven days only, today
 * first; the Calendar tab shows further.
 *
 * Decisions:
 * - The window is today plus the next six Helsinki calendar days. Anything
 *   before today or seven or more days ahead is left out.
 * - One marker per day, the most important wins:
 *   exam ("exam", the ring) > something open due today ("due_today") >
 *   something open due that day ("deadline") > everything that day handed in
 *   ("done"). An exam today stays an exam. A day with nothing has no marker.
 *   Quizzes count as deadlines.
 * - The agenda lists open items from tomorrow to six days ahead, earliest
 *   first, as "TUE 17" plus the title. Today is left out: it is the filled
 *   day on the strip and the hero card above, which is why the prototype
 *   lists only Tuesday, Thursday and Friday under a Saturday that has
 *   something due. Done items are left out too (they show as the done dot).
 * - The line is about things to hand in (deadlines and quizzes); an exam is
 *   not "due", it shows on the strip and in the agenda.
 *   - Nothing open to hand in anywhere in the window: "Nothing due this week."
 *   - Something open after today: "Nothing else is due before Tuesday.",
 *     naming the weekday of the earliest one (full name, as in
 *     `queue.clearUntil`).
 *   - Something open today but nothing after it this week: no line (null).
 *     "Nothing due this week." would be false and the ticket gives no third
 *     sentence.
 * - `summary` is the sentence screen readers get for the strip, as in the
 *   prototype: "Due today. Deadlines Tuesday and Thursday. Exam Friday."
 *   Empty when there are no markers.
 */
import { daysBetween, listDate, type DateInput } from "@/lib/dates";

export type WeekItemKind = "deadline" | "exam" | "quiz";

export type WeekItem = {
  id: string;
  kind: WeekItemKind;
  title: string;
  /** Due time, or the start of the exam. */
  at: DateInput;
  /** Handed in (or the exam is over and marked done). */
  done: boolean;
};

export type WeekMarker = "due_today" | "deadline" | "exam" | "done";

export type WeekDay = {
  /** Helsinki weekday, upper case: "SAT". */
  weekday: string;
  /** Helsinki day of the month: 14. */
  day: number;
  today: boolean;
  marker: WeekMarker | null;
};

export type WeekAgendaRow = {
  id: string;
  /** "TUE 17". */
  date: string;
  title: string;
  kind: WeekItemKind;
};

export type WeekModel = {
  /** Always 7 days, today first. */
  days: WeekDay[];
  agenda: WeekAgendaRow[];
  /** "Nothing else is due before Tuesday." / "Nothing due this week." / null. */
  line: string | null;
  /** Screen-reader sentence for the strip, "" when nothing is marked. */
  summary: string;
};

export const WEEK_DAYS = 7;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const WEEKDAY_NAMES: Record<string, string> = {
  MON: "Monday",
  TUE: "Tuesday",
  WED: "Wednesday",
  THU: "Thursday",
  FRI: "Friday",
  SAT: "Saturday",
  SUN: "Sunday",
};

const RANK: Record<WeekMarker, number> = { exam: 4, due_today: 3, deadline: 2, done: 1 };

function ms(input: DateInput): number {
  return input instanceof Date ? input.getTime() : new Date(input).getTime();
}

/** "TUE 17" for an instant, in Helsinki. */
function shortDate(at: DateInput): string {
  return listDate(at).split(" · ")[0];
}

/**
 * An instant on the Helsinki calendar day `k` days after `now`. Adding 24 h
 * can stay on the same day (or skip one) next to a daylight saving change, so
 * nudge by 2 h until the calendar agrees.
 */
function instantOnDay(now: number, k: number): number {
  let t = now + k * DAY_MS;
  const off = daysBetween(now, t) - k;
  if (off < 0) t += 2 * HOUR_MS;
  if (off > 0) t -= 2 * HOUR_MS;
  return t;
}

function markerFor(item: WeekItem, index: number): WeekMarker {
  if (item.done) return "done";
  if (item.kind === "exam") return "exam";
  return index === 0 ? "due_today" : "deadline";
}

/** "Tuesday", "Tuesday and Thursday", "Monday, Tuesday and Thursday". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function buildSummary(days: WeekDay[]): string {
  const name = (d: WeekDay) => (d.today ? "today" : WEEKDAY_NAMES[d.weekday]);
  const of = (m: WeekMarker) => days.filter((d) => d.marker === m).map(name);
  const parts: string[] = [];
  if (days[0]?.marker === "due_today") parts.push("Due today.");
  const deadlines = of("deadline");
  if (deadlines.length) {
    parts.push(`${deadlines.length === 1 ? "Deadline" : "Deadlines"} ${joinNames(deadlines)}.`);
  }
  const exams = of("exam");
  if (exams.length) parts.push(`${exams.length === 1 ? "Exam" : "Exams"} ${joinNames(exams)}.`);
  const done = of("done");
  if (done.length) parts.push(`Done ${joinNames(done)}.`);
  return parts.join(" ");
}

export function weekModel(items: readonly WeekItem[], now: DateInput): WeekModel {
  const nowMs = ms(now);

  // Items inside the window, with their day index (0 = today).
  const inWeek = items
    .map((item) => ({ item, at: ms(item.at) }))
    .filter(({ at }) => Number.isFinite(at))
    .map((x) => ({ ...x, index: daysBetween(nowMs, x.at) }))
    .filter(({ index }) => index >= 0 && index < WEEK_DAYS)
    .sort((a, b) => a.at - b.at);

  const days: WeekDay[] = [];
  for (let k = 0; k < WEEK_DAYS; k++) {
    const [weekday, day] = shortDate(instantOnDay(nowMs, k)).split(" ");
    let marker: WeekMarker | null = null;
    for (const x of inWeek) {
      if (x.index !== k) continue;
      const m = markerFor(x.item, k);
      if (marker === null || RANK[m] > RANK[marker]) marker = m;
    }
    days.push({ weekday, day: Number(day), today: k === 0, marker });
  }

  const open = inWeek.filter(({ item }) => !item.done);
  const agenda: WeekAgendaRow[] = open
    .filter(({ index }) => index > 0)
    .map(({ item }) => ({ id: item.id, date: shortDate(item.at), title: item.title, kind: item.kind }));

  const due = open.filter(({ item }) => item.kind !== "exam");
  const next = due.find(({ index }) => index > 0);
  let line: string | null;
  if (due.length === 0) line = "Nothing due this week.";
  else if (next) line = `Nothing else is due before ${WEEKDAY_NAMES[shortDate(next.item.at).slice(0, 3)]}.`;
  else line = null;

  return { days, agenda, line, summary: buildSummary(days) };
}
