import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, clearToast, showToast } from "./toast";

beforeEach(() => {
  // Instant motion: no animation timing in the way.
  document.documentElement.dataset.fast = "1";
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => clearToast());
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.fast;
});

describe("Toast", () => {
  it("shows the text in one status pill", () => {
    render(<Toaster />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => showToast("Saved."));
    expect(screen.getByRole("status").textContent).toBe("Saved.");
  });

  it("a second toast replaces the first", () => {
    render(<Toaster />);
    act(() => showToast("First one."));
    act(() => {
      vi.advanceTimersByTime(1500);
      showToast("Second one.");
    });
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Second one.");
    expect(screen.queryByText("First one.")).toBeNull();
    // The first toast's timer must not cut the second one short.
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole("status").textContent).toBe("Second one.");
  });

  it("is still there at 2.5 s and gone after 3 s", () => {
    render(<Toaster />);
    act(() => showToast("Added to your course. First review today."));
    act(() => vi.advanceTimersByTime(2500));
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
