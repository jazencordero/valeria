// iCalendar (RFC 5545) feed for deadlines, exams and quizzes. Pure: no I/O, no clock.
//
// Decisions (M7-01):
// - UTC only (the ticket cuts time-zone blocks): every DTSTART/DTEND/DTSTAMP is `YYYYMMDDTHHMMSSZ`.
// - Lengths: a deadline or quiz is a 30 minute block starting at its due time; an exam is 3 hours
//   (a typical university exam sitting). Any item may override with `end` or `durationMinutes`.
// - SUMMARY: "Exam: <title>" for exams; "Due: <title>" for deadlines and quizzes, since a quiz in
//   the LMS is something you finish before it closes, like a hand-in.
// - DTSTAMP must be stable so two builds of the same input are byte-identical: pass `stamp`
//   (e.g. when the data last changed). Without it each event uses its own start time.
// - Events are sorted by start time, then UID, so input order does not change the output.
// - Items whose time cannot be read are left out rather than breaking the whole feed.
// - `allDay` (a calendar day, `YYYY-MM-DD`) makes an all-day entry: `DTSTART;VALUE=DATE` on that
//   day and `DTEND;VALUE=DATE` on the next, with no clock time. The caller picks the day (its
//   own time zone's); `at` still orders the events. A day that cannot be read falls back to `at`.

export type CalendarItemKind = "deadline" | "exam" | "quiz";

export type CalendarItem = {
  id: string | number;
  kind: CalendarItemKind;
  title: string;
  course: string;
  /** When it is due, or when the exam starts. Date, epoch milliseconds or an ISO string. */
  at: Date | number | string;
  /** Optional end time. Wins over `durationMinutes`. */
  end?: Date | number | string;
  /** Optional length in minutes. */
  durationMinutes?: number;
  /** The day of a whole-day item, `YYYY-MM-DD`: an all-day entry with no clock time. */
  allDay?: string;
};

export type CalendarOptions = {
  /** Calendar name shown by the calendar app (X-WR-CALNAME). */
  name: string;
  /** DTSTAMP for every event. Defaults to each event's own start time. */
  stamp?: Date | number | string;
};

export const DEADLINE_MINUTES = 30;
export const QUIZ_MINUTES = 30;
export const EXAM_MINUTES = 180;

const CRLF = "\r\n";
const MAX_LINE_BYTES = 75;

const DEFAULT_MINUTES: Record<CalendarItemKind, number> = {
  deadline: DEADLINE_MINUTES,
  quiz: QUIZ_MINUTES,
  exam: EXAM_MINUTES,
};

/** Escapes a TEXT value: backslash, semicolon, comma and line breaks (RFC 5545 3.3.11). */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Folds one content line so no physical line is longer than 75 UTF-8 bytes (RFC 5545 3.1).
 * Continuation lines start with one space. Never splits a multi-byte character.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = MAX_LINE_BYTES;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
      limit = MAX_LINE_BYTES - 1; // room for the leading space
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join(CRLF + " ");
}

/** Formats a time as UTC `YYYYMMDDTHHMMSSZ`. */
export function formatUtc(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(date.getUTCFullYear()).padStart(4, "0") +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    "T" +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z"
  );
}

function toDate(value: Date | number | string | undefined): Date | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function eventUid(item: Pick<CalendarItem, "kind" | "id">): string {
  return `${item.kind}-${item.id}@ready`;
}

function summaryFor(item: CalendarItem): string {
  return item.kind === "exam" ? `Exam: ${item.title}` : `Due: ${item.title}`;
}

type Event = { uid: string; start: Date; end: Date; item: CalendarItem };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYYMMDD` for a `YYYY-MM-DD` day and the day after it; null when it is not a real day. */
function allDaySpan(day: string | undefined): { start: string; end: string } | null {
  const m = day ? DAY.exec(day) : null;
  if (!m) return null;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const compact = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
  if (compact(at) !== day!.replace(/-/g, "")) return null;
  return { start: compact(at), end: compact(at + 24 * 60 * 60_000) };
}

function toEvent(item: CalendarItem): Event | null {
  const start = toDate(item.at);
  if (!start) return null;
  let end = toDate(item.end);
  if (!end || end.getTime() <= start.getTime()) {
    const minutes =
      item.durationMinutes !== undefined && item.durationMinutes > 0
        ? item.durationMinutes
        : DEFAULT_MINUTES[item.kind];
    end = new Date(start.getTime() + minutes * 60_000);
  }
  return { uid: eventUid(item), start, end, item };
}

function eventLines(event: Event, stamp: Date | null): string[] {
  const { item } = event;
  const summary = summaryFor(item);
  const span = allDaySpan(item.allDay);
  const lines = [
    "BEGIN:VEVENT",
    `UID:${escapeText(event.uid)}`,
    `DTSTAMP:${formatUtc(stamp ?? event.start)}`,
    ...(span
      ? [`DTSTART;VALUE=DATE:${span.start}`, `DTEND;VALUE=DATE:${span.end}`]
      : [`DTSTART:${formatUtc(event.start)}`, `DTEND:${formatUtc(event.end)}`]),
    `SUMMARY:${escapeText(summary)}`,
  ];
  if (item.course.trim() !== "") lines.push(`DESCRIPTION:${escapeText(item.course)}`);
  for (const trigger of ["-P1D", "-PT3H"]) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(summary)}`,
      `TRIGGER:${trigger}`,
      "END:VALARM",
    );
  }
  lines.push("END:VEVENT");
  return lines;
}

/** Builds the iCalendar text: CRLF line endings, folded lines, final CRLF. */
export function buildCalendar(items: readonly CalendarItem[], options: CalendarOptions): string {
  const stamp = toDate(options.stamp);
  const events = items
    .map(toEvent)
    .filter((event): event is Event => event !== null)
    .sort(
      (a, b) =>
        a.start.getTime() - b.start.getTime() || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0),
    );

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ready//Study calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(options.name)}`,
    ...events.flatMap((event) => eventLines(event, stamp)),
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}
