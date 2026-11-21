import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attempt } from "@/lib/mock-exams/types";

const setTicks = vi.fn(async (_id: string, part: string, ticks: unknown[]) => ({ ...base, ticks: { [part]: ticks } }) as Attempt);
const suggest = vi.fn();
vi.mock("@/app/(app)/exams/mock/actions", () => ({
  setMockTicksAction: (...a: unknown[]) => setTicks(...(a as [string, string, unknown[]])),
  suggestMockTicksAction: (...a: unknown[]) => suggest(...a),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));

import { Marking } from "./marking";
import { sampleAttempt, sampleExam } from "./sample-exam";

const base = sampleAttempt({ finishedAt: "2026-11-21T09:00:00.000Z", trueFalse: { 0: true, 1: true, 2: null } });

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
  setTicks.mockClear();
  suggest.mockReset();
});

describe("marking a mock exam", () => {
  it("marks question 1 for her and shows the note on a less certain key", () => {
    render(<Marking exam={sampleExam} attempt={base} checkAllowed={false} initialQ={1} readOnly={false} />);
    const marks = screen.getAllByTestId("tf-mark");
    // Shown first is item 2 (tomatoes), left blank: 0, with the note.
    expect(marks[0].textContent).toContain("Left blank");
    expect(within(marks[0]).getByTestId("tf-note")).toBeTruthy();
    // Apples right +1, carrots wrong −1: question 1 is 0.
    expect(screen.getByTestId("q-score").textContent).toContain("0");
  });

  it("shows her answer beside ours and saves a tick at once", async () => {
    render(
      <Marking exam={sampleExam} attempt={{ ...base, texts: { "2.0.0": "My idea" } }} checkAllowed={false} initialQ={2} readOnly={false} />,
    );
    const part = screen.getAllByTestId("part-mark")[0];
    expect(part.textContent).toContain("My idea");
    expect(part.textContent).toContain("Our answers");
    expect(within(part).queryByRole("button", { name: "Check my answer" })).toBeNull();
    await act(async () => {
      fireEvent.click(within(part).getByLabelText(/Names the idea/));
    });
    expect(setTicks).toHaveBeenCalledWith("att-1", "2.0.0", [{ index: 0, fromCheck: false }], false);
    expect(within(part).getByTestId("part-score").textContent).toContain("1 / 2");
  });

  it("offers Check my answer when allowed and keeps her own ticks", async () => {
    suggest.mockResolvedValue({ status: "ok", part: "2.0.0", ticks: [0, 1], missing: [] });
    render(
      <Marking exam={sampleExam} attempt={{ ...base, texts: { "2.0.0": "My idea" } }} checkAllowed initialQ={2} readOnly={false} />,
    );
    const part = screen.getAllByTestId("part-mark")[0];
    // She unticks nothing but touches tick 0 first (on, then off): it stays hers.
    await act(async () => {
      fireEvent.click(within(part).getByLabelText(/Names the idea/));
    });
    await act(async () => {
      fireEvent.click(within(part).getByLabelText(/Names the idea/));
    });
    await act(async () => {
      fireEvent.click(within(part).getByRole("button", { name: "Check my answer" }));
    });
    expect(setTicks).toHaveBeenLastCalledWith("att-1", "2.0.0", [{ index: 1, fromCheck: true }], false);
    expect(within(part).getByText("Your own ticks always win.")).toBeTruthy();
  });

  it("shows nothing when the check is unavailable", async () => {
    suggest.mockResolvedValue({ status: "unavailable" });
    render(<Marking exam={sampleExam} attempt={base} checkAllowed initialQ={2} readOnly={false} />);
    const part = screen.getAllByTestId("part-mark")[0];
    await act(async () => {
      fireEvent.click(within(part).getByRole("button", { name: "Check my answer" }));
    });
    expect(within(part).queryByText("Your own ticks always win.")).toBeNull();
    expect(setTicks).not.toHaveBeenCalled();
  });

  it("opens a past attempt read-only", () => {
    render(<Marking exam={sampleExam} attempt={base} checkAllowed initialQ={2} readOnly />);
    const part = screen.getAllByTestId("part-mark")[0];
    expect((within(part).getByLabelText(/Names the idea/) as HTMLInputElement).disabled).toBe(true);
    expect(within(part).queryByRole("button", { name: "Check my answer" })).toBeNull();
  });
});
