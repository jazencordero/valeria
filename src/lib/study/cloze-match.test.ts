import { describe, expect, it } from "vitest";
import { matchBlank, matchCloze, normaliseAnswer } from "./cloze-match";

describe("normaliseAnswer", () => {
  it("lower-cases, trims and collapses whitespace", () => {
    expect(normaliseAnswer("  Opportunity   COST \n")).toBe("opportunity cost");
  });

  it("strips a trailing period, surrounding quotes and a wrapping pair", () => {
    expect(normaliseAnswer("Elasticity.")).toBe("elasticity");
    expect(normaliseAnswer("“elasticity”")).toBe("elasticity");
    expect(normaliseAnswer('"elasticity."')).toBe("elasticity");
    expect(normaliseAnswer("(elasticity)")).toBe("elasticity");
    expect(normaliseAnswer("'elasticity'")).toBe("elasticity");
  });

  it("keeps punctuation that changes meaning", () => {
    expect(normaliseAnswer(".5")).toBe(".5");
    expect(normaliseAnswer("-5")).toBe("-5");
    expect(normaliseAnswer("3.5")).toBe("3.5");
    expect(normaliseAnswer("50%")).toBe("50%");
  });

  it("writes superscripts as ^ before NFKC, so x² is x^2 but not x2", () => {
    expect(normaliseAnswer("x²")).toBe("x^2");
    expect(normaliseAnswer("x^2")).toBe("x^2");
    expect(normaliseAnswer("x2")).toBe("x2");
    expect(normaliseAnswer("x⁻¹")).toBe("x^-1");
    expect(normaliseAnswer("10²")).not.toBe(normaliseAnswer("102"));
  });

  it("applies NFKC to full-width letters and subscripts", () => {
    expect(normaliseAnswer("ＡＢＣ")).toBe("abc");
    expect(normaliseAnswer("CO₂")).toBe("co2");
  });

  it("keeps ä and ö distinct from a and o, composed or not", () => {
    expect(normaliseAnswer("Pää")).toBe("pää");
    expect(normaliseAnswer("pää")).toBe("pää");
    expect(normaliseAnswer("pää")).not.toBe(normaliseAnswer("paa"));
    expect(normaliseAnswer("Töö")).not.toBe(normaliseAnswer("too"));
  });
});

describe("matchBlank", () => {
  it("matches the answer after normalising", () => {
    expect(matchBlank("  Marginal Cost. ", "marginal cost")).toBe(true);
    expect(matchBlank("marginal costs", "marginal cost")).toBe(false);
  });

  it("matches any accepted variant", () => {
    const accept = ["²", "^2", "to the power 2"];
    expect(matchBlank("squared", "squared", accept)).toBe(true);
    expect(matchBlank("²", "squared", accept)).toBe(true);
    expect(matchBlank("^2", "squared", accept)).toBe(true);
    expect(matchBlank("To the power 2.", "squared", accept)).toBe(true);
    expect(matchBlank("cubed", "squared", accept)).toBe(false);
  });

  it("x² and x^2 match each other; x2 only when accepted", () => {
    expect(matchBlank("x^2", "x²")).toBe(true);
    expect(matchBlank("x²", "x^2")).toBe(true);
    expect(matchBlank("x2", "x²")).toBe(false);
    expect(matchBlank("x2", "x²", ["x2"])).toBe(true);
  });

  it("is not fuzzy: no typos, no dropped letters, no dropped umlauts", () => {
    expect(matchBlank("elastisity", "elasticity")).toBe(false);
    expect(matchBlank("kysynta", "kysyntä")).toBe(false);
    expect(matchBlank("KYSYNTÄ", "kysyntä")).toBe(true);
    expect(matchBlank("tarjonta", "kysyntä", ["kysynnän"])).toBe(false);
  });

  it("an empty answer never matches", () => {
    expect(matchBlank("", "zero", [""])).toBe(false);
    expect(matchBlank("  .  ", "zero")).toBe(false);
  });
});

describe("matchCloze", () => {
  const card = {
    q: "When the sample is {{ large }}, the error goes to {{zero}}.",
    accept: { large: ["big"], zero: ["0"] },
  };

  it("gives one result per blank, using that blank's variants", () => {
    expect(matchCloze(["Big", "0"], card)).toEqual([true, true]);
    expect(matchCloze(["large", "nothing"], card)).toEqual([true, false]);
    expect(matchCloze(["0", "big"], card)).toEqual([false, false]);
  });

  it("counts a missing input as wrong and works without accept", () => {
    expect(matchCloze(["large"], card)).toEqual([true, false]);
    expect(matchCloze(["zero"], { q: "Nothing is {{zero}}." })).toEqual([true]);
  });
});
