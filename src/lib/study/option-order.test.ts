import { describe, expect, it } from "vitest";
import { isAnchored, refersByLetter, shownOptions, type Option } from "./option-order";

const four: Option[] = [
  ["Right one", true],
  ["Wrong one", false],
  ["Wrong two", false],
  ["Wrong three", false],
];
const rightSlot = (opts: readonly Option[]) => opts.findIndex((o) => o[1]);

describe("shownOptions", () => {
  it("puts the right option in every position about equally over many seeds", () => {
    for (const opts of [four, four.slice(0, 3), four.slice(0, 2)]) {
      const counts = new Array(opts.length).fill(0);
      const N = 4000;
      for (let s = 0; s < N; s++) counts[rightSlot(shownOptions(opts, `card-${s % 97}:session-${s}`))]++;
      for (const c of counts) expect(Math.abs(c / N - 1 / opts.length)).toBeLessThan(0.03);
    }
  });

  it("is stable for one seed, differs across seeds, and keeps every option once", () => {
    const a = shownOptions(four, "card-1:session-1");
    expect(shownOptions(four, "card-1:session-1")).toEqual(a);
    expect([...a].sort()).toEqual([...four].sort());
    const orders = new Set(Array.from({ length: 30 }, (_, s) => JSON.stringify(shownOptions(four, `card-1:session-${s}`))));
    expect(orders.size).toBeGreaterThan(5);
    // The input is not mutated.
    expect(four[0]).toEqual(["Right one", true]);
  });

  it("keeps 'all of the above' and the like in their slot", () => {
    for (const last of ["All of the above", "None of the above", "Both of these", "Neither of the above", "all of these"]) {
      const opts: Option[] = [["First", false], ["Second", false], ["Third", false], [last, true]];
      for (let s = 0; s < 50; s++) expect(shownOptions(opts, `seed-${s}`)[3]).toEqual([last, true]);
      expect(isAnchored(last)).toBe(true);
    }
    // The others still move, so the right answer is not given away elsewhere.
    const opts: Option[] = [["Right", true], ["Two", false], ["Three", false], ["None of the above", false]];
    const slots = new Set(Array.from({ length: 60 }, (_, s) => rightSlot(shownOptions(opts, `s${s}`))));
    expect(slots).toEqual(new Set([0, 1, 2]));
  });

  it("keeps the file order when an option names another by letter", () => {
    for (const ref of ["Both A and B", "A and C", "Only B", "Options A or D", "B, C"]) {
      const opts: Option[] = [["Right", true], ["Two", false], ["Three", false], [ref, false]];
      expect(refersByLetter(opts)).toBe(true);
      for (let s = 0; s < 20; s++) expect(shownOptions(opts, `s${s}`)).toEqual(opts);
    }
  });

  it("does not take ordinary words for letter references", () => {
    expect(refersByLetter([["A model learns from data", true], ["Data is a table", false], ["It uses a test set", false]])).toBe(false);
  });
});
