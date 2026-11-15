import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GradePage } from "./grade-page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, back: () => {}, prefetch: () => {} }) }));

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Invented course: an exam and exercises, weights known, nothing graded.
const ITEMS = [
  { id: "ex", name: "Invented exam", short: "Exam", weight: 0.73, score: null },
  { id: "hw", name: "Invented exercises", short: "Exercises", weight: 0.27, score: null },
];
const props = {
  course: { id: "c1", name: "Invented course", code: "TST-E0001", color: "butter" as const, target: 5 as const },
  items: ITEMS,
  needsWeights: false,
  lmsName: "Invented LMS",
  saveTarget: async () => ({ ok: true as const }),
  saveWeights: async () => ({ ok: true as const }),
};

describe("GradePage for a course marked in points (weights only)", () => {
  it("shows the weights and works nothing out", () => {
    render(<GradePage {...props} weightsOnly />);
    expect(screen.getByText("Invented exam")).toBeDefined();
    expect(screen.getByText("73%")).toBeDefined();
    expect(screen.getByText("27%")).toBeDefined();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/you need about/i);
    expect(text).not.toMatch(/within reach|on track|out of reach/i);
    expect(text).toContain("Ready does not work out a grade for it yet");
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("still says what she needs on a course in percent", () => {
    render(<GradePage {...props} />);
    expect(document.body.textContent ?? "").toMatch(/you need about/i);
  });
});
