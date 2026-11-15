import { describe, expect, it } from "vitest";
import { calendarRows, CALENDAR_DAYS, type CalendarItem } from "./calendar-list";

// Saturday 14 November 2026, 15:48 in Helsinki (UTC+2).
const NOW = new Date("2026-11-14T13:48:00Z");

/** A Helsinki wall-clock time in November (UTC+2). */
const hki = (day: number, time: string, month = 11) =>
  new Date(`2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${time}:00+02:00`);

const item = (over: Partial<CalendarItem> & Pick<CalendarItem, "id" | "at">): CalendarItem => ({
  kind: "deadline",
  title: over.id,
  course: "Forecasting Methods",
  color: "butter",
  ...over,
});

const labels = (items: CalendarItem[], now: Date = NOW, days?: number) =>
  calendarRows(items, now, days).map((r) => r.label);

/** The prototype's list. */
const PROTOTYPE: CalendarItem[] = [
  item({ id: "a3", title: "Assignment 3: Forecast weekly demand", at: hki(14, "21:00") }),
  item({ id: "cm2", title: "Case memo 2", course: "Supply Chain Analytics", color: "sky", at: hki(17, "23:59") }),
  item({ id: "sb", title: "Service blueprint draft", course: "Digital Service Design", color: "blush", at: hki(19, "16:00") }),
  item({ id: "ex", kind: "exam", title: "Exam", course: "Strategic IT Management", color: "mint", at: hki(20, "09:00") }),
  item({ id: "q4", kind: "quiz", title: "Quiz 4: ARIMA basics", at: hki(27, "12:00") }),
];

