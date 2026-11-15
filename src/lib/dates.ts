/**
 * Dates and time-left wording, always in Europe/Helsinki.
 *
 * Every function is pure: the current time is passed in as `now`, never read
 * from the clock. English only, 24-hour clock only. No date library: the time
 * zone is handled with Intl.DateTimeFormat, so daylight saving is the
 * runtime's job and never hard-coded here.
 */

export const TIME_ZONE = "Europe/Helsinki";

/** A Date, an ISO string or epoch milliseconds. */
export type DateInput = Date | string | number;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MIN_PER_DAY = 24 * 60;

// Fixed names so the output never depends on the runtime's locale data
// (en-GB in some ICU versions writes "Sept").
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const partsFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

function toDate(input: DateInput): Date {
  return input instanceof Date ? input : new Date(input);
}

/** The wall-clock date and time in Helsinki for one instant. */
function localParts(input: DateInput): LocalParts {
  const out: Record<string, number> = {};
  for (const p of partsFormat.formatToParts(toDate(input))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
  };
}

/** Helsinki calendar day as a whole number (days since 1970-01-01). */
function dayNumber(input: DateInput): number {
  const { year, month, day } = localParts(input);
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

function weekdayOf(input: DateInput): string {
  // 1970-01-01 was a Thursday (index 4).
  return WEEKDAYS[(((dayNumber(input) + 4) % 7) + 7) % 7];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function clock(input: DateInput): string {
  const { hour, minute } = localParts(input);
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** Offset of Helsinki from UTC at this instant, in milliseconds. */
function offsetAt(ms: number): number {
  const p = localParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** The instant a Helsinki wall-clock time happens. */
function fromLocal(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ms = guess - offsetAt(guess);
  // The offset can differ on either side of a DST change; settle on the one
  // that holds at the answer itself.
  const second = offsetAt(ms);
  if (guess - second !== ms) ms = guess - second;
  return new Date(ms);
}

/**
 * Whole duration, rounded down to the minute so we never promise more time
 * than there is: `2 days`, `1 day`, `5 h 12 min`, `3 h`, `12 min`, `under 1 min`.
 * A day here is 24 hours of real time, not a calendar day.
 */
function duration(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / MINUTE_MS);
  if (mins >= MIN_PER_DAY) {
    const days = Math.floor(mins / MIN_PER_DAY);
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
  }
  if (mins >= 1) return `${mins} min`;
  return "under 1 min";
}

/** True when both instants fall on the same Helsinki calendar day. */
export function sameDay(a: DateInput, b: DateInput): boolean {
  return dayNumber(a) === dayNumber(b);
}

/**
 * Calendar days from `from` to `to` in Helsinki, ignoring the time of day.
 * Tonight 23:59 to tomorrow 00:01 is 1. Negative when `to` is earlier.
 * DST-safe: a 23- or 25-hour day still counts as one.
 */
export function daysBetween(from: DateInput, to: DateInput): number {
  return dayNumber(to) - dayNumber(from);
}

/** Monday 00:00 Helsinki time of the week that contains `date`. */
export function startOfWeek(date: DateInput): Date {
  const { year, month, day } = localParts(date);
  const sinceMonday = (WEEKDAYS.indexOf(weekdayOf(date)) + 6) % 7;
  const monday = new Date(Date.UTC(year, month - 1, day - sinceMonday));
  return fromLocal(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
}

/**
 * Short date for lists: `TUE 17 · 23:59`. With `now`, a date more than six calendar days away
 * (either way) also names its month, `SAT 5 DEC · 23:59`: a bare weekday and number is only
 * clear within the week.
 */
export function listDate(due: DateInput, now?: DateInput): string {
  const { day, month } = localParts(due);
  const far = now !== undefined && Math.abs(daysBetween(now, due)) > 6;
  return `${weekdayOf(due)} ${day}${far ? ` ${MONTHS[month - 1]}` : ""} · ${clock(due)}`;
}

/**
 * Due line on a card:
 * - today: `DUE TODAY 21:00`
 * - tomorrow: `DUE TOMORROW 09:00`
 * - 2 to 6 calendar days ahead: `DUE TUE 23:59` (the weekday is unambiguous)
 * - 7 or more days ahead, or already past: the list style, `TUE 17 · 23:59`, with the month
 *   when it is more than six days away (`SAT 5 DEC · 23:59`)
 *   (lateness is told by `timeLeft`, not here).
 */
export function dueLabel(due: DateInput, now: DateInput): string {
  if (toDate(due).getTime() < toDate(now).getTime()) return listDate(due, now);
  const days = daysBetween(now, due);
  if (days === 0) return `DUE TODAY ${clock(due)}`;
  if (days === 1) return `DUE TOMORROW ${clock(due)}`;
  if (days < 7) return `DUE ${weekdayOf(due)} ${clock(due)}`;
  return listDate(due, now);
}

/**
 * Time left before a due time, rounded down:
 * `2 days left`, `1 day left`, `5 h 12 min left`, `12 min left`, `under 1 min left`.
 * Past due: `late by 3 h`, `late by 2 days` (same rounding).
 */
export function timeLeft(due: DateInput, now: DateInput): string {
  const diff = toDate(due).getTime() - toDate(now).getTime();
  return diff >= 0 ? `${duration(diff)} left` : `late by ${duration(-diff)}`;
}

/**
 * How early a hand-in was: `5 h 8 min early`, `2 days early`.
 * Less than a minute either side: `on time`. After the due time: `late by 3 h`.
 */
export function earlyBy(submitted: DateInput, due: DateInput): string {
  const diff = toDate(due).getTime() - toDate(submitted).getTime();
  if (Math.abs(diff) < MINUTE_MS) return "on time";
  return diff > 0 ? `${duration(diff)} early` : `late by ${duration(-diff)}`;
}

/**
 * Rough study length:
 * - 0 or less: `0 min`
 * - under 5 min: exact, `about 3 min`
 * - otherwise rounded to 5 min; below 120 min stays in minutes, `about 90 min`
 * - 120 min and up in hours, to the half hour: `about 2 h`, `about 2.5 h`
 */
export function minutesLabel(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return "0 min";
  if (min < 5) return `about ${Math.max(1, Math.round(min))} min`;
  const rounded = Math.round(min / 5) * 5;
  if (rounded < 120) return `about ${rounded} min`;
  const hours = Math.round(min / 30) / 2;
  return `about ${hours} h`;
}

/** Header date line: `SAT 14 NOV · 15:48`. */
export function dateLine(now: DateInput): string {
  const { day, month } = localParts(now);
  return `${weekdayOf(now)} ${day} ${MONTHS[month - 1]} · ${clock(now)}`;
}
