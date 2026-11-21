import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const save = vi.fn(async () => true);
const finish = vi.fn(async () => ({}));
vi.mock("@/app/(app)/exams/mock/actions", () => ({
  saveMockAnswerAction: (...a: unknown[]) => save(...(a as [])),
  finishMockAttemptAction: (...a: unknown[]) => finish(...(a as [])),
}));
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }) }));

import { sampleAttempt, samplePaper } from "./sample-exam";
import { Sitting } from "./sitting";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  save.mockClear();
  finish.mockClear();
});

describe("sitting a mock exam", () => {
  it("shows question 1 in this attempt's order, lettered, with Leave blank and the rule", () => {
    render(<Sitting exam={samplePaper} attempt={sampleAttempt()} initialQ={1} />);
    const items = screen.getAllByTestId("tf-item");
    expect(items).toHaveLength(6);
    // tfOrder starts with item 2.
    expect(items[0].textContent).toContain("(a)");
    expect(items[0].textContent).toContain("Tomatoes are fruit.");
    expect(within(items[0]).getByLabelText("Leave blank")).toBeTruthy();
    expect(screen.getByTestId("tf-rule").textContent).toContain("Wrong −1");
  });

  it("saves a choice at once, with blank as null", async () => {
    render(<Sitting exam={samplePaper} attempt={sampleAttempt()} initialQ={1} />);
    const first = screen.getAllByTestId("tf-item")[0];
    fireEvent.click(within(first).getByLabelText("Leave blank"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(save).toHaveBeenCalledWith("att-1", { kind: "trueFalse", item: 2, answer: null }, expect.any(Number));
  });

  it("saves a written answer shortly after typing stops", async () => {
    render(<Sitting exam={samplePaper} attempt={sampleAttempt()} initialQ={2} />);
    const box = screen.getByPlaceholderText("Your answer to 2(a)");
    fireEvent.change(box, { target: { value: "Fol" } });
    fireEvent.change(box, { target: { value: "Folds" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("att-1", { kind: "text", part: "2.0.0", text: "Folds" }, expect.any(Number));
    expect(screen.getByTestId("save-state").textContent).toBe("Saved");
  });

  it("shows points as on the paper", () => {
    render(<Sitting exam={samplePaper} attempt={sampleAttempt()} initialQ={3} />);
    expect(screen.getAllByTestId("paper-points").map((p) => p.textContent)).toEqual(["(1.5p)", "(1.5p)", "(3p)"]);
    expect(screen.getByRole("math", { name: "y = 2x + 1." })).toBeTruthy();
  });

  it("asks before marking with empty parts, then finishes", async () => {
    render(<Sitting exam={samplePaper} attempt={sampleAttempt()} initialQ={4} />);
    fireEvent.click(screen.getByRole("button", { name: "Finish and mark" }));
    expect(screen.getByText(/written parts are empty/)).toBeTruthy();
    expect(finish).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mark anyway" }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(finish).toHaveBeenCalledWith("att-1", expect.any(Number));
    expect(replace).toHaveBeenCalledWith("/exams/mock/attempt/att-1?view=mark&q=1");
  });
});
