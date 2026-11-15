import { describe, expect, it } from "vitest";
import {
  buildCalendar,
  escapeText,
  foldLine,
  formatUtc,
  type CalendarItem,
} from "./ics";

const STAMP = "2026-11-14T12:00:00Z";

const items: CalendarItem[] = [
  {
    id: 42,
    kind: "deadline",
    title: "Essay 2",
    course: "Intro to Economics",
    at: "2026-11-20T21:59:00Z",
  },
  {
    id: "e7",
    kind: "exam",
    title: "Final exam",
    course: "Statistics",
    at: new Date("2026-12-10T07:00:00Z"),
  },
  {
    id: 3,
    kind: "quiz",
    title: "Week 4 quiz",
    course: "Statistics",
    at: Date.parse("2026-11-18T10:00:00Z"),
  },
];

const build = () => buildCalendar(items, { name: "Ready", stamp: STAMP });

/** Undoes line folding (RFC 5545 3.1). */
const unfold = (text: string) => text.replace(/\r\n[ \t]/g, "");
const physicalLines = (text: string) => text.split("\r\n").slice(0, -1);
const logicalLines = (text: string) => physicalLines(unfold(text));
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("escapeText", () => {
  it("escapes commas, semicolons and backslashes", () => {
    expect(escapeText("a,b;c\\d")).toBe("a\\,b\\;c\\\\d");
  });

  it("turns every kind of line break into \\n", () => {
    expect(escapeText("one\ntwo\r\nthree\rfour")).toBe("one\\ntwo\\nthree\\nfour");
  });

  it("escapes the backslash before adding its own", () => {
    expect(escapeText("C:\\notes,\n")).toBe("C:\\\\notes\\,\\n");
  });
});

describe("foldLine", () => {
  it("leaves a short line alone", () => {
    expect(foldLine("SUMMARY:Due: Essay")).toBe("SUMMARY:Due: Essay");
  });

  it("keeps a line of exactly 75 bytes on one line", () => {
    const line = "X".repeat(75);
    expect(foldLine(line)).toBe(line);
  });

  it("folds at 75 bytes with CRLF and one space, and unfolds to the original", () => {
    const line = "SUMMARY:" + "abcdefghij".repeat(20);
    const folded = foldLine(line);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(75);
    for (const part of parts.slice(1)) expect(part.startsWith(" ")).toBe(true);
    expect(bytes(parts[0])).toBe(75);
    expect(unfold(folded)).toBe(line);
  });

  it("counts bytes, not characters, and never splits ä or an emoji", () => {
    const line = "SUMMARY:" + "ä📚".repeat(40);
    const folded = foldLine(line);
    const parts = folded.split("\r\n");
    for (const part of parts) {
      expect(bytes(part)).toBeLessThanOrEqual(75);
      // A split surrogate pair or byte sequence would not round-trip through UTF-8.
      expect(new TextDecoder().decode(new TextEncoder().encode(part))).toBe(part);
      expect(part).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
    expect(unfold(folded)).toBe(line);
  });
});

describe("formatUtc", () => {
  it("formats in UTC as YYYYMMDDTHHMMSSZ", () => {
    expect(formatUtc(new Date("2026-03-05T04:07:09Z"))).toBe("20260305T040709Z");
    // An offset input is converted to UTC.
    expect(formatUtc(new Date("2026-11-20T23:59:00+02:00"))).toBe("20261120T215900Z");
  });
});

describe("buildCalendar", () => {
  it("writes the calendar header and footer", () => {
    const lines = logicalLines(build());
    expect(lines.slice(0, 6)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Ready//Study calendar//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:Ready",
    ]);
    expect(lines.at(-1)).toBe("END:VCALENDAR");
  });

  it("uses CRLF everywhere and ends with a CRLF", () => {
    const text = build();
    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("writes one event per item with a stable UID", () => {
    const text = unfold(build());
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(text).toContain("UID:deadline-42@ready\r\n");
    expect(text).toContain("UID:exam-e7@ready\r\n");
    expect(text).toContain("UID:quiz-3@ready\r\n");
  });

  it("gives identical output across two builds and any input order", () => {
    expect(build()).toBe(build());
    const reversed = buildCalendar([...items].reverse(), { name: "Ready", stamp: STAMP });
    expect(reversed).toBe(build());
  });

  it("is deterministic without a stamp too", () => {
    const a = buildCalendar(items, { name: "Ready" });
    const b = buildCalendar(items, { name: "Ready" });
    expect(a).toBe(b);
    expect(unfold(a)).toContain("DTSTAMP:20261120T215900Z");
  });

  it("writes times in UTC with the right lengths", () => {
    const text = unfold(build());
    // Deadline: 30 minutes.
    expect(text).toContain("DTSTART:20261120T215900Z\r\nDTEND:20261120T222900Z\r\n");
    // Quiz: 30 minutes.
    expect(text).toContain("DTSTART:20261118T100000Z\r\nDTEND:20261118T103000Z\r\n");
    // Exam: 3 hours by default.
    expect(text).toContain("DTSTART:20261210T070000Z\r\nDTEND:20261210T100000Z\r\n");
    expect(text).toContain(`DTSTAMP:${formatUtc(new Date(STAMP))}\r\n`);
  });

  it("uses an exam's own end or duration", () => {
    const base: CalendarItem = { id: 1, kind: "exam", title: "Midterm", course: "C", at: "2026-12-01T08:00:00Z" };
    const withEnd = unfold(buildCalendar([{ ...base, end: "2026-12-01T10:00:00Z" }], { name: "R" }));
    expect(withEnd).toContain("DTEND:20261201T100000Z");
    const withDuration = unfold(buildCalendar([{ ...base, durationMinutes: 90 }], { name: "R" }));
    expect(withDuration).toContain("DTEND:20261201T093000Z");
  });

  it("writes SUMMARY and DESCRIPTION", () => {
    const text = unfold(build());
    expect(text).toContain("SUMMARY:Due: Essay 2\r\nDESCRIPTION:Intro to Economics\r\n");
    expect(text).toContain("SUMMARY:Exam: Final exam\r\nDESCRIPTION:Statistics\r\n");
    expect(text).toContain("SUMMARY:Due: Week 4 quiz\r\n");
  });

  it("adds two display alarms to every event: a day before and 3 hours before", () => {
    const text = unfold(build());
    const events = text.split("BEGIN:VEVENT").slice(1);
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.match(/BEGIN:VALARM/g)).toHaveLength(2);
      expect(event.match(/ACTION:DISPLAY/g)).toHaveLength(2);
      expect(event).toContain("TRIGGER:-P1D\r\n");
      expect(event).toContain("TRIGGER:-PT3H\r\n");
    }
    expect(text).toContain(
      "BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Due: Essay 2\r\nTRIGGER:-P1D\r\nEND:VALARM\r\n",
    );
  });

  it("escapes commas, semicolons, backslashes and line breaks in text", () => {
    const text = unfold(
      buildCalendar(
        [
          {
            id: 9,
            kind: "deadline",
            title: "Report, part 1; draft\\v2",
            course: "Line one\nLine two",
            at: "2026-11-20T10:00:00Z",
          },
        ],
        { name: "Ready, mine", stamp: STAMP },
      ),
    );
    expect(text).toContain("X-WR-CALNAME:Ready\\, mine\r\n");
    expect(text).toContain("SUMMARY:Due: Report\\, part 1\\; draft\\\\v2\r\n");
    expect(text).toContain("DESCRIPTION:Line one\\nLine two\r\n");
  });

  it("folds a long title so every physical line is at most 75 bytes", () => {
    const title = "Kurssin loppuraportti ja esitys: ympäristövaikutusten arviointi 📚 " + "ää🎓".repeat(15);
    const text = buildCalendar(
      [{ id: 1, kind: "deadline", title, course: "Ympäristötekniikka", at: "2026-11-20T10:00:00Z" }],
      { name: "Ready", stamp: STAMP },
    );
    for (const line of physicalLines(text)) expect(bytes(line)).toBeLessThanOrEqual(75);
    expect(physicalLines(text).some((line) => line.startsWith(" "))).toBe(true);
    expect(logicalLines(text)).toContain(`SUMMARY:Due: ${title}`);
  });

  it("leaves out items with an unreadable time", () => {
    const text = buildCalendar(
      [...items, { id: 5, kind: "deadline", title: "Bad", course: "X", at: "not a date" }],
      { name: "Ready", stamp: STAMP },
    );
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(text).not.toContain("deadline-5@ready");
  });

  it("builds an empty calendar with no items", () => {
    expect(buildCalendar([], { name: "Ready" })).toBe(
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Ready//Study calendar//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nX-WR-CALNAME:Ready\r\nEND:VCALENDAR\r\n",
    );
  });
});

