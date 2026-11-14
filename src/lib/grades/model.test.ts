import { describe, expect, it } from "vitest";
import {
  NEEDS_WEIGHTS,
  chartSeries,
  fillFor,
  mattersMost,
  needed,
  normaliseWeights,
  overall,
  soFar,
  swing,
  trajectory,
  verdict,
  type ChartSeries,
  type GradeItem,
  type Swing,
} from "./model";

type Item = GradeItem & { short: string };
const g = (id: string, short: string, weight: number | null, score: number | null): Item => ({
  id,
  short,
  weight,
  score,
});

// The prototype's four sample courses (main-flow.html JS 3609-3630): ids,
// weights and scores only.
const FM: Item[] = [
  g("a1", "A1", 0.1, 90),
  g("a2", "A2", 0.1, 80),
  g("a3", "A3", 0.1, null),
  g("a4", "A4", 0.1, null),
  g("ex", "Exam", 0.6, null),
];
const SIT: Item[] = [g("c1", "C1", 0.2, 80), g("c2", "C2", 0.2, null), g("ex", "Exam", 0.6, null)];
const SCA: Item[] = [
  g("m1", "M1", 0.15, 95),
  g("q1", "Q1", 0.05, 90),
  g("q2", "Q2", 0.05, 100),
  g("m2", "M2", 0.15, null),
  g("pr", "Proj", 0.3, null),
  g("ex", "Exam", 0.3, null),
];
const DSD: Item[] = [g("sb", "Blueprint", 0.4, null), g("fc", "Final", 0.6, null)];

const byId = (items: Item[], id: string) => items.find((i) => i.id === id)!;
const asSwing = (v: unknown) => v as Swing;
const asSeries = (v: unknown) => v as ChartSeries;

describe("the prototype's four courses (no what-ifs, target 5)", () => {
  it("give the prototype's trajectories", () => {
    expect(trajectory(FM)).toBeCloseTo(4.5, 9);
    expect(trajectory(SIT)).toBeCloseTo(4.0, 9);
    expect(trajectory(SCA)).toBeCloseTo(5.0, 9);
    expect(trajectory(DSD)).toBeNull(); // shown as "–", "Too early for a trajectory"
  });

  it("give the prototype's verdicts", () => {
    const fm = verdict(FM, 5);
    expect(fm.kind).toBe("within");
    expect(fm.kind === "within" && fm.need).toBeCloseTo(91.25, 9);

    const sit = verdict(SIT, 5);
    expect(sit.kind).toBe("within");
    expect(sit.kind === "within" && sit.need).toBeCloseTo(92.5, 9);

    const sca = verdict(SCA, 5);
    expect(sca.kind).toBe("on"); // needs 88.3, average so far is 95
    expect(sca.kind === "on" && sca.need).toBeCloseTo(88.3333333, 6);

    const dsd = verdict(DSD, 5);
    expect(dsd.kind).toBe("within"); // nothing graded: no average to be "on" against
    expect(dsd.kind === "within" && dsd.need).toBeCloseTo(90, 9);
  });

  it("give the prototype's 'matters most' items", () => {
    expect(mattersMost(FM)).toBe(byId(FM, "ex"));
    expect(mattersMost(SIT)).toBe(byId(SIT, "ex"));
    // Project and Exam tie at 0.85; the earlier one wins.
    expect(mattersMost(SCA)).toBe(byId(SCA, "pr"));
    // No swings at all: the heaviest item wins.
    expect(mattersMost(DSD)).toBe(byId(DSD, "fc"));
  });

  it("give the prototype's swings", () => {
    const a3 = asSwing(swing(byId(FM, "a3"), FM));
    expect(a3.lo).toBeCloseTo(4.15, 9);
    expect(a3.hi).toBeCloseTo(4.65, 9);
    expect(a3.size).toBeCloseTo(0.5, 9);

    const ex = asSwing(swing(byId(FM, "ex"), FM));
    expect(ex.lo).toBeCloseTo(2.4, 9);
    expect(ex.hi).toBe(5); // 94% caps at 5
    expect(ex.size).toBeCloseTo(2.6, 9);

    const m2 = asSwing(swing(byId(SCA, "m2"), SCA));
    expect(m2.lo).toBeCloseTo(4.825, 9);
    expect(m2.hi).toBe(5);

    // "needs a what-if first"
    expect(swing(byId(DSD, "sb"), DSD)).toBeNull();
  });

  it("give the prototype's overall: the mean of the three courses with graded work", () => {
    expect(overall([FM, SIT, SCA, DSD].map((items) => ({ items })))).toBeCloseTo(4.5, 9);
  });
});

