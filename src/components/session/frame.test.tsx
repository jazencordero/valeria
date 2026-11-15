import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/confetti", () => ({ burst: vi.fn() }));

import { burst } from "@/components/ui/confetti";
import {
  CONFETTI_PIECES,
  MISS_TEXT,
  SessionFrame,
  STOP_TEXT,
  TOAST_CLIMB_MS,
  TOAST_MISS_MS,
  TOAST_OUT_MS,
  formatClock,
  type SessionFrameHandle,
  type SessionFrameProps,
} from "./frame";

const CARDS: SessionFrameProps["cards"] = [
  { section: "warm" },
  { section: "learn" },
  { section: "learn" },
  { section: "boss" },
];

function frame(over: Partial<SessionFrameProps> = {}) {
  const props: SessionFrameProps = {
    cards: CARDS,
    index: 1,
    counts: { new: 2, learning: 1, due: 1 },
    startedAt: Date.now(),
    onStop: vi.fn(),
    ...over,
  };
  return <SessionFrame {...props} />;
}

beforeEach(() => {
  // jsdom has no Web Animations; the cap cancels its animations when calm.
  if (!("getAnimations" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "getAnimations", { value: () => [], configurable: true });
  }
  // Instant motion, so nothing waits on animation frames.
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
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(burst).mockClear();
  delete document.documentElement.dataset.fast;
});

describe("formatClock", () => {
  it("writes m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(247)).toBe("4:07");
    expect(formatClock(750)).toBe("12:30");
  });
});

describe("SessionFrame top bar", () => {
  it("shows one segment per card, filled before index, plus counts", () => {
    render(frame({ index: 2 }));
    const segs = screen.getByTestId("ss-prog").querySelectorAll("i");
    expect(segs).toHaveLength(4);
    expect(Array.from(segs).map((s) => s.dataset.section)).toEqual(["warm", "learn", "learn", "boss"]);
    expect(Array.from(segs).map((s) => s.dataset.on === "true")).toEqual([true, true, false, false]);
    expect(screen.getByText("2 new · 1 learning · 1 due")).toBeTruthy();
  });

  it("ticks the timer as m:ss", () => {
    vi.useFakeTimers();
    render(frame({ startedAt: Date.now() - 65_000 }));
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(screen.getByLabelText("Time in this session").textContent).toBe("1:05");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByLabelText("Time in this session").textContent).toBe("1:06");
  });
});

