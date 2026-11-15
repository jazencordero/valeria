import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExamCard, type ExamCardProps } from "./exam-card";

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// A made-up exam.
const base: ExamCardProps = {
  kind: "exam",
  title: "Sample exam",
  course: "Sample course",
  when: "MON 23 NOV · 09:00 · in 8 days",
  forecast: 40,
  spark: { history: [], forecast: 40, daysLeft: 8 },
  target: 62,
  grade: 4,
  verdict: { text: "On track with a bite a day", ok: true },
  concepts: [{ id: "c1", name: "Concept 1", rung: 1 }],
  biteMinutes: 5,
};

describe("ExamCard", () => {
  it("names the grade it is given beside the target percent", () => {
    render(<ExamCard {...base} />);
    expect(screen.getByText("If it were today. A 4 needs 62%.")).toBeTruthy();
  });

  it("with no grade, shows the target percent alone", () => {
    render(<ExamCard {...base} grade={null} />);
    expect(screen.getByText("If it were today. The target is 62%.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/needs/);
  });
});
