import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDone, type SessionDoneProps } from "./done";
import { freeSkipsLeft, weekOf, weeksInARow } from "@/lib/study/week";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, back: () => {}, prefetch: () => {} }) }));

beforeEach(() => {
  // jsdom has no Web Animations.
  (Element.prototype as unknown as { getAnimations: () => [] }).getAnimations ??= () => [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduce"), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = new Date("2026-11-16T12:00:00Z");
const days = ["2026-11-16T10:00:00Z"];
const props: Omit<SessionDoneProps, "focusTitle"> = {
  result: { cards: 7, seconds: 85, best: 3, perfect: false, climbs: [], reviews: [] },
  mode: "bite",
  examShort: "Invented course",
  forecastBefore: 3,
  forecastAfter: 4,
  // 85% is a 4 on the generic scale; this exam's own target is a 5.
  target: 85,
  targetGrade: 5,
  planEnd: 42.5,
  examDay: "Mon 23 Nov",
  concepts: {},
  week: weekOf(days, 4, NOW),
  weeksInARow: weeksInARow(days, 4, NOW),
  freeSkipsLeft: freeSkipsLeft(days, 4, NOW),
  dayNew: true,
  goalNew: false,
  nextBiteMinutes: 4,
  backLabel: "Back to the exam",
};

describe("SessionDone forecast", () => {
  it("names the exam's own target grade, a whole percent and the exam's date", () => {
    render(<SessionDone {...props} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("A 5");
    expect(text).not.toContain("A 4");
    expect(text).toContain("Keep a bite a day and you land around 43% on Mon 23 Nov.");
  });

  it("says Target when the exam has no grade target", () => {
    render(<SessionDone {...props} targetGrade={null} />);
    expect(screen.getByText("Target")).toBeDefined();
    expect(document.body.textContent ?? "").not.toMatch(/\bA [0-5]\b/);
  });
});
