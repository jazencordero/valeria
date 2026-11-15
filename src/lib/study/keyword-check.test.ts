import { describe, expect, it } from "vitest";
import type { RubricPoint } from "./card-schema";
import { keywordCheck, normalise } from "./keyword-check";

// The prototype's first explain card (main-flow.html, line 2527), plus one more point.
const RUBRIC: RubricPoint[] = [
  ["Business strategy shapes IT choices", ["business strategy", "drive", "shape", "support"]],
  ["It is strategic or a source of advantage", ["strateg", "advantage", "core", "differentiat"]],
  ["Costs are cut", ["cost cutting", "säästö"]],
];
const LABELS = RUBRIC.map(([label]) => label);

describe("normalise", () => {
  it("lowers case, drops accents and turns punctuation into single spaces", () => {
    expect(normalise("  Säästö, Café — COST-cutting!  ")).toBe("saasto cafe cost cutting");
  });

  it("keeps letters and digits of any script", () => {
    expect(normalise("Ω-3 omega")).toBe("ω 3 omega");
  });

  it("is empty for text with no letters or digits", () => {
    expect(normalise(" ... !? ")).toBe("");
  });
});

describe("keywordCheck", () => {
  it("counts a point as had when one of its keywords appears", () => {
    expect(keywordCheck(RUBRIC, "IT has to support what the business does.")).toEqual({
      had: [LABELS[0]],
      missing: [LABELS[1], LABELS[2]],
    });
  });

  it("matches keyword stems inside longer words, as the prototype does", () => {
    expect(keywordCheck(RUBRIC, "It differentiates the firm.").had).toEqual([LABELS[1]]);
  });

  it("ignores case, accents and punctuation on both sides", () => {
    expect(keywordCheck(RUBRIC, "IT must SUPPORT it; then COST, cutting...").had).toEqual([LABELS[0], LABELS[2]]);
    expect(keywordCheck(RUBRIC, "saasto").had).toEqual([LABELS[2]]);
  });

  it("does not match across a word that is not there", () => {
    expect(keywordCheck(RUBRIC, "the business has a strategy").had).toEqual([LABELS[1]]);
  });

  it("puts every label in exactly one list, in rubric order", () => {
    const result = keywordCheck(RUBRIC, "core advantage");
    expect(result).toEqual({ had: [LABELS[1]], missing: [LABELS[0], LABELS[2]] });
    expect([...result.had, ...result.missing].sort()).toEqual([...LABELS].sort());
  });

  it("has nothing for empty text or text with only punctuation", () => {
    expect(keywordCheck(RUBRIC, "")).toEqual({ had: [], missing: LABELS });
    expect(keywordCheck(RUBRIC, "   ?!  ")).toEqual({ had: [], missing: LABELS });
  });

  it("lists a repeated label once, had when either point matches", () => {
    const rubric: RubricPoint[] = [
      ["Same", ["alpha"]],
      ["Same", ["beta"]],
      ["Other", ["gamma"]],
    ];
    expect(keywordCheck(rubric, "beta")).toEqual({ had: ["Same"], missing: ["Other"] });
  });

  it("skips a keyword that is empty after normalising", () => {
    expect(keywordCheck([["Dots", ["..."]]], "anything at all")).toEqual({ had: [], missing: ["Dots"] });
  });
});
