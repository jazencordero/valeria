import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Arrive, buildEndsAt, guidesFadeAt } from "./arrive";

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("reduce") ? reduce : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

function Home({ play }: { play: boolean }) {
  return (
    <Arrive play={play} className="grid">
      <header data-arrive-part="bare">MON 16 NOV</header>
      <section data-arrive-part="">
        <span role="img" data-value="64">
          <b>64</b>
        </span>
        <span data-pct="64">{64}%</span>
        <button>Today’s bite · 5 min</button>
        <p data-testid="clock">15 h 41 min left</p>
      </section>
      <aside data-arrive-part="">This week</aside>
    </Arrive>
  );
}

const root = (c: HTMLElement) => c.firstElementChild as HTMLElement;

describe("Arrive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    window.history.replaceState(null, "", "/home?arrive=1&x=2");
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.fast;
    window.history.replaceState(null, "", "/");
  });

  it("renders plainly without the flag", () => {
    const { container } = render(<Home play={false} />);
    expect(root(container).hasAttribute("data-arrive")).toBe(false);
    expect(container.querySelector("[data-guides]")).toBeNull();
    expect(container.textContent).toContain("64%");
    expect(container.textContent).toContain("5 min");
    // Not its flag to take: the address stays.
    expect(window.location.search).toBe("?arrive=1&x=2");
  });

  it("plays the build once with the flag, then rests", () => {
    const { container } = render(<Home play />);
    expect(root(container).getAttribute("data-arrive")).toBe("play");
    // One outline per part, none for the bare top row.
    expect(container.querySelectorAll("[data-guides] rect")).toHaveLength(2);
    // Numbers start from 0.
    expect(container.querySelector("[data-pct]")?.textContent).toBe("0%");
    expect(container.querySelector("b")?.textContent).toBe("0");
    expect(container.querySelector("button")?.textContent).toBe("Today’s bite · 0 min");
    // A clock is not an amount: it does not count.
    expect(container.querySelector("[data-testid=clock]")?.textContent).toBe("15 h 41 min left");
    // The flag is gone from the address, the rest of the query stays.
    expect(window.location.search).toBe("?x=2");

    act(() => {
      vi.advanceTimersByTime(guidesFadeAt(3) + 1);
    });
    expect(container.querySelector("[data-guides]")?.getAttribute("data-guides")).toBe("fading");

    act(() => {
      vi.advanceTimersByTime(buildEndsAt(3));
    });
    expect(root(container).hasAttribute("data-arrive")).toBe(false);
    expect(container.querySelector("[data-guides]")).toBeNull();
    expect(container.querySelector("[data-pct]")?.textContent).toBe("64%");
    expect(container.querySelector("b")?.textContent).toBe("64");
    expect(container.querySelector("button")?.textContent).toBe("Today’s bite · 5 min");
  });

  it("with reduced motion only fades: no outlines, no counting", () => {
    stubReducedMotion(true);
    const { container } = render(<Home play />);
    // "wait" is the state the 150 ms CSS fade hangs on.
    expect(root(container).getAttribute("data-arrive")).toBe("wait");
    expect(container.querySelector("[data-guides]")).toBeNull();
    expect(container.querySelector("[data-pct]")?.textContent).toBe("64%");
    expect(window.location.search).toBe("?x=2");
    act(() => {
      vi.advanceTimersByTime(151);
    });
    expect(root(container).hasAttribute("data-arrive")).toBe(false);
  });

  it("does nothing under the test switch", () => {
    document.documentElement.dataset.fast = "1";
    const { container } = render(<Home play />);
    expect(root(container).hasAttribute("data-arrive")).toBe(false);
    expect(container.querySelector("[data-guides]")).toBeNull();
    expect(container.querySelector("[data-pct]")?.textContent).toBe("64%");
  });
});