describe("calendarRows", () => {
  it("matches the prototype's list (first two weeks)", () => {
    const rows = calendarRows(PROTOTYPE, NOW, 14);
    expect(rows.map((r) => r.label)).toEqual([
      "SAT 14 NOV · TODAY",
      "SUN 15 – MON 16 · Nothing due",
      "TUE 17 NOV",
      "WED 18 · Nothing due",
      "THU 19 NOV",
      "FRI 20 NOV",
      "SAT 21 – THU 26 · Nothing due",
      "FRI 27 NOV",
    ]);
    const entries = rows.flatMap((r) => (r.type === "day" ? r.items : []));
    expect(entries.map((e) => e.meta)).toEqual([
      "Forecasting Methods · due 21:00",
      "Supply Chain Analytics · due 23:59",
      "Digital Service Design · due 16:00",
      "Strategic IT Management · 09:00",
      "Forecasting Methods · 12:00",
    ]);
    expect(entries.map((e) => e.href)).toEqual([
      "/assignments/a3",
      "/assignments/cm2",
      "/assignments/sb",
      "/exams/ex",
      "/exams/q4",
    ]);
  });

  it("merges a run at the end of the window into one line reaching the last day", () => {
    const rows = calendarRows(PROTOTYPE, NOW);
    expect(rows[rows.length - 1]).toEqual({
      type: "gap",
      key: "gap-14",
      label: "SAT 28 NOV – FRI 25 DEC · Nothing due",
    });
    // 6 weeks: the last day is Friday 25 December.
    expect(CALENDAR_DAYS).toBe(42);
  });

  it("writes a single empty day without a range, also at the end", () => {
    expect(labels([item({ id: "a", at: hki(14, "10:00") })], NOW, 2)).toEqual([
      "SAT 14 NOV · TODAY",
      "SUN 15 · Nothing due",
    ]);
  });

  it("names both months when a run crosses into the next one", () => {
    expect(
      labels([item({ id: "a", at: hki(14, "10:00") }), item({ id: "b", at: hki(2, "10:00", 12) })], NOW, 19),
    ).toEqual([
      "SAT 14 NOV · TODAY",
      "SUN 15 NOV – TUE 1 DEC · Nothing due",
      "WED 2 DEC",
    ]);
  });

  it("labels today, and keeps an empty today on its own line", () => {
    const rows = calendarRows([item({ id: "a", at: hki(17, "12:00") })], NOW, 7);
    expect(rows.map((r) => r.label)).toEqual([
      "SAT 14 · TODAY · Nothing due",
      "SUN 15 – MON 16 · Nothing due",
      "TUE 17 NOV",
      "WED 18 – FRI 20 · Nothing due",
    ]);
    const today = calendarRows(PROTOTYPE, NOW, 1)[0];
    expect(today.type === "day" && today.today).toBe(true);
  });

  it("shows a nothing-at-all window as today plus one run", () => {
    expect(labels([])).toEqual(["SAT 14 · TODAY · Nothing due", "SUN 15 NOV – FRI 25 DEC · Nothing due"]);
  });

  it("orders a day by time, then exam, quiz, deadline, then title", () => {
    const rows = calendarRows(
      [
        item({ id: "late", title: "B late", at: hki(17, "23:59") }),
        item({ id: "d", title: "A deadline", at: hki(17, "12:00") }),
        item({ id: "q", kind: "quiz", title: "Z quiz", at: hki(17, "12:00") }),
        item({ id: "e", kind: "exam", title: "Z exam", at: hki(17, "12:00") }),
        item({ id: "d2", title: "A deadline", at: hki(17, "12:00") }),
        item({ id: "c", title: "C deadline", at: hki(17, "12:00") }),
        item({ id: "early", title: "Y early", at: hki(17, "08:00") }),
      ],
      NOW,
      7,
    );
    const day = rows.find((r) => r.type === "day");
    expect(day?.type === "day" && day.items.map((i) => i.id)).toEqual(["early", "e", "q", "d", "d2", "c", "late"]);
  });

  it("keeps something due earlier today, drops yesterday and day 42", () => {
    const rows = calendarRows(
      [
        item({ id: "morning", at: hki(14, "08:00") }),
        item({ id: "yesterday", at: hki(13, "23:59") }),
        item({ id: "last", at: hki(25, "23:59", 12) }),
        item({ id: "beyond", at: hki(26, "00:00", 12) }),
      ],
      NOW,
    );
    const ids = rows.flatMap((r) => (r.type === "day" ? r.items.map((i) => i.id) : []));
    expect(ids).toEqual(["morning", "last"]);
    expect(rows[rows.length - 1].label).toBe("FRI 25 DEC");
  });

  it("uses Helsinki days, not UTC days", () => {
    // 22:30 UTC on the 14th is 00:30 on Sunday the 15th in Helsinki.
    const rows = calendarRows(
      [item({ id: "a", at: new Date("2026-11-14T22:30:00Z") }), item({ id: "b", at: new Date("2026-11-14T21:59:00Z") })],
      NOW,
      3,
    );
    expect(rows.map((r) => r.label)).toEqual(["SAT 14 NOV · TODAY", "SUN 15 NOV", "MON 16 · Nothing due"]);
    expect(rows[0].type === "day" && rows[0].items[0].meta).toBe("Forecasting Methods · due 23:59");
    expect(rows[1].type === "day" && rows[1].items[0].meta).toBe("Forecasting Methods · due 00:30");
  });

  it("starts today in Helsinki just after midnight", () => {
    // 22:10 UTC on Friday the 13th is already Saturday 00:10 in Helsinki.
    expect(labels([item({ id: "a", at: hki(14, "21:00") })], new Date("2026-11-13T22:10:00Z"), 1)).toEqual([
      "SAT 14 NOV · TODAY",
    ]);
  });

  it("counts days across the spring clock change", () => {
    // Sunday 29 March 2026 is a 23-hour day in Helsinki.
    const now = new Date("2026-03-28T21:00:00Z"); // SAT 28 MAR 23:00
    const rows = calendarRows(
      [item({ id: "a", at: new Date("2026-03-30T00:30:00+03:00") })],
      now,
      4,
    );
    expect(rows.map((r) => r.label)).toEqual([
      "SAT 28 · TODAY · Nothing due",
      "SUN 29 · Nothing due",
      "MON 30 MAR",
      "TUE 31 · Nothing due",
    ]);
  });
});

describe("calendarRows: a whole-day exam", () => {
  it("shows no clock time, all of its day; an exam with a real time keeps it", () => {
    const list = [
      item({ id: "Retake", kind: "exam", course: "Statistics", at: hki(23, "09:00"), wholeDay: true }),
      item({ id: "Final", kind: "exam", course: "Economics", at: hki(23, "13:00") }),
    ];
    const metas = (now: Date) =>
      calendarRows(list, now).flatMap((r) => (r.type === "day" ? r.items.map((i) => `${r.label} | ${i.title} | ${i.meta}`) : []));
    expect(metas(NOW)).toEqual(["MON 23 NOV | Retake | Statistics", "MON 23 NOV | Final | Economics · 13:00"]);
    // Late on the day itself it is still under today.
    expect(metas(hki(23, "23:30"))).toEqual(["MON 23 NOV · TODAY | Retake | Statistics", "MON 23 NOV · TODAY | Final | Economics · 13:00"]);
    expect(metas(hki(24, "00:00"))).toEqual([]);
  });
});
