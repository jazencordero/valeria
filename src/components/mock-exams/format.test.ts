import { describe, expect, it } from "vitest";
import { itemLetter, liveScore, num, paperPoints, partScore, partsOf, trueFalseScore } from "./format";
import { sampleAttempt, sampleExam } from "./sample-exam";

describe("mock exam format", () => {
  it("prints points in the teacher's form", () => {
    expect(paperPoints(2)).toBe("(2p)");
    expect(paperPoints(1.5)).toBe("(1.5p)");
    expect(num(-1)).toBe("−1");
    expect(itemLetter(0)).toBe("(a)");
    expect(itemLetter(5)).toBe("(f)");
  });

  it("labels written parts as on the paper", () => {
    const labels = partsOf(sampleExam.questions).map((p) => p.label);
    expect(labels).toContain("2(a)");
    expect(labels).toContain("4(a) ii.");
    expect(labels).toContain("4(b) iii.");
  });

  it("caps a part at its points", () => {
    const part = { points: 3, ticks: [{ points: 2 }, { points: 2 }] };
    expect(partScore(part, [{ index: 0, fromCheck: false }])).toBe(2);
    expect(partScore(part, [{ index: 0, fromCheck: false }, { index: 1, fromCheck: true }])).toBe(3);
  });

  it("scores question 1 +1 / −1 / 0, never below 0", () => {
    const all = trueFalseScore(sampleExam, { trueFalse: { 0: false, 1: true, 2: false, 3: null } });
    expect(all).toEqual({ right: 0, wrong: 3, blank: 3, score: 0 });
    const some = trueFalseScore(sampleExam, { trueFalse: { 0: true, 1: false, 2: false } });
    expect(some.score).toBe(1);
  });

  it("adds the four questions", () => {
    const s = liveScore(sampleExam, sampleAttempt({ trueFalse: { 0: true, 1: false }, ticks: { "3.0.0": [{ index: 0, fromCheck: false }] } }));
    expect(s.questions.map((q) => q.score)).toEqual([2, 0, 1.5, 0]);
    expect(s.total).toBe(3.5);
  });
});
