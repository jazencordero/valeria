import { describe, expect, it } from "vitest";
import {
  byDay,
  onDay,
  TODAY,
  dayLine,
  startOfDay,
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

  it("due 7 or more days ahead uses the list style, with its month", () => {
    expect(dueLabel(d("2026-11-21T10:00:00Z"), NOW)).toBe("SAT 21 NOV · 12:00");
  });

  it("already past uses the list style", () => {
    expect(dueLabel(d("2026-11-14T08:00:00Z"), NOW)).toBe("SAT 14 · 10:00");
  });

  it("just after midnight counts as tomorrow at 23:59", () => {
    const lateEvening = d("2026-11-14T21:59:00Z"); // 23:59
    expect(dueLabel(d("2026-11-14T22:30:00Z"), lateEvening)).toBe("DUE TOMORROW 00:30");
  });

  it("names the month when the date is more than six days away, either way", () => {
    const now = d("2026-11-28T10:00:00Z");
    expect(listDate(d("2026-12-04T21:59:00Z"), now)).toBe("FRI 4 · 23:59");
    expect(listDate(d("2026-12-05T21:59:00Z"), now)).toBe("SAT 5 DEC · 23:59");
    expect(listDate(d("2026-11-10T10:00:00Z"), now)).toBe("TUE 10 NOV · 12:00");
    expect(listDate(d("2026-12-05T21:59:00Z"))).toBe("SAT 5 · 23:59");
    expect(dueLabel(d("2026-12-05T21:59:00Z"), now)).toBe("SAT 5 DEC · 23:59");
    expect(dueLabel(d("2026-12-03T21:59:00Z"), now)).toBe("DUE THU 23:59");
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

describe("byDay", () => {
  // NOW is Saturday 14 Nov 2026, 15:48 in Helsinki.
  it("names the weekday alone within the next six days", () => {
    expect(byDay(d("2026-11-15T07:00:00Z"), NOW)).toBe("Sunday");
    expect(byDay(d("2026-11-16T07:00:00Z"), NOW)).toBe("Monday");
    expect(byDay(d("2026-11-20T07:00:00Z"), NOW)).toBe("Friday");
  });

  it("gives the date with its month from seven days out, where a bare weekday would mean the wrong week", () => {
    expect(byDay(d("2026-11-21T07:00:00Z"), NOW)).toBe("Sat 21 Nov");
    expect(byDay(d("2026-11-23T07:00:00Z"), NOW)).toBe("Mon 23 Nov");
    expect(byDay(d("2026-12-03T07:00:00Z"), NOW)).toBe("Thu 3 Dec");
  });

  it("gives the date for a day already past", () => {
    expect(byDay(d("2026-11-13T07:00:00Z"), NOW)).toBe("Fri 13 Nov");
  });

  it("goes by the Helsinki day, not the UTC one", () => {
    // 22:30 UTC on Friday 20 Nov is Saturday 21 Nov in Helsinki: seven days out.
    expect(byDay(d("2026-11-20T22:30:00Z"), NOW)).toBe("Sat 21 Nov");
  });
  it("says today on the day itself, the whole Helsinki day", () => {
    // NOW is 15:48 Helsinki on Saturday 14 Nov; 21:59 UTC is 23:59 Helsinki the same day.
    expect(byDay(d("2026-11-14T20:00:00Z"), NOW)).toBe(TODAY);
    expect(byDay(d("2026-11-13T22:00:00Z"), NOW)).toBe("today");
    expect(byDay(d("2026-11-14T21:59:00Z"), NOW)).toBe("today");
    // 22:00 UTC is 00:00 Helsinki on Sunday: tomorrow, a weekday again.
    expect(byDay(d("2026-11-14T22:00:00Z"), NOW)).toBe("Sunday");
  });
});

describe("onDay", () => {
  it("puts the word before the day, and on the day itself says only today", () => {
    expect(onDay("by", "Monday")).toBe("by Monday");
    expect(onDay("on", "Mon 23 Nov")).toBe("on Mon 23 Nov");
    expect(onDay("by", byDay(d("2026-11-14T07:00:00Z"), NOW))).toBe("today");
    expect(onDay("on", byDay(d("2026-11-14T07:00:00Z"), NOW))).toBe("today");
  });
});

describe("startOfDay", () => {
  it("is 00:00 Helsinki of that day, for any moment of it", () => {
    expect(startOfDay(d("2026-11-22T22:00:00Z")).toISOString()).toBe("2026-11-22T22:00:00.000Z");
    expect(startOfDay(d("2026-11-23T12:00:00Z")).toISOString()).toBe("2026-11-22T22:00:00.000Z");
    expect(startOfDay(d("2026-11-23T21:59:59Z")).toISOString()).toBe("2026-11-22T22:00:00.000Z");
    expect(startOfDay(d("2026-11-23T22:00:00Z")).toISOString()).toBe("2026-11-23T22:00:00.000Z");
  });

  it("holds on the 25-hour day in autumn and the 23-hour day in spring", () => {
    // Sunday 25 Oct 2026: clocks go back at 04:00, so the day starts at UTC+3 and ends at UTC+2.
    expect(startOfDay(d("2026-10-24T21:00:00Z")).toISOString()).toBe("2026-10-24T21:00:00.000Z");
    expect(startOfDay(d("2026-10-25T21:59:00Z")).toISOString()).toBe("2026-10-24T21:00:00.000Z");
    expect(startOfDay(d("2026-10-25T22:00:00Z")).toISOString()).toBe("2026-10-25T22:00:00.000Z");
    // Sunday 28 Mar 2027: clocks go forward at 03:00.
    expect(startOfDay(d("2027-03-28T20:59:00Z")).toISOString()).toBe("2027-03-27T22:00:00.000Z");
    expect(startOfDay(d("2027-03-28T21:00:00Z")).toISOString()).toBe("2027-03-28T21:00:00.000Z");
  });
});

describe("dayLine", () => {
  it("is the day with its month and no clock time", () => {
    expect(dayLine(d("2026-11-23T07:00:00Z"))).toBe("MON 23 NOV");
    expect(dayLine(d("2026-11-23T22:30:00Z"))).toBe("TUE 24 NOV");
  });
});
