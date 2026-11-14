import { describe, expect, it } from "vitest";
import {
  dateLine,
  daysBetween,
  dueLabel,
  earlyBy,
  listDate,
  minutesLabel,
  sameDay,
  startOfWeek,
  timeLeft,
} from "./dates";

// Helsinki is UTC+2 in winter (EET) and UTC+3 in summer (EEST).
// In 2026 summer time starts 29 March (03:00 -> 04:00) and ends 25 October (04:00 -> 03:00).
const d = (iso: string) => new Date(iso);

// Saturday 14 November 2026, 15:48 in Helsinki.
const NOW = d("2026-11-14T13:48:00Z");

describe("dateLine", () => {
  it("writes weekday, day, month and time", () => {
    expect(dateLine(NOW)).toBe("SAT 14 NOV · 15:48");
  });

  it("turns over at Helsinki midnight, not UTC midnight", () => {
    expect(dateLine(d("2026-12-31T22:30:00Z"))).toBe("FRI 1 JAN · 00:30");
  });

  it("accepts an ISO string", () => {
    expect(dateLine("2026-11-14T13:48:00Z")).toBe("SAT 14 NOV · 15:48");
  });

  it("shows the repeated hour twice on the autumn change day", () => {
    expect(dateLine(d("2026-10-25T00:30:00Z"))).toBe("SUN 25 OCT · 03:30"); // still summer time
    expect(dateLine(d("2026-10-25T01:30:00Z"))).toBe("SUN 25 OCT · 03:30"); // winter time
  });
});

describe("dueLabel and listDate", () => {
  it("due later today", () => {
    expect(dueLabel(d("2026-11-14T19:00:00Z"), NOW)).toBe("DUE TODAY 21:00");
  });

  it("due tomorrow", () => {
    expect(dueLabel(d("2026-11-15T07:00:00Z"), NOW)).toBe("DUE TOMORROW 09:00");
  });

  it("due within the week shows the weekday", () => {
    expect(dueLabel(d("2026-11-17T21:59:00Z"), NOW)).toBe("DUE TUE 23:59");
  });

  it("due 7 or more days ahead uses the list style", () => {
    expect(dueLabel(d("2026-11-21T10:00:00Z"), NOW)).toBe("SAT 21 · 12:00");
  });

  it("already past uses the list style", () => {
    expect(dueLabel(d("2026-11-14T08:00:00Z"), NOW)).toBe("SAT 14 · 10:00");
  });

  it("just after midnight counts as tomorrow at 23:59", () => {
    const lateEvening = d("2026-11-14T21:59:00Z"); // 23:59
    expect(dueLabel(d("2026-11-14T22:30:00Z"), lateEvening)).toBe("DUE TOMORROW 00:30");
  });

  it("listDate writes midnight as 00:00", () => {
    expect(listDate(d("2026-11-15T22:00:00Z"))).toBe("MON 16 · 00:00");
    expect(listDate(d("2026-11-17T21:59:00Z"))).toBe("TUE 17 · 23:59");
  });

  it("on the spring change day, end of day is still today", () => {
    const midnight = d("2026-03-28T22:00:00Z"); // 29 March 00:00 EET
    expect(dueLabel(d("2026-03-29T20:59:00Z"), midnight)).toBe("DUE TODAY 23:59");
  });
});

describe("timeLeft", () => {
  it("hours and minutes under a day", () => {
    expect(timeLeft(d("2026-11-14T19:00:00Z"), NOW)).toBe("5 h 12 min left");
  });

  it("whole days, rounded down", () => {
    expect(timeLeft(d("2026-11-16T19:00:00Z"), NOW)).toBe("2 days left");
    expect(timeLeft(d("2026-11-15T19:00:00Z"), NOW)).toBe("1 day left");
  });

  it("minutes only, and under a minute", () => {
    expect(timeLeft(d("2026-11-14T14:00:00Z"), NOW)).toBe("12 min left");
    expect(timeLeft(NOW, NOW)).toBe("under 1 min left");
  });

  it("already past says how late", () => {
    expect(timeLeft(d("2026-11-14T10:48:00Z"), NOW)).toBe("late by 3 h");
    expect(timeLeft(d("2026-11-12T10:00:00Z"), NOW)).toBe("late by 2 days");
  });

  it("counts real hours across the spring change (23-hour day)", () => {
    const midnight = d("2026-03-28T22:00:00Z");
    expect(timeLeft(d("2026-03-29T20:59:00Z"), midnight)).toBe("22 h 59 min left");
  });

  it("counts real hours across the autumn change (25-hour day)", () => {
    const midnight = d("2026-10-24T21:00:00Z"); // 25 October 00:00 EEST
    expect(timeLeft(d("2026-10-25T21:59:00Z"), midnight)).toBe("1 day left");
    expect(dueLabel(d("2026-10-25T21:59:00Z"), midnight)).toBe("DUE TODAY 23:59");
  });
});

