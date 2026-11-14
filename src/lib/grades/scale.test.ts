import { describe, expect, it } from "vitest";
import { gradeFromPct, gradeStep } from "./scale";

describe("gradeFromPct", () => {
  it("is 0 under 50", () => {
    expect(gradeFromPct(0)).toBe(0);
    expect(gradeFromPct(49.9)).toBe(0);
  });

  it("starts at 1 on 50 and climbs a grade per 10 points", () => {
    expect(gradeFromPct(50)).toBe(1);
    expect(gradeFromPct(60)).toBe(2);
    expect(gradeFromPct(80)).toBe(4);
    expect(gradeFromPct(85)).toBe(4.5);
  });

  it("caps at 5", () => {
    expect(gradeFromPct(90)).toBe(5);
    expect(gradeFromPct(100)).toBe(5);
    expect(gradeFromPct(120)).toBe(5);
  });
});

describe("gradeStep", () => {
  it("floors to a whole grade", () => {
    expect(gradeStep(49.9)).toBe(0);
    expect(gradeStep(50)).toBe(1);
    expect(gradeStep(59.9)).toBe(1);
    expect(gradeStep(80)).toBe(4);
    expect(gradeStep(89.9)).toBe(4);
    expect(gradeStep(150)).toBe(5);
  });

  it("absorbs float noise just under a step", () => {
    expect(gradeStep(69.99999999999999)).toBe(3);
  });
});
