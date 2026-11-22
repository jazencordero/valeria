import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptSummary, MockExamListing } from "@/lib/mock-exams/types";

vi.mock("@/app/(app)/exams/mock/actions", () => ({
  saveMockAnswerAction: vi.fn(async () => true),
  finishMockAttemptAction: vi.fn(),
  setMockTicksAction: vi.fn(),
  suggestMockTicksAction: vi.fn(),
  startMockExamAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));

import { liveScore } from "./format";
import { Marking } from "./marking";
import { MockList } from "./mock-list";
import { sampleAttempt, sampleDrill, sampleDrillPaper } from "./sample-exam";
import { Sitting } from "./sitting";

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const drillAttempt = sampleAttempt({ examId: "sample-drill", tfOrder: [] });

describe("a drill set (no true/false, three questions, 18 points)", () => {
  it("sits as 1 of 3 with no true/false rule, and finishes on question 3", () => {
    render(<Sitting exam={sampleDrillPaper} attempt={drillAttempt} initialQ={1} />);
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.queryByTestId("tf-rule")).toBeNull();
    expect(screen.queryByText("Leave blank")).toBeNull();
    cleanup();
    render(<Sitting exam={sampleDrillPaper} attempt={drillAttempt} initialQ={3} />);
    expect(screen.getByRole("button", { name: "Finish and mark" })).toBeTruthy();
  });

  it("marks out of its own total", () => {
    expect(liveScore(sampleDrill, drillAttempt)).toMatchObject({ total: 0, max: 18 });
    render(<Marking exam={sampleDrill} attempt={{ ...drillAttempt, finishedAt: "2026-11-22T09:00:00.000Z" }} checkAllowed={false} initialQ={3} readOnly={false} />);
    expect(screen.getByText(/· 3 of 3/)).toBeTruthy();
    expect(screen.getByTestId("mark-total").textContent).toContain("/ 18");
  });
});

const row = (over: Partial<MockExamListing>): MockExamListing => ({
  id: "x",
  order: 1,
  kind: "mock",
  title: "X",
  subtitle: "",
  totalPoints: 24,
  suggestedMinutes: 60,
  status: "new",
  best: null,
  latest: null,
  attempts: 0,
  openAttemptId: null,
  ...over,
});

const summary = (id: string, examId: string, total: number, max: number): AttemptSummary => ({
  id,
  examId,
  examTitle: examId,
  startedAt: "2026-11-22T08:00:00.000Z",
  finishedAt: "2026-11-22T09:00:00.000Z",
  secondsUsed: 600,
  edited: false,
  score: { total, max, questions: [] },
});

describe("the Mock exams list", () => {
  it("groups full exams (teacher first, boss last), math, then figures", () => {
    render(
      <MockList
        attempts={[]}
        exams={[
          row({ id: "f1", order: 16, kind: "drill-figure" as MockExamListing["kind"], title: "Figures 1", totalPoints: 18 }),
          row({ id: "boss", order: 10, kind: "boss", title: "Boss" }),
          row({ id: "m1", order: 2, title: "Mock 1", attempts: 1, best: 12, latest: 12, status: "done" }),
          row({ id: "t", order: 1, kind: "teacher", title: "Teacher" }),
          row({ id: "d1", order: 11, kind: "drill-math" as MockExamListing["kind"], title: "Math 1" }),
        ]}
      />,
    );
    const groups = ["full", "math", "figure"].map((g) => screen.getByTestId(`mock-group-${g}`));
    expect(within(groups[0]).getAllByTestId("mock-card").map((c) => c.textContent?.split(/(?=From|Boss|best|\d+ points)/)[0])).toEqual([
      "Teacher",
      "Mock 1",
      "Boss",
    ]);
    expect(groups[0].textContent).toContain("1 of 3 done");
    expect(within(groups[2]).getByTestId("mock-card-scores").textContent).toContain("18 points");
  });

  it("compares mixed totals in percent", () => {
    render(
      <MockList
        exams={[row({ id: "a" }), row({ id: "b", kind: "drill-figure" as MockExamListing["kind"], totalPoints: 18 })]}
        attempts={[summary("1", "a", 12, 24), summary("2", "b", 9, 18)]}
      />,
    );
    expect(screen.getByTestId("mock-trend").textContent).toContain("latest 50%");
    expect(screen.getByTestId("mock-trend").textContent).toContain("percent of each set's points");
  });
});
