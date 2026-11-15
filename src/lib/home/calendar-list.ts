/**
 * The Calendar tab's list: deadlines and exams by Helsinki day for the next
 * six weeks, runs of empty days folded into one line.
 * Source: prototype main-flow.html HTML 1603-1619 (#tab-cal).
 *
 *   const rows = calendarRows(items, now);
 *
 * Pure: the current time is passed in as `now`, never read from the clock.
 * Days are Helsinki calendar days (via `dates.ts`).
 *
 * Decisions:
 * - The window is today plus the next 41 days (6 weeks, CALENDAR_DAYS).
 *   Anything before today or on day 42 or later is left out. Something due
 *   earlier today still shows under today.
 * - A day with something on it is a "day" row. Its heading is "TUE 17 NOV";
 *   today's is "SAT 14 NOV · TODAY". There is no TOMORROW label (the
 *   prototype has none).
 * - Each item's line under the title:
 *   a deadline "Forecasting Methods · due 21:00";
 *   an exam or quiz "Strategic IT Management · 09:00" (it is not handed in,
 *   so not "due", as in the prototype); a whole-day exam (only its day is
 *   known) has no time, just "Strategic IT Management".
 * - Within a day: earliest first; at the same time exams, then quizzes, then
 *   deadlines; then by title, then id, so the order never wobbles.
 * - Empty days are a "gap" row. A run of two or more is one line
 *   "SUN 15 – MON 16 · Nothing due"; a single empty day is "WED 18 · Nothing
 *   due" (both as in the prototype, no month). A run that crosses into the
 *   next month names both months, "MON 30 NOV – TUE 1 DEC · Nothing due", so
 *   it never reads backwards ("SUN 29 – SAT 26"). A run at the end of the window
 *   is a gap line too, so the list always reaches the last day.
 * - An empty today is never folded into the run after it: it is its own line,
 *   "SAT 14 · TODAY · Nothing due", so today is always the first row.
 * - The caller decides what counts (the page leaves handed-in assignments out).
 */
import { dateLine, daysBetween, listDate, type DateInput } from "@/lib/dates";

/** Today plus 41 days. */
export const CALENDAR_DAYS = 42;

export type CalendarKind = "deadline" | "exam" | "quiz";
export type CourseColor = "butter" | "mint" | "sky" | "blush";

export type CalendarItem = {
  /** The assignment id for a deadline, the exam id for an exam or quiz. */
  id: string;
  kind: CalendarKind;
  title: string;
  /** Short course name: "Forecasting Methods". */
  course: string;
  color: CourseColor;
  /** Due time, or the start of the exam. */
  at: DateInput;
  /** An exam whose clock time is a placeholder: its line shows no time. */
  wholeDay?: boolean;
};

export type CalendarEntry = {
  id: string;
  kind: CalendarKind;
  title: string;
  color: CourseColor;
  /** "Forecasting Methods · due 21:00" or "Strategic IT Management · 09:00". */
  meta: string;
  /** `/assignments/<id>` or `/exams/<id>`. */
  href: string;
};

export type CalendarRow =
  | { type: "day"; key: string; label: string; today: boolean; items: CalendarEntry[] }
  | { type: "gap"; key: string; label: string };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const KIND_ORDER: Record<CalendarKind, number> = { exam: 0, quiz: 1, deadline: 2 };

function ms(input: DateInput): number {
  return input instanceof Date ? input.getTime() : new Date(input).getTime();
}

/**
 * An instant on the Helsinki calendar day `k` days after `now`. Adding 24 h
 * can land on the wrong day next to a daylight saving change, so nudge by 2 h
 * until the calendar agrees.
 */
function instantOnDay(now: number, k: number): number {
  let t = now + k * DAY_MS;
  const off = daysBetween(now, t) - k;
  if (off < 0) t += 2 * HOUR_MS;
  if (off > 0) t -= 2 * HOUR_MS;
  return t;
}

/** "TUE 17". */
function shortDate(at: number): string {
  return listDate(at).split(" · ")[0];
}

/** "TUE 17 NOV". */
function longDate(at: number): string {
  return dateLine(at).split(" · ")[0];
}

/** "NOV". */
function monthOf(at: number): string {
  return longDate(at).split(" ")[2];
}

/** "21:00". */
function clockOf(at: DateInput): string {
  return listDate(at).split(" · ")[1];
}

export function calendarHref(item: Pick<CalendarItem, "id" | "kind">): string {
  const base = item.kind === "deadline" ? "/assignments/" : "/exams/";
  return base + encodeURIComponent(item.id);
}

export function calendarMeta(item: Pick<CalendarItem, "kind" | "course" | "at" | "wholeDay">): string {
  if (item.kind !== "deadline" && item.wholeDay) return item.course;
  const time = clockOf(item.at);
  return item.kind === "deadline" ? `${item.course} · due ${time}` : `${item.course} · ${time}`;
}

function byTime(a: CalendarItem, b: CalendarItem): number {
  return (
    ms(a.at) - ms(b.at) ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function calendarRows(
  items: readonly CalendarItem[],
  now: DateInput,
  days: number = CALENDAR_DAYS,
): CalendarRow[] {
  const nowMs = ms(now);
  const byDay = new Map<number, CalendarItem[]>();
  for (const item of items) {
    const k = daysBetween(nowMs, item.at);
    if (k < 0 || k >= days) continue;
    const list = byDay.get(k);
    if (list) list.push(item);
    else byDay.set(k, [item]);
  }

  const rows: CalendarRow[] = [];
  let gapStart: number | null = null;

  const closeGap = (end: number) => {
    if (gapStart === null) return;
    const startAt = instantOnDay(nowMs, gapStart);
    const endAt = instantOnDay(nowMs, end);
    // A run into the next month names both months: "SUN 29 NOV – SAT 26 DEC".
    const crossesMonth = monthOf(startAt) !== monthOf(endAt);
    const label =
      end === gapStart
        ? shortDate(startAt)
        : crossesMonth
          ? `${longDate(startAt)} – ${longDate(endAt)}`
          : `${shortDate(startAt)} – ${shortDate(endAt)}`;
    rows.push({ type: "gap", key: `gap-${gapStart}`, label: `${label} · Nothing due` });
    gapStart = null;
  };

  for (let k = 0; k < days; k++) {
    const list = byDay.get(k);
    const at = instantOnDay(nowMs, k);
    if (!list) {
      if (k === 0) {
        rows.push({ type: "gap", key: "gap-0", label: `${shortDate(at)} · TODAY · Nothing due` });
      } else if (gapStart === null) {
        gapStart = k;
      }
      continue;
    }
    closeGap(k - 1);
    rows.push({
      type: "day",
      key: `day-${k}`,
      label: k === 0 ? `${longDate(at)} · TODAY` : longDate(at),
      today: k === 0,
      items: [...list].sort(byTime).map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        color: item.color,
        meta: calendarMeta(item),
        href: calendarHref(item),
      })),
    });
  }
  closeGap(days - 1);
  return rows;
}
