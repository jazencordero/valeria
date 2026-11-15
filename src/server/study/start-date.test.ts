import { describe, expect, it } from "vitest";
import { helsinkiDay, newCardsAllowed } from "./start-date";

describe("newCardsAllowed", () => {
  const exam = { startNewOn: "2026-11-24" };

  it("is true when the exam has no start day", () => {
    expect(newCardsAllowed({ startNewOn: null }, new Date("2026-11-15T10:00:00Z"))).toBe(true);
    expect(newCardsAllowed({}, new Date("2026-11-15T10:00:00Z"))).toBe(true);
  });

  it("is false before the start day and true on it and after", () => {
    expect(newCardsAllowed(exam, new Date("2026-11-15T10:00:00Z"))).toBe(false);
    expect(newCardsAllowed(exam, new Date("2026-11-24T10:00:00Z"))).toBe(true);
    expect(newCardsAllowed(exam, new Date("2026-12-01T10:00:00Z"))).toBe(true);
  });

  it("turns at midnight in Helsinki, not in UTC", () => {
    // Helsinki is UTC+2 in November: the 24th starts at 22:00 UTC on the 23rd.
    expect(newCardsAllowed(exam, new Date("2026-11-23T21:59:59Z"))).toBe(false);
    expect(newCardsAllowed(exam, new Date("2026-11-23T22:00:00Z"))).toBe(true);
    // And UTC+3 in summer: the day starts at 21:00 UTC.
    const summer = { startNewOn: "2027-06-01" };
    expect(newCardsAllowed(summer, new Date("2027-05-31T20:59:59Z"))).toBe(false);
    expect(newCardsAllowed(summer, new Date("2027-05-31T21:00:00Z"))).toBe(true);
  });

  it("names the Helsinki day of an instant", () => {
    expect(helsinkiDay(new Date("2026-11-23T22:00:00Z"))).toBe("2026-11-24");
    expect(helsinkiDay(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
  });
});
