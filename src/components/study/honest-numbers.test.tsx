import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BiteRow } from "@/components/home/bite-row";
import { BiteCard } from "./bite-card";
import { forecastChartLabel, forecastChartLayout, type ForecastChartData } from "./forecast-chart";
import { GainMost } from "./gain-most";
import { ProgressHead } from "./progress-head";

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

const chart: ForecastChartData = { history: [8, 9], forecast: 11, daysLeft: 3, target: 85, examDay: "NOV 23" };

describe("the gain on a bite", () => {
  it("the exam page shows the measured gain to one decimal", () => {
    render(<BiteCard state="bite" minutes={5} cards={8} gain={0.74} focus="Sample concept" />);
    expect(screen.getByTestId("gain-chip").textContent).toBe("+0.7%forecast");
  });

  it("the exam page leaves the chip out under half a point", () => {
    render(<BiteCard state="bite" minutes={5} cards={8} gain={0.3} focus="Sample concept" />);
    expect(screen.queryByTestId("gain-chip")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\+\d|forecast/);
  });

  it("Home's row says the measured gain, or the cards alone", () => {
    const { rerender } = render(<BiteRow state="bite" minutes={5} cards={8} gain={1.26} forWhat="Monday’s exam" href="/study/new" />);
    expect(document.body.textContent).toContain("8 CARDS · +1.3% FORECAST");
    rerender(<BiteRow state="bite" minutes={5} cards={8} gain={0.2} forWhat="Monday’s exam" href="/study/new" />);
    expect(document.body.textContent).toContain("8 CARDS");
    expect(document.body.textContent).not.toContain("FORECAST");
  });
});

describe("the pace line", () => {
  it("is shown on the bite card instead of the 'Then: bite 2 of 2' line", () => {
    render(
      <BiteCard
        state="bite"
        minutes={5}
        cards={8}
        gain={0.7}
        focus="Sample concept"
        next={{ number: 2, of: 2, minutes: 5 }}
        pace="3 bites today keeps you on track for Monday."
      />,
    );
    expect(screen.getByTestId("bite-pace").textContent).toBe("3 bites today keeps you on track for Monday.");
    expect(document.body.textContent).not.toContain("Then: bite");
  });

  it("is shown under Home's row", () => {
    render(<BiteRow state="bite" minutes={5} cards={8} gain={0.7} forWhat="Monday’s exam" href="/study/new" pace="3 bites today keeps you on track for Monday" />);
    expect(document.body.textContent).toContain("3 bites today keeps you on track for Monday");
  });
});

describe("the plan sentence and the chart", () => {
  it("the Progress head says the page's plan sentence, not a bite a day of its own", () => {
    render(
      <ProgressHead
        forecast={11}
        grade={0}
        planEnd={47}
        dayName="Monday"
        planLine="Two bites a day gets you to about 62% by Monday."
        chart={chart}
        shown={false}
      />,
    );
    expect(document.body.textContent).toContain("Two bites a day gets you to about 62% by Monday.");
    expect(document.body.textContent).not.toMatch(/A bite a day/i);
  });

  it("the chart draws the plan it is given and names its pace", () => {
    const plan = [11, 30, 48, 62];
    const g = forecastChartLayout({ ...chart, plan, planName: "two bites a day" }, 360);
    expect(g.planEndPct).toBe(62);
    expect(g.planEnd.label).toBe("62%");
    expect(forecastChartLabel({ ...chart, plan, planName: "two bites a day" })).toContain("With two bites a day, about 62% on exam day.");
    expect(forecastChartLabel({ ...chart, plan, planName: "the plan" })).toContain("With the plan, about 62% on exam day.");
    // One rounded number: the chart's end label is the plan's `endShown`, the number the sentence says.
    const deckPlan = { curve: [11, 30.2, 47.6, 61.5], endShown: 62 };
    expect(forecastChartLayout({ ...chart, plan: deckPlan.curve, planEndShown: deckPlan.endShown }, 360).planEnd.label).toBe("62%");
    expect(forecastChartLabel({ ...chart, plan: [11, 30, 47, 61.5], planEndShown: 62 })).toContain("about 62% on exam day");
    // A plan that does not fit the days left is not drawn as if it did.
    expect(forecastChartLayout({ ...chart, plan: [11, 62] }, 360).planEndPct).not.toBe(62);
  });
});

describe("a concept's percent", () => {
  it("is labelled as today's level", () => {
    render(<GainMost concepts={[{ id: "c1", name: "Sample concept", weight: 1, mastery: 0.2 }]} />);
    expect(document.body.textContent).toContain("20% now");
    expect(document.body.textContent).not.toContain("on exam day");
  });
});
