import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BiteRow, biteTitle } from "@/components/home/bite-row";
import { PhaseStrip } from "./phase-strip";
import { StudyDays } from "./study-days";
import { weekOf } from "@/lib/study/week";
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

  it("offers the plan in one go beside Start only when asked", async () => {
    const onStart = vi.fn();
    const onLong = vi.fn();
    const line = "About 25 minutes today keeps you on track for Mon 23 Nov (7 bites).";
    const { rerender } = render(<BiteCard state="bite" minutes={3} cards={9} gain={0.7} focus="Sample concept" pace={line} onStart={onStart} onLong={onLong} />);
    expect(screen.getByTestId("bite-pace").textContent).toBe(line);
    screen.getByRole("button", { name: "Do them in one go" }).click();
    screen.getByRole("button", { name: "Start bite" }).click();
    expect(onLong).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledTimes(1);
    rerender(<BiteCard state="bite" minutes={3} cards={9} gain={0.7} focus="Sample concept" pace="3 bites today keeps you on track for Monday." onStart={onStart} />);
    expect(screen.queryByRole("button", { name: "Do them in one go" })).toBeNull();
  });

  it("Home's row has a second link for one go, never nested in the first", () => {
    const row = { state: "bite" as const, minutes: 3, cards: 9, gain: 0.7, forWhat: "Monday’s exam", href: "/study/new?exam=e&kind=bite" };
    const { rerender } = render(<BiteRow {...row} pace="About 25 minutes today keeps you on track for Mon 23 Nov (7 bites)" longHref="/study/new?exam=e&kind=long" />);
    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/study/new?exam=e&kind=bite", "/study/new?exam=e&kind=long"]);
    expect(links[1].textContent).toBe("Do them in one go");
    expect(links[0].textContent).toBe("Or a 3-minute bite for Monday’s exam");
    expect(links[0].contains(links[1])).toBe(false);
    expect(document.body.textContent).toContain("About 25 minutes today keeps you on track for Mon 23 Nov (7 bites)");
    expect(document.body.textContent).toContain("9 CARDS · +0.7% FORECAST");
    rerender(<BiteRow {...row} pace="3 bites today keeps you on track for Monday" />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("Do them in one go");
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

describe("small true things", () => {
  it("Home says one more bite once a bite is done today, like the Today tab", () => {
    expect(biteTitle(5, "Monday’s exam")).toBe("Or a 5-minute bite for Monday’s exam");
    expect(biteTitle(5, "Monday’s exam", true)).toBe("A 5-minute bite for Monday’s exam");
    expect(biteTitle(5, "Monday’s exam", false, true)).toBe("Or one more 5-minute bite for Monday’s exam");
    expect(biteTitle(5, "Monday’s exam", true, true)).toBe("One more 5-minute bite for Monday’s exam");
    render(<BiteRow state="bite" minutes={5} cards={8} gain={0.7} forWhat="Monday’s exam" href="/study/new" more />);
    expect(document.body.textContent).toContain("Or one more 5-minute bite for Monday’s exam");
  });

  it("the phase sentence says 'Nothing new' on exam day only where that is true", () => {
    const { rerender } = render(<PhaseStrip daysLeft={0} />);
    expect(document.body.textContent).toContain("A 10-card warm-up. Nothing new.");
    rerender(<PhaseStrip daysLeft={0} nothingNewOnExamDay={false} />);
    expect(document.body.textContent).toContain("A short warm-up.");
    expect(document.body.textContent).not.toContain("Nothing new");
    // Other phases are the same either way.
    rerender(<PhaseStrip daysLeft={8} nothingNewOnExamDay={false} />);
    expect(document.body.textContent).toContain("More reviews and exam-style questions.");
  });

  it("the streak line is left out in week one", () => {
    const now = "2026-11-16T08:00:00+02:00";
    const { rerender } = render(<StudyDays week={weekOf([], 7, now)} weeksInARow={0} freeSkipsLeft={1} />);
    expect(document.body.textContent).toContain("0 of 7 days this week. 7 more to go.");
    expect(document.body.textContent).not.toMatch(/IN A ROW|FREE SKIP/);
    rerender(<StudyDays week={weekOf([], 4, now)} weeksInARow={2} freeSkipsLeft={1} />);
    expect(document.body.textContent).toContain("2 WEEKS IN A ROW · 1 FREE SKIP LEFT");
  });
});
