import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExamTabCard } from "./exam-tab-card";

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

// Made-up exam with many concepts, as a real deck can have dozens.
const concepts = Array.from({ length: 48 }, (_, i) => ({ id: `c${i}`, name: `Concept ${i}`, rung: i % 6 }));

describe("ExamTabCard", () => {
  it("wraps the concept dots so a big deck cannot push the card past the screen", () => {
    render(
      <ExamTabCard
        href="#exam"
        phase="Strengthen"
        title="Sample exam"
        course="Sample course"
        when="MON 23 NOV · 09:00 · in 8 days"
        forecast={0}
        spark={{ history: [], forecast: 0, daysLeft: 8 }}
        target={80}
        concepts={concepts}
        counts={{ new: 40, learning: 0, due: 0 }}
      />,
    );
    const dots = screen.getByTestId("concept-dots");
    expect(dots.className).toContain("flex-wrap");
    expect(dots.textContent).toContain("48 concepts");
  });

  it("before the study start, says only when it starts: no forecast, dots or counts", () => {
    render(
      <ExamTabCard
        href="#exam"
        phase="Learn"
        title="Sample exam"
        course="Sample course"
        when="THU 3 DEC · 09:00 · in 18 days"
        forecast={0}
        spark={{ history: [], forecast: 0, daysLeft: 18 }}
        target={80}
        concepts={concepts}
        counts={{ new: 40, learning: 0, due: 0 }}
        starts="Tue 24 Nov"
      />,
    );
    expect(screen.getByTestId("starts").textContent).toBe("Starts Tue 24 Nov. Nothing to do here until then.");
    expect(screen.queryByTestId("concept-dots")).toBeNull();
    expect(document.body.textContent).not.toMatch(/forecast|%|due|new/);
  });
});
