import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForecastChart } from "./forecast-chart";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ForecastChart with the exam's plan", () => {
  it("speaks the plan's pace and end, and puts none of the plan on the DOM", () => {
    render(
      <ForecastChart
        history={[]}
        forecast={1}
        daysLeft={8}
        target={85}
        targetGrade={5}
        examDay="NOV 23"
        plan={[1, 14, 27, 40, 53, 66, 79, 88, 94]}
        planEndShown={94}
        planName="7 bites a day"
      />,
    );
    const chart = screen.getByRole("img");
    expect(chart.getAttribute("aria-label")).toContain("With 7 bites a day, about 94% on exam day.");
    for (const a of ["plan", "planendshown", "planname"]) expect(chart.hasAttribute(a)).toBe(false);
  });
});
