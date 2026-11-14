import { describe, expect, it } from "vitest";
import { guessProgramme, sortingScript, type SortingStep } from "./script";

const ISM = "Information and Service Management";
const says = (steps: SortingStep[]) =>
  steps.flatMap((s) => (s.kind === "say" ? [s.text] : []));

describe("sortingScript", () => {
  it("says 'an Aalto' for Aalto", () => {
    const { steps } = sortingScript({ school: "aalto", programme: ISM, calm: false });
    expect(says(steps)[0]).toBe("So you're an Aalto baddie, huh.");
  });

  it("says 'a LUT' for LUT", () => {
    const { steps } = sortingScript({ school: "lut", programme: ISM, calm: false });
    expect(says(steps)[0]).toBe("So you're a LUT baddie, huh.");
  });

  it("says every line in the prototype's order, programme included", () => {
    const { steps } = sortingScript({ school: "aalto", programme: ISM, calm: false });
    expect(says(steps)).toEqual([
      "So you're an Aalto baddie, huh.",
      "Hmm. Smart.",
      "A little stuck up.",
      "Information and Service Management. Of course.",
      "Let me think…",
      "A bad bitch. A tad stuck up. You overworry about deadlines you always make.",
    ]);
    expect(steps.at(-1)).toEqual({ kind: "wipeText", text: "Here's your study OS, all set up.", ms: 200 });
  });

  it("skips the programme line when the programme is unknown", () => {
    for (const programme of [null, "", "  "]) {
      const lines = says(sortingScript({ school: "aalto", programme, calm: false }).steps);
      expect(lines).toHaveLength(5);
      expect(lines.some((t) => t.endsWith("Of course."))).toBe(false);
    }
  });

  it("holds 500 ms after each opening line, 900 ms when calm", () => {
    const holds = (calm: boolean) =>
      sortingScript({ school: "aalto", programme: ISM, calm })
        .steps.filter((s) => s.kind === "say")
        .map((s) => s.ms);
    expect(holds(false)).toEqual([500, 500, 500, 500, 0, 1100]);
    expect(holds(true)).toEqual([900, 900, 900, 900, 0, 1600]);
  });

  it("flickers SLYTHERIN and RAVENCLAW 10 times at 120 ms, landing on RAVENCLAW.", () => {
    const { steps } = sortingScript({ school: "aalto", programme: ISM, calm: false });
    const flicker = steps.filter((s) => s.kind === "flicker");
    expect(flicker).toHaveLength(10);
    expect(flicker.every((s) => s.ms === 120)).toBe(true);
    expect(flicker.map((s) => s.text)).toEqual([
      "SLYTHERIN", "RAVENCLAW", "SLYTHERIN", "RAVENCLAW", "SLYTHERIN",
      "RAVENCLAW", "SLYTHERIN", "RAVENCLAW", "SLYTHERIN", "RAVENCLAW",
    ]);
    const after = steps[steps.indexOf(flicker[9]) + 1];
    expect(after).toEqual({ kind: "house", text: "RAVENCLAW.", animMs: 400, ms: 900 });
  });

  it("drops the flicker when calm and fades the house in", () => {
    const { steps } = sortingScript({ school: "aalto", programme: ISM, calm: true });
    expect(steps.some((s) => s.kind === "flicker")).toBe(false);
    expect(steps.find((s) => s.kind === "house")).toEqual({
      kind: "house", text: "RAVENCLAW.", animMs: 150, ms: 1050,
    });
  });

  it("adds up the total length", () => {
    // 900 lead-in + 4×500 holds + 10×120 flicker + 900 land + 1100 + 900 confetti + 700 + 200
    expect(sortingScript({ school: "aalto", programme: ISM, calm: false }).totalMs).toBe(7900);
    // without the programme line: one hold fewer
    expect(sortingScript({ school: "aalto", programme: null, calm: false }).totalMs).toBe(7400);
    // calm: 200 + 4×900 + 1050 + 1600 + 0 + 700 + 200
    expect(sortingScript({ school: "aalto", programme: ISM, calm: true }).totalMs).toBe(7350);
  });

  it("never runs under 6 seconds", () => {
    for (const calm of [false, true]) {
      for (const programme of [ISM, null]) {
        const s = sortingScript({ school: "lut", programme, calm });
        expect(s.minimumMs).toBe(Math.max(6000, s.totalMs));
        expect(s.minimumMs).toBeGreaterThanOrEqual(6000);
      }
    }
  });
});

describe("guessProgramme", () => {
  it("maps the commonest prefix through the table", () => {
    expect(
      guessProgramme([{ code: "ISM-E9001" }, { code: "ism9002" }, { code: "TU-X9003" }]),
    ).toBe(ISM);
  });

  it("answers null when the commonest prefix is not in the table", () => {
    expect(guessProgramme([{ code: "ZZQ-1" }, { code: "ZZQ-2" }, { code: "ISM-3" }])).toBeNull();
  });

  it("answers null on a tie", () => {
    expect(guessProgramme([{ code: "ISM-1" }, { code: "ZZQ-2" }])).toBeNull();
  });

  it("answers null with no usable codes", () => {
    expect(guessProgramme([])).toBeNull();
    expect(guessProgramme([{ code: null }, { code: "" }, { code: "1234" }])).toBeNull();
  });
});
