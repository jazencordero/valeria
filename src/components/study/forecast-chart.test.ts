import { describe, expect, it } from "vitest";
import { forecastChartLayout } from "./forecast-chart";

const base = { forecast: 20, daysLeft: 8, target: 85, examDay: "NOV 23" };

describe("forecastChartLayout: bottom axis", () => {
  it("with no history yet, leaves out '2 WEEKS AGO' and keeps TODAY at its point", () => {
    const g = forecastChartLayout({ ...base, history: [] }, 340);
    expect(g.axis.showStart).toBe(false);
    expect(g.axis.showToday).toBe(true);
    // TODAY sits over the today point (the left edge), not pushed right by the start label.
    expect(Math.abs(g.axis.todayX - g.x0)).toBeLessThan(30);
  });

  it("with history, shows the start label and keeps TODAY clear of it", () => {
    const history = Array.from({ length: 13 }, (_, i) => i * 1.5);
    const g = forecastChartLayout({ ...base, history }, 340);
    expect(g.axis.showStart).toBe(true);
    expect(g.axis.todayX).toBeGreaterThan(g.L + 40);
  });
});

describe("forecastChartLayout: the target label", () => {
  it("names the grade only when one is given", () => {
    expect(forecastChartLayout({ ...base, history: [], targetGrade: 4 }, 340).targetText).toBe("target 85% · a 4");
    expect(forecastChartLayout({ ...base, history: [], targetGrade: null }, 340).targetText).toBe("target 85%");
    expect(forecastChartLayout({ ...base, history: [] }, 340).targetText).toBe("target 85%");
  });
});