describe("soFar and fillFor", () => {
  it("soFar is the weighted average of graded items, null when none", () => {
    expect(soFar(FM)).toBeCloseTo(85, 9);
    expect(soFar(SCA)).toBeCloseTo(95, 9);
    expect(soFar(DSD)).toBeNull();
  });

  it("fillFor prefers the item's what-if, then the average so far", () => {
    expect(fillFor(byId(FM, "a3"), FM, { a3: 60 })).toBe(60);
    expect(fillFor(byId(FM, "a3"), FM, { a4: 60 })).toBeCloseTo(85, 9);
  });

  it("fillFor falls back to the mean of set what-ifs when nothing is graded", () => {
    expect(fillFor(byId(DSD, "fc"), DSD, { sb: 70, x: null })).toBe(70);
    expect(fillFor(byId(DSD, "fc"), DSD, {})).toBeNull();
  });

  it("a what-if makes a too-early course computable", () => {
    expect(trajectory(DSD, { sb: 70 })).toBeCloseTo(3.0, 9); // both items at 70%
    expect(trajectory(DSD, { sb: 50, fc: 100 })).toBeCloseTo(4.0, 9); // 20 + 60 = 80%
    const s = asSwing(swing(byId(DSD, "fc"), DSD, { sb: 80 }));
    expect(s.lo).toBeCloseTo(2.2, 9); // 32 + 30 = 62%
    expect(s.hi).toBeCloseTo(5, 9); // 32 + 60 = 92%
  });

  it("a what-if on a graded item is ignored", () => {
    expect(trajectory(FM, { a1: 0 })).toBeCloseTo(4.5, 9);
  });
});

describe("needed", () => {
  it("is (40 + 10·target − gradedSum) / ungradedWeight", () => {
    expect(needed(FM, 5)).toBeCloseTo(91.25, 9); // (90 − 17) / 0.8
    expect(needed(FM, 3)).toBeCloseTo(66.25, 9); // (70 − 17) / 0.8
    expect(needed(SIT, 1)).toBeCloseTo(42.5, 9); // (50 − 16) / 0.8
  });

  it("is not clamped, and null when nothing is left", () => {
    const lots = [g("a", "A", 0.9, 100), g("b", "B", 0.1, null)];
    expect(needed(lots, 1)).toBeCloseTo(-400, 9);
    expect(needed([g("a", "A", 1, 70)], 3)).toBeNull();
  });
});

describe("verdict kinds", () => {
  it("all_graded when nothing is left", () => {
    expect(verdict([g("a", "A", 0.5, 70), g("b", "B", 0.5, 90)], 5)).toEqual({ kind: "all_graded" });
  });

  it("on when the need is at most the average so far plus 2", () => {
    // so far 80, need (70 − 40) / 0.5 = 60
    expect(verdict([g("a", "A", 0.5, 80), g("b", "B", 0.5, null)], 3)).toEqual({ kind: "on", need: 60 });
    // the edge: so far 80, need exactly 82 is still on; 84 is within
    const edge = [g("a", "A", 0.5, 80), g("b", "B", 0.5, null)];
    expect(verdict(edge, 4.1).kind).toBe("on"); // (81 − 40) / 0.5 = 82
    expect(verdict(edge, 4.2).kind).toBe("within"); // 84
  });

  it("within when the need is at most 100", () => {
    const v = verdict([g("a", "A", 0.5, 60), g("b", "B", 0.5, null)], 4);
    expect(v).toEqual({ kind: "within", need: 100 }); // (80 − 30) / 0.5
  });

  it("out with the best possible grade and what the next grade down needs", () => {
    const v = verdict([g("a", "A", 0.5, 50), g("b", "B", 0.5, null)], 5);
    expect(v.kind).toBe("out");
    if (v.kind !== "out") return;
    expect(v.need).toBeCloseTo(130, 9); // (90 − 25) / 0.5
    expect(v.best).toBeCloseTo(3.5, 9); // 25 + 50 = 75%
    expect(v.nextGrade).toBe(3);
    expect(v.nextGradeNeed).toBeCloseTo(90, 9); // (70 − 25) / 0.5
  });

  it("out with no next grade when even 100% stays under 50%", () => {
    const v = verdict([g("a", "A", 0.7, 0), g("b", "B", 0.3, null)], 1);
    expect(v).toMatchObject({ kind: "out", best: 0, nextGrade: 0, nextGradeNeed: null });
  });

  it("is not changed by what-ifs, as in the prototype", () => {
    expect(verdict(FM, 5, { ex: 0, a3: 0 })).toEqual(verdict(FM, 5));
  });
});

