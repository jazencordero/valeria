import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {}, prefetch: () => {} }),
  usePathname: () => "/exams/e1",
}));

// The Notes tab reaches server actions; nothing here calls them.
vi.mock("@/server/db/client", () => ({ db: {} }));

const { ExamPage } = await import("./exam-page");
type Props = Parameters<typeof ExamPage>[0];

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const STARTS = "Starts Tue 24 Nov. Nothing to do here until then.";

// A made-up exam.
const base: Props = {
  examId: "e1",
  course: "Sample course",
  sub: "Sample exam · Fri 4 Dec",
  forecast: 6,
  verdict: "Starts Tue 24 Nov",
  today: { state: "quiet", line: STARTS },
  progress: {
    target: 80,
    targetGrade: 4,
    planEnd: 6,
    dayName: "Fri 4 Dec",
    planLine: "A bite a day gets you to about 47% by Fri 4 Dec.",
    chart: { history: [], forecast: 6, daysLeft: 19, target: 85, examDay: "DEC 4" },
    concepts: [
      { id: "c1", name: "Sample concept one", lecture: 1, weight: 0.5, mastery: 0, minutes: 2 },
      { id: "c2", name: "Sample concept two", lecture: 2, weight: 0.5, mastery: 0.12, minutes: 2 },
    ],
    focusId: "c1",
    daysLeft: 19,
    week: { days: [], count: 0, goal: 4, met: false, sentence: "" } as unknown as Props["progress"]["week"],
    weeksInARow: 0,
    freeSkipsLeft: 1,
  },
  practise: { counts: { basic: 2, cloze: 0, explain: 0, mcq: 0 }, reviews: [], heat: [], gradeMode: "two" },
  defaultTab: "progress",
};

const progressPanel = () => screen.getByTestId("progress-starts").parentElement!;

describe("the Progress tab", () => {
  it("before the study start is one line and nothing else", () => {
    render(<ExamPage {...base} progress={{ ...base.progress, note: STARTS, starts: STARTS }} />);
    const panel = progressPanel();
    expect(panel.textContent).toBe(STARTS);
    // No percent, no plan sentence, no chart, no concepts, no sheet button.
    expect(panel.textContent).not.toMatch(/%|right if it were today|gets you to|Sample concept/);
    expect(panel.querySelector("[data-gain-most]")).toBeNull();
    expect(panel.querySelector("svg")).toBeNull();
    expect(panel.querySelector("button")).toBeNull();
  });

  it("from the study start shows the percent, the page's plan sentence and each concept's level now", () => {
    render(<ExamPage {...base} />);
    expect(screen.queryByTestId("progress-starts")).toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).toContain("right if it were today");
    expect(text).toContain("A bite a day gets you to about 47% by Fri 4 Dec.");
    expect(text).toContain("0% now");
    expect(text).toContain("12% now");
    expect(text).not.toContain("on exam day");
  });
});