describe("buildCalendar: a whole-day item", () => {
  const wholeDay: CalendarItem = { id: "w1", kind: "exam", title: "Retake", course: "Statistics", at: "2026-11-23T07:00:00Z", allDay: "2026-11-23" };
  const eventOf = (text: string, uid: string) => {
    const lines = logicalLines(text);
    const at = lines.indexOf(`UID:${uid}`);
    return lines.slice(at, lines.indexOf("END:VEVENT", at));
  };

  it("is an all-day entry: a date with no clock time, ending the next day", () => {
    const event = eventOf(buildCalendar([wholeDay], { name: "Ready", stamp: STAMP }), "exam-w1@ready");
    expect(event).toContain("DTSTART;VALUE=DATE:20261123");
    expect(event).toContain("DTEND;VALUE=DATE:20261124");
    expect(event.some((l) => /^DT(START|END):/.test(l))).toBe(false);
    expect(event).toContain("SUMMARY:Exam: Retake");
  });

  it("ends in the next month or year when the day is the last one", () => {
    const text = buildCalendar([{ ...wholeDay, at: "2026-12-31T07:00:00Z", allDay: "2026-12-31" }], { name: "Ready", stamp: STAMP });
    expect(text).toContain("DTSTART;VALUE=DATE:20261231");
    expect(text).toContain("DTEND;VALUE=DATE:20270101");
  });

  it("leaves a timed item as it was, and falls back to the time for a day that is not one", () => {
    const text = buildCalendar([items[1], { ...wholeDay, id: "w2", allDay: "2026-02-30" }], { name: "Ready", stamp: STAMP });
    expect(eventOf(text, "exam-e7@ready")).toContain("DTSTART:20261210T070000Z");
    expect(eventOf(text, "exam-w2@ready")).toContain("DTSTART:20261123T070000Z");
    expect(text).not.toContain("VALUE=DATE");
  });
});
