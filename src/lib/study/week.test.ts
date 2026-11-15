import { describe, expect, it } from "vitest";
import {
  DEFAULT_GOAL,
  freeSkipLabel,
  freeSkipsLeft,
  goalFor,
  streakLine,
  weekOf,
  weekSentence,
  weeksInARow,
} from "./week";

// Week of Mon 9 Nov 2026 (Helsinki is UTC+2 in November). "Now" is Saturday.
const NOW = "2026-11-14T15:48:00+02:00";
const MON = "2026-11-09T10:00:00+02:00";
const TUE = "2026-11-10T10:00:00+02:00";
const WED = "2026-11-11T10:00:00+02:00";
const THU = "2026-11-12T10:00:00+02:00";
const FRI = "2026-11-13T10:00:00+02:00";
const SAT = "2026-11-14T09:00:00+02:00";

/** Review instants at noon Helsinki on `n` days of the week starting `monday` (YYYY-MM-DD). */
function weekDays(monday: string, n: number, offset = "+02:00"): string[] {
  const base = new Date(`${monday}T12:00:00${offset}`).getTime();
  return Array.from({ length: n }, (_, i) => new Date(base + i * 24 * 3600 * 1000).toISOString());
}

const states = (days: { state: string }[]) => days.map((d) => d.state);

describe("weekOf", () => {
  it("matches the prototype week (M, W, T done, today Saturday)", () => {
    const w = weekOf([MON, WED, THU], DEFAULT_GOAL, NOW);
    expect(states(w.days)).toEqual(["done", "missed", "done", "done", "missed", "today", "future"]);
    expect(w.days.map((d) => d.label)).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
    expect(w.days.map((d) => d.isToday)).toEqual([false, false, false, false, false, true, false]);
    expect(w.count).toBe(3);
    expect(w.met).toBe(false);
    expect(w.sentence).toBe("3 of 4 days this week. One more makes the week.");
  });

  it("says how many more to go", () => {
    const w = weekOf([MON, TUE], 4, NOW);
    expect(w.sentence).toBe("2 of 4 days this week. 2 more to go.");
    expect(weekOf([], 4, NOW).sentence).toBe("0 of 4 days this week. 4 more to go.");
  });

  it("says goal met, and keeps the real count above the goal", () => {
    expect(weekOf([MON, TUE, WED, THU], 4, NOW)).toMatchObject({
      count: 4,
      met: true,
      sentence: "Goal met. 4 of 4 days this week.",
    });
    expect(weekOf([MON, TUE, WED, THU, FRI], 4, NOW)).toMatchObject({
      count: 5,
      met: true,
      sentence: "Goal met. 5 of 4 days this week.",
    });
  });

  it("shows today as done once she has reviewed, still marked as today", () => {
    const w = weekOf([SAT], 4, NOW);
    expect(w.days[5]).toEqual({ label: "S", state: "done", isToday: true });
    expect(w.count).toBe(1);
  });

  it("counts several reviews on one day once and accepts Date, ms and ISO", () => {
    const w = weekOf(
      [MON, new Date(MON), new Date("2026-11-09T23:59:00+02:00").getTime(), TUE],
      4,
      NOW,
    );
    expect(w.count).toBe(2);
  });

  it("ignores reviews after now and invalid dates", () => {
    const w = weekOf(["2026-11-14T18:00:00+02:00", "2026-11-15T10:00:00+02:00", "not a date"], 4, NOW);
    expect(w.count).toBe(0);
    expect(w.days[5].state).toBe("today");
    expect(w.days[6].state).toBe("future");
  });

  it("defaults the goal to 4 and clamps it to 1..7", () => {
    expect(weekOf([], undefined, NOW).goal).toBe(4);
    expect(weekOf([], 0, NOW).goal).toBe(1);
    expect(weekOf([], 9, NOW).goal).toBe(7);
    expect(weekOf([], Number.NaN, NOW).goal).toBe(4);
  });

  it("starts the week Monday 00:00 Helsinki, not Sunday 23:59", () => {
    const now = "2026-11-09T00:00:00+02:00";
    const sunday = weekOf(["2026-11-08T23:59:00+02:00"], 4, now);
    expect(sunday.count).toBe(0);
    expect(states(sunday.days)).toEqual(["today", "future", "future", "future", "future", "future", "future"]);
    const monday = weekOf(["2026-11-09T00:00:00+02:00"], 4, now);
    expect(monday.count).toBe(1);
    expect(monday.days[0].state).toBe("done");
  });

  it("uses Helsinki days, not UTC days", () => {
    // Monday 00:30 Helsinki is still Sunday in UTC.
    const w = weekOf(["2026-11-09T00:30:00+02:00"], 4, NOW);
    expect(w.days[0].state).toBe("done");
  });

  it("holds the boundary in the week summer time ends (Sun 25 Oct 2026)", () => {
    // The week Mon 19 Oct (UTC+3) to Sun 25 Oct (UTC+2 from 04:00).
    const sundayNight = "2026-10-25T23:59:00+02:00";
    const w = weekOf(
      ["2026-10-18T23:59:00+03:00", "2026-10-19T00:00:00+03:00", "2026-10-25T23:00:00+02:00"],
      4,
      sundayNight,
    );
    expect(w.count).toBe(2);
    expect(states(w.days)).toEqual(["done", "missed", "missed", "missed", "missed", "missed", "done"]);

    const nextMonday = weekOf([sundayNight], 4, "2026-10-26T00:00:00+02:00");
    expect(nextMonday.count).toBe(0);
    expect(nextMonday.days[0].state).toBe("today");
  });

  it("holds the boundary in the week summer time starts (Sun 29 Mar 2026)", () => {
    const now = "2026-03-30T00:00:00+03:00";
    expect(weekOf(["2026-03-29T23:59:00+03:00"], 4, now).count).toBe(0);
    expect(weekOf(["2026-03-30T00:00:00+03:00"], 4, now).count).toBe(1);
  });
});

