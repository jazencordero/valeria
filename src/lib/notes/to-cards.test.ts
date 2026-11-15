import { describe, expect, it } from "vitest";
import { addLabel, MAX_CARDS, noteLines, splitLine, toCards, usableCards } from "./to-cards";

describe("toCards", () => {
  it("splits 'front: back' on the first colon", () => {
    expect(splitLine("Outsourcing: buying a service: from outside")).toEqual({
      front: "Outsourcing",
      back: "buying a service: from outside",
    });
  });

  it("splits 'front - back' on ' - '", () => {
    expect(splitLine("SLA - the promised service level - in writing")).toEqual({
      front: "SLA",
      back: "the promised service level - in writing",
    });
  });

  it("the colon wins over ' - '", () => {
    expect(splitLine("TCO - cost: all of it")).toEqual({ front: "TCO - cost", back: "all of it" });
  });

  it("otherwise asks her to explain the line", () => {
    expect(splitLine("Vendor lock-in raises switching costs")).toEqual({
      front: "Explain: Vendor lock-in raises switching costs",
      back: "Vendor lock-in raises switching costs",
    });
  });

  it("a colon or ' - ' at the very start does not split", () => {
    expect(splitLine(":odd")).toEqual({ front: "Explain: :odd", back: ":odd" });
    expect(splitLine(" - odd".trim())).toEqual({ front: "Explain: - odd", back: "- odd" });
  });

  it("strips list marks and trims", () => {
    expect(noteLines("- one\n  • two\n* three")).toEqual(["one", "two", "three"]);
    expect(toCards("-   SLA: service level")).toEqual([{ front: "SLA", back: "service level" }]);
  });

  it("a hyphen without a space is not a list mark", () => {
    expect(noteLines("-5 degrees")).toEqual(["-5 degrees"]);
  });

  it("drops empty lines", () => {
    expect(noteLines("\n\n one \n   \n- \ntwo\n")).toEqual(["one", "two"]);
    expect(toCards("   \n\n")).toEqual([]);
  });

  it("keeps at most 3 lines, the first three", () => {
    const cards = toCards("a: 1\nb: 2\n\nc: 3\nd: 4\ne: 5");
    expect(cards).toHaveLength(MAX_CARDS);
    expect(cards.map((c) => c.front)).toEqual(["a", "b", "c"]);
  });

  it("a colon at the end leaves the back empty", () => {
    expect(splitLine("Heading:")).toEqual({ front: "Heading", back: "" });
  });
});

describe("usableCards", () => {
  it("skips rows with an empty front, or an empty back, and trims", () => {
    expect(
      usableCards([
        { front: "  ", back: "kept?" },
        { front: " SLA ", back: " level " },
        { front: "Heading", back: "" },
      ]),
    ).toEqual([{ front: "SLA", back: "level" }]);
  });

  it("never more than 3", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ front: `f${i}`, back: `b${i}` }));
    expect(usableCards(rows)).toHaveLength(3);
  });
});

describe("addLabel", () => {
  it("says the real count", () => {
    expect(addLabel(3)).toBe("Add 3 cards");
    expect(addLabel(1)).toBe("Add 1 card");
  });
});
