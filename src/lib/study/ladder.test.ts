import { describe, expect, it } from "vitest";
import {
  PHASES,
  RUNGS,
  conceptMastery,
  focusConcept,
  phaseOf,
  phasePosition,
  rungName,
  rungOf,
} from "./ladder";
import { grade, newCard, recallAt } from "./memory";

const NOW = new Date("2026-11-14T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const EXAM = new Date(NOW.getTime() + 7 * DAY);

describe("RUNGS", () => {
  it("has the prototype's names, descriptions and thresholds", () => {
    expect(RUNGS.map((r) => [r.name, r.description, r.threshold])).toEqual([
      ["Recognise", "Pick it out of four", 0.3],
      ["Fill the gap", "Type the missing words", 0.45],
      ["Recall", "Say it before you flip", 0.6],
      ["Explain it", "In your own words", 0.75],
      ["Exam-ready", "Exam-style questions", 0.9],
    ]);
  });

  it("names rung 0 Not started", () => {
    expect(rungName(0)).toBe("Not started");
    expect(rungName(5)).toBe("Exam-ready");
  });
});

describe("rungOf", () => {
  it("is 0 at 0 and 5 at 1", () => {
    expect(rungOf(0)).toBe(0);
    expect(rungOf(1)).toBe(5);
  });

  it.each([
    [0.3, 1],
    [0.45, 2],
    [0.6, 3],
    [0.75, 4],
    [0.9, 5],
  ])("reaches the rung exactly at %s and not just below", (t, level) => {
    expect(rungOf(t)).toBe(level);
    expect(rungOf(t - 0.001)).toBe(level - 1);
  });

  it("absorbs float noise at a threshold", () => {
    expect(rungOf(0.1 + 0.2)).toBe(1); // 0.30000000000000004
    expect(rungOf(0.3 - 1e-12)).toBe(1);
  });
});

describe("phaseOf", () => {
  it.each([
    [11, "Learn"],
    [10, "Strengthen"],
    [4, "Strengthen"],
    [3, "Final review"],
    [1, "Final review"],
    [0, "Exam day"],
  ])("%s days left is %s", (d, name) => {
    expect(phaseOf(d).name).toBe(name);
  });

  it("treats a past exam (negative days) as Exam day", () => {
    expect(phaseOf(-1).name).toBe("Exam day");
  });

  it("carries the prototype's description sentences", () => {
    expect(PHASES.map((p) => p.description)).toEqual([
      "New concepts, first rungs of the ladder.",
      "More reviews and exam-style questions.",
      "Your weakest concepts and a mock exam.",
      "A 10-card warm-up. Nothing new.",
    ]);
    expect(PHASES.reduce((s, p) => s + p.width, 0)).toBe(100);
  });
});

describe("phasePosition", () => {
  it.each([
    [30, 38 * 0.1],
    [24, 38 * 0.1],
    [11, 38 * 0.9],
    [10, 38 + 34 * 0.1],
    [4, 38 + 34 * (6 / 7)],
    [3, 72 + 20 * 0.1],
    [1, 72 + 20 * (2 / 3)],
    [0, 92 + 8 * 0.5],
    [-2, 96],
  ])("%s days left sits at %s", (d, pos) => {
    expect(phasePosition(d)).toBeCloseTo(pos, 9);
  });

  it("moves right as the exam gets closer", () => {
    let prev = -1;
    for (let d = 30; d >= 0; d--) {
      const p = phasePosition(d);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

describe("focusConcept", () => {
  it("is null for no concepts", () => {
    expect(focusConcept([])).toBeNull();
  });

  it("picks the largest weight * (1 - mastery)", () => {
    const a = { id: "a", weight: 3, mastery: 0.9 }; // 0.3
    const b = { id: "b", weight: 1, mastery: 0.2 }; // 0.8
    const c = { id: "c", weight: 2, mastery: 0.5 }; // 1.0
    expect(focusConcept([a, b, c])?.id).toBe("c");
  });

  it("breaks ties by list order (first wins)", () => {
    const a = { id: "a", weight: 2, mastery: 0.5 };
    const b = { id: "b", weight: 1, mastery: 0 };
    expect(focusConcept([a, b])?.id).toBe("a");
    expect(focusConcept([b, a])?.id).toBe("b");
  });

  it("still returns one when every score is 0", () => {
    const a = { id: "a", weight: 1, mastery: 1 };
    const b = { id: "b", weight: 0, mastery: 0 };
    expect(focusConcept([a, b])?.id).toBe("a");
  });
});

describe("conceptMastery", () => {
  const learned = grade(grade(newCard(NOW), 3, NOW), 3, new Date(NOW.getTime() + 10 * 60 * 1000));
  const fresh = newCard(NOW);

  it("is 0 with no cards", () => {
    expect(conceptMastery([], EXAM)).toBe(0);
  });

  it("is 0 when no card is active", () => {
    expect(conceptMastery([{ state: learned, active: false }], EXAM)).toBe(0);
  });

  it("is the mean recall on exam day over active cards only", () => {
    const r = recallAt(learned, EXAM);
    expect(r).toBeGreaterThan(0);
    const m = conceptMastery(
      [
        { state: learned, active: true },
        { state: fresh, active: true },
        { state: learned, active: false },
      ],
      EXAM,
    );
    expect(m).toBeCloseTo(r / 2, 12);
  });

  it("is lower for a later exam", () => {
    const cards = [{ state: learned, active: true }];
    const later = new Date(EXAM.getTime() + 30 * DAY);
    expect(conceptMastery(cards, later)).toBeLessThan(conceptMastery(cards, EXAM));
  });
});
