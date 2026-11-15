import { describe, expect, it } from "vitest";
import {
  HISTORY_DAYS,
  forecastNow,
  forecastShown,
  gradeFor,
  history,
  planCurve,
  planEnd,
  stopCurve,
  verdict,
  type DailySnapshot,
} from "./forecast";

// The prototype's exam (main-flow.html EXAM_DATA.exam), mastery at its start (m0).
const EXAM = {
  daysLeft: 6,
  target: 80,
  concepts: [
    { id: "gov", weight: 0.15, mastery: 0.8 },
    { id: "dec", weight: 0.15, mastery: 0.7 },
    { id: "src", weight: 0.2, mastery: 0.55 },
    { id: "sla", weight: 0.15, mastery: 0.5 },
    { id: "dsa", weight: 0.2, mastery: 0.42 },
    { id: "val", weight: 0.15, mastery: 0.25 },
  ],
};

describe("forecastNow", () => {
  it("gives the prototype's exam the forecast the prototype shows (53%)", () => {
    expect(forecastNow(EXAM.concepts)).toBeCloseTo(53.15, 10);
    expect(forecastShown(EXAM.concepts)).toBe(53);
  });

  it("weights by exam weight, on any weight scale", () => {
    expect(
      forecastNow([
        { weight: 3, mastery: 1 },
        { weight: 1, mastery: 0 },
      ]),
    ).toBe(75);
  });

  it("is 0 for no concepts or zero total weight", () => {
    expect(forecastNow([])).toBe(0);
    expect(forecastNow([{ weight: 0, mastery: 0.9 }])).toBe(0);
  });
});

describe("planEnd", () => {
  it("adds 5.5 points per day left", () => {
    expect(planEnd(53, 6)).toBe(86);
    expect(planEnd(40, 0)).toBe(40);
  });

  it("caps at 94", () => {
    expect(planEnd(45, 13)).toBe(94);
    expect(planEnd(93, 1)).toBe(94);
  });

  it("does not fall below today's forecast after the exam day", () => {
    // The day after the exam `daysLeft` is -1: this used to give 2 - 5.5 = -3.5.
    expect(planEnd(2, -1)).toBe(2);
    expect(planEnd(40, -17)).toBe(40);
    expect(verdict(2, 80, planEnd(2, -1)).key).toBe("tight");
  });
});

describe("planCurve", () => {
  it("runs daily from today's forecast to planEnd on exam day", () => {
    const c = planCurve(53, 6);
    expect(c).toHaveLength(7);
    expect(c[0]).toBe(53);
    expect(c[6]).toBeCloseTo(86, 10);
  });

  it("rises steadily, fastest at the start", () => {
    const c = planCurve(53, 6);
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThan(c[i - 1]);
    expect(c[1] - c[0]).toBeGreaterThan(c[6] - c[5]);
  });

  it("ends at the cap when the gain would pass it", () => {
    const c = planCurve(45, 13);
    expect(c).toHaveLength(14);
    expect(c[13]).toBeCloseTo(94, 10);
  });

  it("is just today on exam day", () => {
    expect(planCurve(60, 0)).toEqual([60]);
  });
});

describe("stopCurve", () => {
  it("loses 3.5% of today's forecast per day", () => {
    const c = stopCurve(53, 6);
    expect(c).toHaveLength(7);
    expect(c[0]).toBe(53);
    expect(c[6]).toBeCloseTo(53 * (1 - 0.035 * 6), 10);
  });

  it("never goes below 0", () => {
    const c = stopCurve(50, 40);
    expect(c[40]).toBe(0);
  });

  it("is just today on exam day", () => {
    expect(stopCurve(60, 0)).toEqual([60]);
  });
});

describe("verdict", () => {
  it("is ready when today's forecast meets the target", () => {
    const v = verdict(80, 80, planEnd(80, 3));
    expect(v.key).toBe("ready");
    expect(v.text).toBe("Ready. Keep it warm.");
    expect(v.ok).toBe(true);
  });

  it("is on track when a bite a day reaches the target (the prototype's exam)", () => {
    const f = forecastShown(EXAM.concepts);
    const v = verdict(f, EXAM.target, planEnd(f, EXAM.daysLeft));
    expect(v.key).toBe("on_track");
    expect(v.text).toBe("On track with a bite a day");
    expect(v.ok).toBe(true);
  });

  it("is tight when even a bite a day falls short", () => {
    const v = verdict(53, 80, planEnd(53, 2));
    expect(v.key).toBe("tight");
    expect(v.text).toBe("Tight. Two bites a day gets you there.");
    expect(v.ok).toBe(false);
  });

  it("counts reaching the target exactly as on track", () => {
    expect(verdict(69, 80, 80).key).toBe("on_track");
  });
});

describe("gradeFor", () => {
  it("is the whole grade step for a percentage", () => {
    expect(gradeFor(49.9)).toBe(0);
    expect(gradeFor(50)).toBe(1);
    expect(gradeFor(53)).toBe(1);
    expect(gradeFor(80)).toBe(4);
    expect(gradeFor(86)).toBe(4);
    expect(gradeFor(100)).toBe(5);
  });
});

describe("history", () => {
  const concepts = [
    { id: "a", weight: 1 },
    { id: "b", weight: 1 },
  ];
  const snap = (day: string, a: number, b: number): DailySnapshot => ({
    day,
    mastery: { a, b },
  });

  it("keeps the last 13 days, oldest first", () => {
    const snaps: DailySnapshot[] = [];
    for (let d = 1; d <= 20; d++) {
      const day = `2026-11-${String(d).padStart(2, "0")}`;
      snaps.push(snap(day, d / 100, d / 100));
    }
    const h = history([...snaps].reverse(), concepts);
    expect(h).toHaveLength(HISTORY_DAYS);
    expect(h[0]).toBeCloseTo(8, 10);
    expect(h[12]).toBeCloseTo(20, 10);
  });

  it("repeats the previous day across days without a snapshot", () => {
    const h = history(
      [snap("2026-11-01", 0.2, 0.2), snap("2026-11-04", 0.5, 0.3)],
      concepts,
    );
    expect(h.map((v) => Math.round(v))).toEqual([20, 20, 20, 40]);
  });

  it("carries a snapshot from before the window into its first day", () => {
    const h = history(
      [snap("2026-10-01", 0.3, 0.3), snap("2026-11-20", 0.6, 0.6)],
      concepts,
    );
    expect(h).toHaveLength(HISTORY_DAYS);
    expect(h[0]).toBeCloseTo(30, 10);
    expect(h[12]).toBeCloseTo(60, 10);
  });

  it("crosses month ends by calendar day", () => {
    const h = history(
      [snap("2026-10-31", 0.1, 0.1), snap("2026-11-01", 0.2, 0.2)],
      concepts,
    );
    expect(h).toHaveLength(2);
  });

  it("counts a concept missing from a snapshot as 0", () => {
    expect(history([{ day: "2026-11-01", mastery: { a: 0.8 } }], concepts)).toEqual([40]);
  });

  it("lets the later snapshot win on a shared day", () => {
    expect(
      history([snap("2026-11-01", 0.1, 0.1), snap("2026-11-01", 0.9, 0.9)], concepts),
    ).toEqual([90]);
  });

  it("is empty with no snapshots", () => {
    expect(history([], concepts)).toEqual([]);
  });
});
