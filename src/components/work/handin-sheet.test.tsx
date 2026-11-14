import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  failSentence,
  HandinSheet,
  MIN_SEND_MS,
  type HandinFailReason,
  type HandinReview,
  type Result,
} from "./handin-sheet";

// Made-up sample data. 15:52 Helsinki, due 21:00 the same day.
const NOW = "2026-11-14T13:52:00Z";
const REVIEW: HandinReview = {
  fileName: "Sample_Essay.pdf",
  bytes: 319_488,
  pages: 4,
  to: "Sample Course › Assignment 3",
  due: "2026-11-14T19:00:00Z",
};

function stubMatchMedia() {
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
}

function setup(onSubmit: () => Promise<Result>, onClose = vi.fn()) {
  const utils = render(
    <HandinSheet
      open
      onClose={onClose}
      review={REVIEW}
      lmsName="MyCourses"
      now={NOW}
      onSubmit={onSubmit}
      onBackHome={() => {}}
    />,
  );
  return { ...utils, onClose };
}

const submitButton = () => screen.getByRole("button", { name: /Submit to MyCourses|Sending to MyCourses|Try again/ });

beforeEach(() => {
  document.documentElement.dataset.fast = "1";
  stubMatchMedia();
  // jsdom has no Web Animations API; the cap calls getAnimations when calm.
  if (!("getAnimations" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [],
    });
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.fast;
});

describe("HandinSheet", () => {
  it("shows the review with the exact copy", () => {
    setup(() => Promise.resolve({ ok: true, submittedAt: NOW }));
    expect(screen.getByText("Sample_Essay.pdf")).toBeTruthy();
    expect(screen.getByText("4 pages · 312 KB")).toBeTruthy();
    expect(screen.getByText("Sample Course › Assignment 3")).toBeTruthy();
    expect(screen.getByText("21:00")).toBeTruthy();
    expect(screen.getByText("5 h 8 min early")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit to MyCourses" })).toBeTruthy();
    expect(
      screen.getByText("Submitting confirms this is your own work, as MyCourses asks."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not yet" })).toBeTruthy();
  });

  it("success shows the receipt and locks the sheet", async () => {
    const onSubmit = vi.fn(() => Promise.resolve<Result>({ ok: true, submittedAt: NOW }));
    const user = userEvent.setup();
    setup(onSubmit);
    await user.click(submitButton());

    await screen.findByText("Handed in");
    expect(screen.getByText("15:52 · Submitted for grading")).toBeTruthy();
    expect(
      screen.getByText("It is in MyCourses, 5 h 8 min before the deadline."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to home" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Handed in" })).toBeTruthy();
    expect(screen.getByTestId("handin-sheet").querySelector("[data-locked='true']")).not.toBeNull();
    // No way to submit again.
    expect(screen.queryByRole("button", { name: /Submit to/ })).toBeNull();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("stays locked when closed and opened again; closing still works", async () => {
    const onSubmit = vi.fn(() => Promise.resolve<Result>({ ok: true, submittedAt: NOW }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { rerender } = setup(onSubmit, onClose);
    await user.click(submitButton());
    await screen.findByText("Handed in");

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    const props = {
      onClose,
      review: REVIEW,
      lmsName: "MyCourses",
      now: NOW,
      onSubmit,
      onBackHome: () => {},
    };
    rerender(<HandinSheet open={false} {...props} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    rerender(<HandinSheet open {...props} />);
    expect(await screen.findByText("Handed in")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Submit to/ })).toBeNull();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("a double tap submits once", async () => {
    let resolve: (r: Result) => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<Result>((r) => {
          resolve = r;
        }),
    );
    setup(onSubmit);
    const btn = submitButton();
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sending to MyCourses" })).toBeTruthy();
    await act(async () => resolve({ ok: true, submittedAt: NOW }));
    await screen.findByText("Handed in");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("keeps sending for at least 900 ms even when the answer is instant", async () => {
    delete document.documentElement.dataset.fast;
    vi.useFakeTimers();
    setup(() => Promise.resolve<Result>({ ok: true, submittedAt: NOW }));
    fireEvent.click(submitButton());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MIN_SEND_MS - 50);
    });
    const phase = () =>
      screen.getByTestId("handin-sheet").querySelector("[data-phase]")?.getAttribute("data-phase");
    expect(screen.getByRole("button", { name: "Sending to MyCourses" })).toBeTruthy();
    expect(phase()).toBe("sending");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    // The receipt's fade runs on animation frames, so check the phase.
    expect(phase()).toBe("done");
  });

  const reasons: { reason: HandinFailReason; retry: boolean }[] = [
    { reason: "expired", retry: false },
    { reason: "changed", retry: false },
    { reason: "refused", retry: false },
    { reason: "moodle_down", retry: true },
    { reason: "not_shown", retry: false },
  ];

  for (const { reason, retry } of reasons) {
    it(`${reason}: shows its own sentence${retry ? " and a retry" : ", no retry"}`, async () => {
      const message = reason === "refused" ? "Submissions are closed." : undefined;
      const onSubmit = vi.fn(() => Promise.resolve<Result>({ ok: false, reason, message }));
      const user = userEvent.setup();
      setup(onSubmit);
      await user.click(submitButton());

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(failSentence(reason, "MyCourses", message));
      expect(alert.getAttribute("data-reason")).toBe(reason);
      expect(screen.queryByText("Handed in")).toBeNull();

      const again = screen.queryByRole("button", { name: "Try again" });
      if (retry) {
        expect(again).not.toBeNull();
        expect(screen.queryByRole("button", { name: /Submit to/ })).toBeNull();
      } else {
        expect(again).toBeNull();
        expect(screen.queryByRole("button", { name: /Submit to/ })).toBeNull();
        expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
      }
    });
  }

  it("every reason has a different sentence", () => {
    const all = [...reasons.map((r) => r.reason), "network" as const].map((r) =>
      failSentence(r, "MyCourses", r === "refused" ? "No." : undefined),
    );
    expect(new Set(all).size).toBe(all.length);
    expect(failSentence("refused", "MyCourses", "Submissions are closed.")).toContain(
      "Submissions are closed.",
    );
  });

  it("retry after moodle_down can succeed", async () => {
    const onSubmit = vi
      .fn<() => Promise<Result>>()
      .mockResolvedValueOnce({ ok: false, reason: "moodle_down" })
      .mockResolvedValueOnce({ ok: true, submittedAt: NOW });
    const user = userEvent.setup();
    setup(onSubmit);
    await user.click(submitButton());
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Handed in")).toBeTruthy();
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("a thrown request shows the connection sentence with a retry", async () => {
    const user = userEvent.setup();
    setup(() => Promise.reject(new Error("offline")));
    await user.click(submitButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(failSentence("network", "MyCourses"));
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("Not yet closes", async () => {
    const user = userEvent.setup();
    const { onClose } = setup(() => Promise.resolve<Result>({ ok: true, submittedAt: NOW }));
    await user.click(screen.getByRole("button", { name: "Not yet" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