describe("weekSentence", () => {
  it("writes each sentence exactly", () => {
    expect(weekSentence(2, 4)).toBe("2 of 4 days this week. 2 more to go.");
    expect(weekSentence(3, 4)).toBe("3 of 4 days this week. One more makes the week.");
    expect(weekSentence(4, 4)).toBe("Goal met. 4 of 4 days this week.");
  });
});

describe("weeksInARow", () => {
  // Past weeks before the week of 9 Nov.
  const W1 = "2026-11-02";
  const W2 = "2026-10-26";
  const W3 = "2026-10-19"; // summer time ends on its Sunday
  const W4 = "2026-10-12";

  it("counts consecutive past weeks that met the goal", () => {
    const days = [...weekDays(W1, 4), ...weekDays(W2, 5), ...weekDays(W3, 4, "+03:00")];
    expect(weeksInARow(days, 4, NOW)).toBe(3);
  });

  it("forgives one missed day a week automatically", () => {
    const days = [...weekDays(W1, 3), ...weekDays(W2, 3), ...weekDays(W3, 4, "+03:00")];
    expect(weeksInARow(days, 4, NOW)).toBe(3);
  });

  it("breaks at a week two days short", () => {
    const days = [...weekDays(W1, 4), ...weekDays(W2, 2), ...weekDays(W3, 4, "+03:00")];
    expect(weeksInARow(days, 4, NOW)).toBe(1);
  });

  it("breaks at an empty week, even with earlier good weeks", () => {
    const days = [...weekDays(W2, 4), ...weekDays(W3, 4, "+03:00"), ...weekDays(W4, 4, "+03:00")];
    expect(weeksInARow(days, 4, NOW)).toBe(0);
  });

  it("adds this week only once its goal is fully met", () => {
    const past = [...weekDays(W1, 4), ...weekDays(W2, 4)];
    expect(weeksInARow([...past, MON, TUE, WED], 4, NOW)).toBe(2);
    expect(weeksInARow([...past, MON, TUE, WED, THU], 4, NOW)).toBe(3);
    expect(weeksInARow([MON, TUE, WED, THU], 4, NOW)).toBe(1);
  });

  it("does not let a quiet start to this week break the streak", () => {
    const past = [...weekDays(W1, 4), ...weekDays(W2, 4)];
    expect(weeksInARow(past, 4, "2026-11-09T08:00:00+02:00")).toBe(2);
  });

  it("splits weeks at Monday 00:00 Helsinki", () => {
    // Three days ending Sunday 23:59 plus Monday 00:00 is 3 + 1, not 4 in one week.
    const days = [
      "2026-11-06T12:00:00+02:00",
      "2026-11-07T12:00:00+02:00",
      "2026-11-08T23:59:00+02:00",
      "2026-11-09T00:00:00+02:00",
    ];
    expect(weeksInARow(days, 4, NOW)).toBe(1);
    expect(weekOf(days, 4, NOW).count).toBe(1);
  });

  it("never keeps an empty week, even with goal 1", () => {
    expect(weeksInARow([...weekDays(W2, 1)], 1, NOW)).toBe(0);
    expect(weeksInARow([...weekDays(W1, 1), ...weekDays(W2, 1)], 1, NOW)).toBe(2);
  });

  it("is 0 with no reviews", () => {
    expect(weeksInARow([], 4, NOW)).toBe(0);
  });
});

