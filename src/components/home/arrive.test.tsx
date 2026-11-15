import { act, cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CSSProperties } from "react";
import { Arrive, buildEndsAt, EARLY_START_MS, guidesFadeAt, RISE_STEP_MS, riseEndsAt } from "./arrive";

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

const order = (i: number) => ({ "--arrive-i": i }) as CSSProperties;

/**
 * Pretends the rise the server sent has been playing for `at` ms (jsdom runs
 * no CSS animations). `null`: it has finished.
 */
function stubRise(at: number | null) {
  HTMLElement.prototype.getAnimations = function (this: HTMLElement) {
    if (at === null || !this.hasAttribute("data-arrive-part")) return [];
    const from = EARLY_START_MS + Number(this.style.getPropertyValue("--arrive-i")) * RISE_STEP_MS;
    return [
      { animationName: "arrive-rise", currentTime: at, effect: { getComputedTiming: () => ({ delay: from }) } },
    ] as unknown as Animation[];
  };
}

function Home({ play }: { play: boolean }) {
  return (
    <Arrive play={play} className="grid">
      <header data-arrive-part="bare" style={order(0)}>
        MON 16 NOV
      </header>
      <section data-arrive-part="" style={order(1)}>
        <span role="img" data-value="64">
          <b>64</b>
        </span>
        <span data-pct="64">{64}%</span>
        <button>Today’s bite · 5 min</button>
        <p data-testid="clock">15 h 41 min left</p>
      </section>
      <aside data-arrive-part="" style={order(2)}>
        This week · 20 min
      </aside>
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
    // jsdom has no getAnimations of its own.
    delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations;
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

  it("sends the rise already playing: the content does not wait for the script", () => {
    const html = renderToString(<Home play />);
    expect(html).toContain('data-arrive="play"');
    // The rise is plain CSS in the same HTML, and it starts well under a second in.
    expect(html).toContain(`[data-arrive="play"] [data-arrive-part]`);
    expect(html).toContain("animation:arrive-rise 260ms");
    expect(EARLY_START_MS).toBeLessThan(300);
    // Nothing is held back until the script is live.
    expect(html).not.toContain("arrive-hold");
    expect(html).not.toContain('data-arrive="wait"');
  });

  it("plays the build once with the flag, then rests", () => {
    const { container } = render(<Home play />);
    // Nothing was showing yet: the full build starts from the top.
    expect(root(container).getAttribute("data-arrive")).toBe("build");
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
    expect(container.querySelector("aside")?.textContent).toBe("This week · 20 min");
  });

  it("joins the rise when some parts are already showing", () => {
    // 200 ms in: the top row and the first section are showing, the last part is not.
    stubRise(200);
    const { container } = render(<Home play />);
    // The rise that is playing goes on (changing the attribute would start it again).
    expect(root(container).getAttribute("data-arrive")).toBe("play");
    expect(container.querySelectorAll("[data-guides] rect")).toHaveLength(2);
    // What she can already see is left alone...
    expect(container.querySelector("[data-pct]")?.textContent).toBe("64%");
    expect(container.querySelector("b")?.textContent).toBe("64");
    expect(container.querySelector("button")?.textContent).toBe("Today’s bite · 5 min");
    // ...what is still to come counts up.
    expect(container.querySelector("aside")?.textContent).toBe("This week · 0 min");
    expect(window.location.search).toBe("?x=2");

    act(() => {
      vi.advanceTimersByTime(guidesFadeAt(3, EARLY_START_MS) - 200 + 1);
    });
    expect(container.querySelector("[data-guides]")?.getAttribute("data-guides")).toBe("fading");
    act(() => {
      vi.advanceTimersByTime(buildEndsAt(3, EARLY_START_MS));
    });
    expect(root(container).hasAttribute("data-arrive")).toBe(false);
    expect(container.querySelector("aside")?.textContent).toBe("This week · 20 min");
  });

  it("adds nothing when every part is already showing, and lets the rise end", () => {
    // 300 ms in: the last part started rising at 220 ms.
    stubRise(300);
    const { container } = render(<Home play />);
    // "late" keeps the rise going and hides the outlines.
    expect(root(container).getAttribute("data-arrive")).toBe("late");
    expect(container.textContent).toContain("64%");
    expect(container.querySelector("aside")?.textContent).toBe("This week · 20 min");
    expect(window.location.search).toBe("?x=2");
    act(() => {
      vi.advanceTimersByTime(riseEndsAt(3, EARLY_START_MS) - 300);
    });
    expect(root(container).getAttribute("data-arrive")).toBe("late");
    act(() => {
      vi.advanceTimersByTime(51);
    });
    expect(root(container).hasAttribute("data-arrive")).toBe(false);
    expect(container.querySelector("[data-guides]")).toBeNull();
  });

  it("adds nothing when the rise finished before the script was live", () => {
    stubRise(null);
    const { container } = render(<Home play />);
    expect(root(container).getAttribute("data-arrive")).toBe("late");
    expect(container.textContent).toContain("64%");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(root(container).hasAttribute("data-arrive")).toBe(false);
    expect(container.querySelector("[data-guides]")).toBeNull();
  });

  it("with reduced motion only fades: no outlines, no counting", () => {
    stubReducedMotion(true);
    const { container } = render(<Home play />);
    // The 150 ms CSS fade hangs on the attribute the server sent.
    expect(root(container).getAttribute("data-arrive")).toBe("play");
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