describe("earlyBy", () => {
  it("hours and minutes early", () => {
    expect(earlyBy(d("2026-11-14T13:52:00Z"), d("2026-11-14T19:00:00Z"))).toBe("5 h 8 min early");
  });

  it("days early", () => {
    expect(earlyBy(d("2026-11-12T13:00:00Z"), d("2026-11-14T19:00:00Z"))).toBe("2 days early");
  });

  it("within a minute is on time, after the due time is late", () => {
    expect(earlyBy(d("2026-11-14T18:59:30Z"), d("2026-11-14T19:00:00Z"))).toBe("on time");
    expect(earlyBy(d("2026-11-14T22:00:00Z"), d("2026-11-14T19:00:00Z"))).toBe("late by 3 h");
  });
});

describe("minutesLabel", () => {
  it.each([
    [90, "about 90 min"],
    [120, "about 2 h"],
    [118, "about 2 h"],
    [150, "about 2.5 h"],
    [42, "about 40 min"],
    [3, "about 3 min"],
    [0, "0 min"],
  ])("%i min -> %s", (min, label) => {
    expect(minutesLabel(min)).toBe(label);
  });
});

describe("sameDay", () => {
  it("23:59 and 00:00 are different days", () => {
    expect(sameDay(d("2026-11-14T21:59:00Z"), d("2026-11-14T22:00:00Z"))).toBe(false);
  });

  it("uses the Helsinki day, not the UTC day", () => {
    expect(sameDay(d("2026-11-13T22:30:00Z"), d("2026-11-14T13:00:00Z"))).toBe(true);
  });

  it("the whole 23-hour spring change day is one day", () => {
    expect(sameDay(d("2026-03-28T22:00:00Z"), d("2026-03-29T20:59:00Z"))).toBe(true);
  });
});

describe("daysBetween", () => {
  it("one minute across midnight is one day", () => {
    expect(daysBetween(d("2026-11-14T21:59:00Z"), d("2026-11-14T22:01:00Z"))).toBe(1);
  });

  it("is negative going back", () => {
    expect(daysBetween(NOW, d("2026-11-12T10:00:00Z"))).toBe(-2);
  });

  it("is calendar days across the spring change", () => {
    expect(daysBetween(d("2026-03-28T10:00:00Z"), d("2026-03-30T09:00:00Z"))).toBe(2);
  });

  it("is calendar days across the autumn change", () => {
    expect(daysBetween(d("2026-10-24T21:00:00Z"), d("2026-10-25T22:00:00Z"))).toBe(1);
  });
});

describe("startOfWeek", () => {
  it("goes back to Monday 00:00 Helsinki", () => {
    expect(startOfWeek(NOW).toISOString()).toBe("2026-11-08T22:00:00.000Z");
  });

  it("Monday 00:00 is its own start, Sunday 23:59 belongs to the week before", () => {
    expect(startOfWeek(d("2026-11-15T22:00:00Z")).toISOString()).toBe("2026-11-15T22:00:00.000Z");
    expect(startOfWeek(d("2026-11-15T21:59:00Z")).toISOString()).toBe("2026-11-08T22:00:00.000Z");
  });

  it("is DST-safe in spring", () => {
    // Sunday 29 March (change day) -> Monday 23 March, winter time.
    expect(startOfWeek(d("2026-03-29T10:00:00Z")).toISOString()).toBe("2026-03-22T22:00:00.000Z");
    // Monday 30 March -> that Monday, summer time.
    expect(startOfWeek(d("2026-03-30T10:00:00Z")).toISOString()).toBe("2026-03-29T21:00:00.000Z");
  });

  it("is DST-safe in autumn", () => {
    // Sunday 25 October (change day) -> Monday 19 October, summer time.
    expect(startOfWeek(d("2026-10-25T10:00:00Z")).toISOString()).toBe("2026-10-18T21:00:00.000Z");
    // Tuesday 27 October -> Monday 26 October, winter time.
    expect(startOfWeek(d("2026-10-27T10:00:00Z")).toISOString()).toBe("2026-10-25T22:00:00.000Z");
  });
});