describe("free skip", () => {
  it("is left while the full goal can still be reached", () => {
    // Saturday, 3 done, Saturday and Sunday still open.
    expect(freeSkipsLeft([MON, WED, THU], 4, NOW)).toBe(1);
    // 2 done, two days open: exactly reachable.
    expect(freeSkipsLeft([MON, WED], 4, NOW)).toBe(1);
  });

  it("is used once the week can only be kept with it", () => {
    expect(freeSkipsLeft([MON], 4, NOW)).toBe(0);
    // Sunday evening, reviewed today, 3 of 4: kept only by the skip.
    const sunday = "2026-11-15T20:00:00+02:00";
    expect(freeSkipsLeft([MON, WED, sunday], 4, sunday)).toBe(0);
  });

  it("stays left once the goal is met", () => {
    expect(freeSkipsLeft([MON, TUE, WED, THU], 4, "2026-11-15T20:00:00+02:00")).toBe(1);
  });

  it("writes the labels and the streak line", () => {
    expect(freeSkipLabel(1)).toBe("1 FREE SKIP LEFT");
    expect(freeSkipLabel(0)).toBe("FREE SKIP USED");
    expect(streakLine(3, 1)).toBe("3 WEEKS IN A ROW · 1 FREE SKIP LEFT");
    expect(streakLine(1, 0)).toBe("1 WEEK IN A ROW · FREE SKIP USED");
  });

  it("leaves the streak line out with no week in a row yet", () => {
    expect(streakLine(0, 1)).toBe("");
    expect(streakLine(0, 0)).toBe("");
  });
});

describe("goalFor: every day until the exam", () => {
  // "Now" is Saturday 14 Nov; this week is Mon 9 to Sun 15.
  const EXAM_23 = "2026-11-23T09:00:00+02:00"; // 9 days away
  const EXAM_DEC = "2026-12-04T09:00:00+02:00"; // 20 days away

  it("keeps the usual goal with no exam, one more than 14 days away, on exam day or after it", () => {
    expect(goalFor([MON], null, NOW)).toBe(DEFAULT_GOAL);
    expect(goalFor([MON], EXAM_DEC, NOW)).toBe(DEFAULT_GOAL);
    expect(goalFor([MON], "2026-11-29T09:00:00+02:00", NOW)).toBe(DEFAULT_GOAL); // 15 days
    expect(goalFor([MON], "2026-11-14T18:00:00+02:00", NOW)).toBe(DEFAULT_GOAL); // today
    expect(goalFor([MON], "2026-11-12T09:00:00+02:00", NOW)).toBe(DEFAULT_GOAL); // past
  });

  it("within 14 days is the days she studied plus every day still open this week", () => {
    // Saturday, nothing studied this week: today and Sunday are open.
    expect(goalFor([], EXAM_23, NOW)).toBe(2);
    // Studied Monday and Wednesday (missed days are not held against her): 2 done, 2 open.
    expect(goalFor([MON, WED], EXAM_23, NOW)).toBe(4);
    // Studied today already: today is done, Sunday is open.
    expect(goalFor([MON, WED, SAT], EXAM_23, NOW)).toBe(4);
    // 14 days away exactly counts.
    expect(goalFor([], "2026-11-28T09:00:00+02:00", NOW)).toBe(2);
    // On a Monday with the exam the Monday after: every day of the week.
    expect(goalFor([], EXAM_23, "2026-11-16T08:00:00+02:00")).toBe(7);
    expect(weekOf([], goalFor([], EXAM_23, "2026-11-16T08:00:00+02:00"), "2026-11-16T08:00:00+02:00").sentence).toBe(
      "0 of 7 days this week. 7 more to go.",
    );
  });

  it("stops at the day before the exam", () => {
    // Monday 16 Nov, exam on Thursday 19: Monday, Tuesday, Wednesday.
    expect(goalFor([], "2026-11-19T09:00:00+02:00", "2026-11-16T08:00:00+02:00")).toBe(3);
    // The day before the exam, already studied today and Monday: nothing more is open.
    const wed = "2026-11-18T20:00:00+02:00";
    expect(goalFor(["2026-11-16T10:00:00+02:00", "2026-11-18T10:00:00+02:00"], "2026-11-19T09:00:00+02:00", wed)).toBe(2);
    expect(weekOf(["2026-11-16T10:00:00+02:00", "2026-11-18T10:00:00+02:00"], 2, wed).met).toBe(true);
  });
});
