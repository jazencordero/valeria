import { describe, expect, it } from "vitest";
import { weekModel, type WeekItem } from "./week";

// Saturday 14 November 2026, 15:48 in Helsinki (UTC+2 in winter).
const NOW = new Date("2026-11-14T13:48:00Z");

let n = 0;
function item(kind: WeekItem["kind"], at: string, title = `Item ${++n}`, done = false): WeekItem {
  return { id: `i${++n}`, kind, title, at, done };
}

describe("weekModel", () => {
  it("lays out 7 days from today, today first", () => {
    const m = weekModel([], NOW);
    expect(m.days.map((d) => `${d.weekday} ${d.day}`)).toEqual([
      "SAT 14",
      "SUN 15",
      "MON 16",
      "TUE 17",
      "WED 18",
      "THU 19",
      "FRI 20",
    ]);
    expect(m.days.map((d) => d.today)).toEqual([true, false, false, false, false, false, false]);
  });

  it("a week with nothing: no markers, no agenda, 'Nothing due this week.'", () => {
    const m = weekModel([], NOW);
    expect(m.days.every((d) => d.marker === null)).toBe(true);
    expect(m.agenda).toEqual([]);
    expect(m.line).toBe("Nothing due this week.");
    expect(m.summary).toBe("");
  });

  it("the prototype week: due today, deadlines Tue and Thu, exam Fri", () => {
    const m = weekModel(
      [
        item("deadline", "2026-11-14T19:00:00Z", "Reading response"),
        item("deadline", "2026-11-17T21:59:00Z", "Case memo 2"),
        item("deadline", "2026-11-19T10:00:00Z", "Service blueprint draft"),
        item("exam", "2026-11-20T07:00:00Z", "Exam"),
      ],
      NOW,
    );
    expect(m.days.map((d) => d.marker)).toEqual([
      "due_today",
      null,
      null,
      "deadline",
      null,
      "deadline",
      "exam",
    ]);
    expect(m.agenda.map((r) => [r.date, r.title])).toEqual([
      ["TUE 17", "Case memo 2"],
      ["THU 19", "Service blueprint draft"],
      ["FRI 20", "Exam"],
    ]);
    expect(m.line).toBe("Nothing else is due before Tuesday.");
    expect(m.summary).toBe("Due today. Deadlines Tuesday and Thursday. Exam Friday.");
  });

  it("a done item: done dot, not in the agenda, not counted as due", () => {
    const m = weekModel([item("deadline", "2026-11-16T21:59:00Z", "Case memo 1", true)], NOW);
    expect(m.days[2].marker).toBe("done");
    expect(m.agenda).toEqual([]);
    expect(m.line).toBe("Nothing due this week.");
    expect(m.summary).toBe("Done Monday.");
  });

  it("a done item today is a done dot, not due today", () => {
    const m = weekModel([item("quiz", "2026-11-14T20:00:00Z", "Quiz 3", true)], NOW);
    expect(m.days[0].marker).toBe("done");
  });

  it("an open item beats a done one on the same day", () => {
    const m = weekModel(
      [
        item("deadline", "2026-11-16T08:00:00Z", "A", true),
        item("deadline", "2026-11-16T20:00:00Z", "B"),
      ],
      NOW,
    );
    expect(m.days[2].marker).toBe("deadline");
    expect(m.agenda.map((r) => r.title)).toEqual(["B"]);
  });

  it("an exam: ring marker, in the agenda, but not 'due'", () => {
    const m = weekModel([item("exam", "2026-11-18T08:00:00Z", "Marketing exam")], NOW);
    expect(m.days[4].marker).toBe("exam");
    expect(m.agenda).toEqual([
      { id: expect.any(String), date: "WED 18", title: "Marketing exam", kind: "exam" },
    ]);
    expect(m.line).toBe("Nothing due this week.");
    expect(m.summary).toBe("Exam Wednesday.");
  });

  it("an exam wins over a deadline on the same day, also today", () => {
    const m = weekModel(
      [
        item("deadline", "2026-11-14T18:00:00Z", "Memo"),
        item("exam", "2026-11-14T20:00:00Z", "Exam"),
      ],
      NOW,
    );
    expect(m.days[0].marker).toBe("exam");
    expect(m.summary).toBe("Exam today.");
  });

  it("quizzes count as deadlines", () => {
    const m = weekModel([item("quiz", "2026-11-15T10:00:00Z", "Quiz 4")], NOW);
    expect(m.days[1].marker).toBe("deadline");
    expect(m.line).toBe("Nothing else is due before Sunday.");
  });

  describe("the line", () => {
    it("names the weekday of the earliest open item after today", () => {
      const m = weekModel(
        [
          item("deadline", "2026-11-19T10:00:00Z", "Later"),
          item("deadline", "2026-11-16T10:00:00Z", "Sooner"),
        ],
        NOW,
      );
      expect(m.line).toBe("Nothing else is due before Monday.");
      expect(m.agenda.map((r) => r.title)).toEqual(["Sooner", "Later"]);
    });

    it("skips an exam when naming the next due day", () => {
      const m = weekModel(
        [
          item("exam", "2026-11-16T08:00:00Z", "Exam"),
          item("deadline", "2026-11-18T10:00:00Z", "Memo"),
        ],
        NOW,
      );
      expect(m.line).toBe("Nothing else is due before Wednesday.");
    });

    it("is null when only today has something due", () => {
      const m = weekModel([item("deadline", "2026-11-14T19:00:00Z", "Tonight")], NOW);
      expect(m.days[0].marker).toBe("due_today");
      expect(m.agenda).toEqual([]);
      expect(m.line).toBeNull();
    });

    it("ignores items past the seventh day", () => {
      const m = weekModel([item("deadline", "2026-11-24T10:00:00Z", "Next week")], NOW);
      expect(m.line).toBe("Nothing due this week.");
      expect(m.agenda).toEqual([]);
    });
  });

  describe("Helsinki boundaries", () => {
    it("23:59 Helsinki tonight is today, 00:00 is tomorrow", () => {
      const m = weekModel(
        [
          item("deadline", "2026-11-14T21:59:00Z", "Tonight"),
          item("deadline", "2026-11-14T22:00:00Z", "Midnight"),
        ],
        NOW,
      );
      expect(m.days[0].marker).toBe("due_today");
      expect(m.days[1].marker).toBe("deadline");
      expect(m.agenda.map((r) => [r.date, r.title])).toEqual([["SUN 15", "Midnight"]]);
      expect(m.line).toBe("Nothing else is due before Sunday.");
    });

    it("the window ends at Friday 23:59 Helsinki", () => {
      const m = weekModel(
        [
          item("deadline", "2026-11-20T21:59:00Z", "Friday night"),
          item("deadline", "2026-11-20T22:00:00Z", "Saturday"),
        ],
        NOW,
      );
      expect(m.agenda.map((r) => r.title)).toEqual(["Friday night"]);
      expect(m.days[6].marker).toBe("deadline");
    });

    it("leaves out anything before today, even late open items", () => {
      const m = weekModel([item("deadline", "2026-11-13T21:00:00Z", "Yesterday")], NOW);
      expect(m.days.every((d) => d.marker === null)).toBe(true);
      expect(m.line).toBe("Nothing due this week.");
    });

    it("past 22:00 UTC it is already the next day in Helsinki", () => {
      // Saturday 23:30 UTC is Sunday 01:30 in Helsinki.
      const m = weekModel([], new Date("2026-11-14T23:30:00Z"));
      expect(`${m.days[0].weekday} ${m.days[0].day}`).toBe("SUN 15");
    });

    it("keeps one strip day per calendar day across the autumn clock change", () => {
      // Sunday 25 Oct 2026 is 25 hours long in Helsinki; now is 00:30 that day.
      const m = weekModel([], new Date("2026-10-24T21:30:00Z"));
      expect(m.days.map((d) => `${d.weekday} ${d.day}`)).toEqual([
        "SUN 25",
        "MON 26",
        "TUE 27",
        "WED 28",
        "THU 29",
        "FRI 30",
        "SAT 31",
      ]);
    });

    it("keeps one strip day per calendar day across the spring clock change", () => {
      // Sunday 29 Mar 2026 is 23 hours long; now is Saturday 23:30.
      const m = weekModel([], new Date("2026-03-28T21:30:00Z"));
      expect(m.days.map((d) => `${d.weekday} ${d.day}`)).toEqual([
        "SAT 28",
        "SUN 29",
        "MON 30",
        "TUE 31",
        "WED 1",
        "THU 2",
        "FRI 3",
      ]);
    });
  });
});