describe("weights", () => {
  it("a missing weight anywhere gives needs_weights", () => {
    const missing = [g("a", "A", 0.5, 80), g("b", "B", null, null)];
    expect(normaliseWeights(missing)).toBe(NEEDS_WEIGHTS);
    expect(soFar(missing)).toBe(NEEDS_WEIGHTS);
    expect(fillFor(missing[1], missing)).toBe(NEEDS_WEIGHTS);
    expect(trajectory(missing)).toBe(NEEDS_WEIGHTS);
    expect(needed(missing, 5)).toBe(NEEDS_WEIGHTS);
    expect(verdict(missing, 5)).toEqual({ kind: "needs_weights" });
    expect(swing(missing[1], missing)).toBe(NEEDS_WEIGHTS);
    expect(mattersMost(missing)).toBe(NEEDS_WEIGHTS);
    expect(chartSeries(missing)).toBe(NEEDS_WEIGHTS);
  });

  it("negative, non-finite or all-zero weights also need weights", () => {
    expect(normaliseWeights([g("a", "A", -0.2, 80), g("b", "B", 1.2, null)])).toBe(NEEDS_WEIGHTS);
    expect(normaliseWeights([g("a", "A", Number.NaN, 80)])).toBe(NEEDS_WEIGHTS);
    expect(normaliseWeights([g("a", "A", 0, 80), g("b", "B", 0, null)])).toBe(NEEDS_WEIGHTS);
    expect(normaliseWeights([])).toBe(NEEDS_WEIGHTS);
  });

  it("weights that do not sum to 1 are scaled so they do", () => {
    const pct = [g("a", "A", 10, 90), g("b", "B", 10, 80), g("c", "C", 80, null)];
    const n = normaliseWeights(pct);
    expect(n).not.toBe(NEEDS_WEIGHTS);
    if (n === NEEDS_WEIGHTS) return;
    expect(n.map((i) => i.weight)).toEqual([0.1, 0.1, 0.8]);
    expect(trajectory(pct)).toBeCloseTo(4.5, 9);
    expect(needed(pct, 5)).toBeCloseTo(91.25, 9);
    expect(verdict(pct, 5)).toMatchObject({ kind: "within" });
  });

  it("weights already summing to 1 are left exactly as given", () => {
    const n = normaliseWeights(FM);
    if (n === NEEDS_WEIGHTS) throw new Error("expected weights");
    expect(n.map((i) => i.weight)).toEqual([0.1, 0.1, 0.1, 0.1, 0.6]);
  });

  it("overall leaves out courses that need weights", () => {
    const missing = [g("a", "A", null, 10)];
    expect(overall([{ items: FM }, { items: missing }])).toBeCloseTo(4.5, 9);
    expect(overall([{ items: DSD }])).toBeNull();
  });

  it("overall uses each course's what-ifs", () => {
    // SIT with exam at 100: 16 + 0.2·80 + 60 = 92% → 5; FM stays 4.5.
    expect(overall([{ items: FM }, { items: SIT, whatIfs: { ex: 100 } }])).toBeCloseTo(4.75, 9);
  });
});

describe("chartSeries", () => {
  it("draws the running grade, the projection and the 50-100% band (FM)", () => {
    const s = asSeries(chartSeries(FM));
    expect(s.running.map((p) => p.index)).toEqual([0, 1]);
    expect(s.running[0].grade).toBeCloseTo(5, 9); // 90%
    expect(s.running[1].grade).toBeCloseTo(4.5, 9); // 85%
    // projection starts at the last graded point and runs at the 85% fill
    expect(s.projection.map((p) => p.index)).toEqual([1, 2, 3, 4]);
    s.projection.forEach((p) => expect(p.grade).toBeCloseTo(4.5, 9));
    expect(s.end).toBeCloseTo(4.5, 9);
    expect(s.empty).toBe(false);
    // band from the last graded item to the end
    expect(s.band.map((b) => b.index)).toEqual([1, 2, 3, 4]);
    expect(s.band[0].lo).toBeCloseTo(4.5, 9);
    expect(s.band[0].hi).toBeCloseTo(4.5, 9);
    expect(s.band[1].lo).toBeCloseTo(gradeAt((17 + 5) / 0.3), 9); // 73.3%
    expect(s.band[1].hi).toBeCloseTo(gradeAt((17 + 10) / 0.3), 9); // 90%
    expect(s.band[3].lo).toBeCloseTo(1.7, 9); // 57%
    expect(s.band[3].hi).toBe(5); // 97%
  });

  it("the projection ends on the trajectory", () => {
    for (const items of [FM, SIT, SCA]) {
      expect(asSeries(chartSeries(items)).end).toBeCloseTo(trajectory(items) as number, 9);
    }
  });

  it("is empty for a too-early course, but still has the band from the first item", () => {
    const s = asSeries(chartSeries(DSD));
    expect(s.running).toEqual([]);
    expect(s.projection).toEqual([]);
    expect(s.end).toBeNull();
    expect(s.empty).toBe(true);
    expect(s.band).toEqual([
      { index: 0, lo: 1, hi: 5 },
      { index: 1, lo: 1, hi: 5 },
    ]);
  });

  it("a what-if gives a too-early course a projection", () => {
    const s = asSeries(chartSeries(DSD, { sb: 70 }));
    expect(s.empty).toBe(false);
    expect(s.projection.map((p) => p.index)).toEqual([0, 1]);
    expect(s.end).toBeCloseTo(3, 9);
  });

  it("has no projection when everything is graded", () => {
    const s = asSeries(chartSeries([g("a", "A", 0.5, 70), g("b", "B", 0.5, 90)]));
    expect(s.running.map((p) => p.grade)).toEqual([3, 4]);
    expect(s.projection).toEqual([]);
    expect(s.end).toBeNull();
    expect(s.band).toEqual([{ index: 1, lo: 4, hi: 4 }]);
  });
});

function gradeAt(p: number) {
  return p < 50 ? 0 : Math.min(5, (p - 40) / 10);
}