describe("SessionFrame stop confirm", () => {
  it("Escape opens the confirm and Escape again closes it", () => {
    render(frame());
    expect(screen.queryByText(STOP_TEXT)).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByText(STOP_TEXT)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText(STOP_TEXT)).toBeNull();
  });

  it("the close button opens it; Keep going closes without stopping", () => {
    const onStop = vi.fn();
    render(frame({ onStop }));
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
    expect(screen.getByRole("group", { name: "Stop the session?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
    expect(screen.queryByText(STOP_TEXT)).toBeNull();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("Stop calls onStop once", () => {
    const onStop = vi.fn();
    render(frame({ onStop }));
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("makes everything behind it inert", () => {
    render(
      <div>
        <button type="button">Behind</button>
        {frame()}
      </div>,
    );
    const behind = screen.getByText("Behind");
    expect(behind.inert).toBe(true);
  });
});

describe("SessionFrame toasts", () => {
  it("miss toast stays 1.6 s, then fades out", () => {
    vi.useFakeTimers();
    const ref = createRef<SessionFrameHandle>();
    render(frame({ ref }));
    act(() => ref.current?.miss());
    expect(screen.getByTestId("ss-toast").textContent).toBe(MISS_TEXT);
    act(() => {
      vi.advanceTimersByTime(TOAST_MISS_MS - 1);
    });
    expect(screen.getByTestId("ss-toast").dataset.leaving).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("ss-toast").dataset.leaving).toBe("true");
    act(() => {
      vi.advanceTimersByTime(TOAST_OUT_MS);
    });
    expect(screen.queryByTestId("ss-toast")).toBeNull();
  });

  it("climb toast names the rung, shows pips and stays 2.2 s", () => {
    vi.useFakeTimers();
    const ref = createRef<SessionFrameHandle>();
    render(frame({ ref }));
    act(() => ref.current?.climb("Supply", 3));
    const t = screen.getByTestId("ss-toast");
    expect(t.textContent).toBe("Supply climbed to Recall");
    expect(t.querySelector("[data-rung='3']")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(TOAST_MISS_MS);
    });
    expect(screen.getByTestId("ss-toast").dataset.leaving).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(TOAST_CLIMB_MS - TOAST_MISS_MS);
    });
    expect(screen.getByTestId("ss-toast").dataset.leaving).toBe("true");
    act(() => {
      vi.advanceTimersByTime(TOAST_OUT_MS);
    });
    expect(screen.queryByTestId("ss-toast")).toBeNull();
  });

  it("a newer toast replaces the older one and restarts the clock", () => {
    vi.useFakeTimers();
    const ref = createRef<SessionFrameHandle>();
    render(frame({ ref }));
    act(() => ref.current?.miss());
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => ref.current?.climb("Demand", 2));
    act(() => {
      vi.advanceTimersByTime(TOAST_MISS_MS);
    });
    const t = screen.getByTestId("ss-toast");
    expect(t.dataset.kind).toBe("climb");
    expect(t.dataset.leaving).toBeUndefined();
  });
});

describe("SessionFrame in-a-row pill", () => {
  it("is hidden under 2, shows a flame from 2 and is hot from 5", () => {
    const { rerender } = render(frame({ streak: 1 }));
    expect(screen.queryByTestId("ss-combo")).toBeNull();
    rerender(frame({ streak: 2 }));
    const pill = screen.getByTestId("ss-combo");
    expect(pill.textContent).toBe("2 in a row");
    expect(pill.querySelector("svg")).toBeTruthy();
    expect(pill.dataset.hot).toBeUndefined();
    rerender(frame({ streak: 4 }));
    expect(screen.getByTestId("ss-combo").dataset.hot).toBeUndefined();
    rerender(frame({ streak: 5 }));
    expect(screen.getByTestId("ss-combo").dataset.hot).toBe("true");
    expect(screen.getByTestId("ss-combo").textContent).toBe("5 in a row");
  });

  it("fires 14 confetti pieces on every multiple of 5, once each", () => {
    const { rerender } = render(frame({ streak: 3 }));
    rerender(frame({ streak: 4 }));
    expect(burst).not.toHaveBeenCalled();
    rerender(frame({ streak: 5 }));
    expect(burst).toHaveBeenCalledTimes(1);
    expect(vi.mocked(burst).mock.calls[0][1]).toBe(CONFETTI_PIECES);
    expect(CONFETTI_PIECES).toBe(14);
    rerender(frame({ streak: 5 }));
    rerender(frame({ streak: 6 }));
    expect(burst).toHaveBeenCalledTimes(1);
    rerender(frame({ streak: 10 }));
    expect(burst).toHaveBeenCalledTimes(2);
  });
});

/** Stubs prefers-reduced-motion: `reduce` matches when `calm` is true. */
function stubReducedMotion(calm: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: calm && query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

describe("SessionFrame progress segments and motion", () => {
  // jsdom applies no Tailwind and no media queries, so these read the classes
  // the segments get: `transition-transform` is the only transform transition.
  const fills = () => Array.from(screen.getByTestId("ss-prog").querySelectorAll("b"));

  it("with reduced motion, no segment has a transform transition", () => {
    delete document.documentElement.dataset.fast;
    stubReducedMotion(true);
    render(frame({ index: 2 }));
    expect(fills()).toHaveLength(4);
    for (const b of fills()) expect(b.className).not.toMatch(/transition/);
    vi.unstubAllGlobals();
  });

  it("with motion on, segments grow, and the CSS also stops it under reduced motion", () => {
    delete document.documentElement.dataset.fast;
    stubReducedMotion(false);
    render(frame({ index: 2 }));
    for (const b of fills()) {
      expect(b.className).toContain("transition-transform");
      // Before hydration reads the setting (server render), CSS turns it off.
      expect(b.className).toContain("motion-reduce:transition-none");
    }
    vi.unstubAllGlobals();
  });
});
