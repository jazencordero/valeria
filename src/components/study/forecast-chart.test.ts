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
