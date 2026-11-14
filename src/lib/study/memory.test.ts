import { describe, expect, it } from "vitest";
import {
  grade,
  intervalLabel,
  newCard,
  passFail,
  preview,
  recallAt,
  type MemoryState,
} from "./memory";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-14T13:48:00Z");
const at = (ms: number) => new Date(ms);

/** New card -> Good (10 min step) -> Good (graduates). */
function graduated(): { state: MemoryState; reviewedAt: Date } {
  const s1 = grade(newCard(NOW), 3, NOW);
  const t2 = at(s1.dueAt);
  return { state: grade(s1, 3, t2), reviewedAt: t2 };
}

describe("newCard", () => {
  it("is due now and never reviewed", () => {
    const s = newCard(NOW);
    expect(s.dueAt).toBe(NOW.getTime());
    expect(s.lastReviewAt).toBeNull();
    expect(s.state).toBe(0);
  });
});

describe("grade", () => {
  it("a missed new card is due in 1 minute", () => {
    const s = grade(newCard(NOW), 1, NOW);
    expect(s.dueAt - NOW.getTime()).toBe(1 * MIN);
  });

  it("Good on a new card is due in 10 minutes, then Good again is days", () => {
    const s1 = grade(newCard(NOW), 3, NOW);
    expect(s1.dueAt - NOW.getTime()).toBe(10 * MIN);

    const t2 = at(s1.dueAt);
    const s2 = grade(s1, 3, t2);
    expect(s2.dueAt - t2.getTime()).toBeGreaterThanOrEqual(1 * DAY);
    expect(s2.state).toBe(2);
  });

  it("a missed review card is due in 1 minute", () => {
    const { state } = graduated();
    const t3 = at(state.dueAt);
    const s3 = grade(state, 1, t3);
    expect(s3.dueAt - t3.getTime()).toBe(1 * MIN);
    expect(s3.lapses).toBe(1);
  });

  it("does not change the state it was given", () => {
    const s = newCard(NOW);
    const copy = structuredClone(s);
    grade(s, 3, NOW);
    expect(s).toEqual(copy);
  });
});

describe("recallAt", () => {
  it("is 0 for a card never graded", () => {
    expect(recallAt(newCard(NOW), NOW)).toBe(0);
  });

  it("falls as time passes and stays within 0..1", () => {
    const { state, reviewedAt } = graduated();
    const t = reviewedAt.getTime();
    const r = [0, 1, 7, 30, 365].map((d) => recallAt(state, at(t + d * DAY)));
    for (const x of r) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < r.length; i++) expect(r[i]).toBeLessThan(r[i - 1]);
  });
});

describe("preview", () => {
  it("gives the four intervals for a new card", () => {
    const p = preview(newCard(NOW), NOW);
    expect(p[1]).toBe(1 * MIN);
    expect(p[3]).toBe(10 * MIN);
    expect(p[2]).toBeGreaterThan(p[1]);
    expect(p[3]).toBeGreaterThan(p[2]);
    expect(p[4]).toBeGreaterThanOrEqual(1 * DAY);
  });

  it("matches what grade() then does", () => {
    const { state } = graduated();
    const now = at(state.dueAt);
    const p = preview(state, now);
    for (const g of [1, 2, 3, 4] as const) {
      expect(grade(state, g, now).dueAt - now.getTime()).toBe(p[g]);
    }
  });
});

describe("intervalLabel", () => {
  it.each([
    [0, "<1 min"],
    [1 * MIN, "<1 min"],
    [1.49 * MIN, "<1 min"],
    [1.5 * MIN, "2 min"],
    [10 * MIN, "10 min"],
    [59 * MIN, "59 min"],
    [59.6 * MIN, "60 min"],
    [60 * MIN, "1 h"],
    [5 * HOUR, "5 h"],
    [23.9 * HOUR, "24 h"],
    [1 * DAY, "1 d"],
    [4 * DAY, "4 d"],
    [29 * DAY, "29 d"],
    [29.4 * DAY, "29 d"],
    [29.5 * DAY, "1 mo"],
    [30 * DAY, "1 mo"],
    [44 * DAY, "1 mo"],
    [45 * DAY, "2 mo"],
    [365 * DAY, "12 mo"],
  ])("%d ms -> %s", (ms, label) => {
    expect(intervalLabel(ms)).toBe(label);
  });
});

describe("passFail", () => {
  it("maps right to Good and wrong to Again", () => {
    expect(passFail(true)).toBe(3);
    expect(passFail(false)).toBe(1);
  });
});

describe("JSON round-trip", () => {
  it("state is plain JSON and schedules the same after a round-trip", () => {
    const s1 = grade(newCard(NOW), 3, NOW);
    const back = JSON.parse(JSON.stringify(s1)) as MemoryState;
    expect(back).toEqual(s1);

    const t2 = at(s1.dueAt);
    expect(grade(back, 3, t2)).toEqual(grade(s1, 3, t2));
    expect(preview(back, t2)).toEqual(preview(s1, t2));

    const { state } = graduated();
    const again = JSON.parse(JSON.stringify(state)) as MemoryState;
    const later = at(state.dueAt + 3 * DAY);
    expect(recallAt(again, later)).toBe(recallAt(state, later));
  });
});
