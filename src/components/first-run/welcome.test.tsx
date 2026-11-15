import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Welcome } from "./welcome";

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

/** jsdom has no Web Animations: a stand-in that finishes after delay + duration. */
const cancelled: Element[] = [];
function stubAnimate() {
  Element.prototype.animate = function (this: Element, _k: unknown, opts?: number | KeyframeAnimationOptions) {
    const o = typeof opts === "object" ? opts : {};
    const ms = Number(o.delay ?? 0) + Number(o.duration ?? 0);
    return {
      finished: new Promise((resolve) => setTimeout(resolve, ms)),
      cancel: () => cancelled.push(this),
    } as unknown as Animation;
  };
  // The cap cancels its own loops when calm.
  Element.prototype.getAnimations = () => [];
}

const HEADLINE = "Get a 5.Worry less.Party more.";

/**
 * The finished DOM, minus what other components change by mode themselves:
 * the cap's loop class and the inside of Button (press, fade, spinner).
 */
function finishedHtml(container: HTMLElement) {
  return container.innerHTML
    .replace(/class="cap( tiny)? (idle|calm)[^"]*"/g, 'class="cap$1"')
    .replace(/<a [^>]*href="\/school"[\s\S]*?<\/a>/, "<a>Get started</a>");
}

const styled = (c: HTMLElement) => c.querySelectorAll("[data-part][style]");

describe("Welcome", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    stubAnimate();
    cancelled.length = 0;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // @ts-expect-error jsdom has none; remove the stand-in again.
    delete Element.prototype.animate;
    // @ts-expect-error as above.
    delete Element.prototype.getAnimations;
    delete document.documentElement.dataset.fast;
  });

  it("ends on the same screen in full, calm and instant", async () => {
    const full = render(<Welcome />);
    // While it plays: outlines, parts hidden, headline not yet typed.
    expect(full.container.querySelector("[data-guides]")).not.toBeNull();
    expect(styled(full.container).length).toBeGreaterThan(0);
    expect(full.container.querySelector("h1")?.getAttribute("aria-label")).toBe(
      "Get a 5. Worry less. Party more.",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(full.container.querySelector("[data-guides]")).toBeNull();
    expect(styled(full.container)).toHaveLength(0);
    expect(full.container.querySelector("h1")?.textContent).toBe(HEADLINE);
    const end = finishedHtml(full.container);
    cleanup();

    stubReducedMotion(true);
    const calm = render(<Welcome />);
    expect(finishedHtml(calm.container)).toBe(end);
    cleanup();

    stubReducedMotion(false);
    document.documentElement.dataset.fast = "1";
    const instant = render(<Welcome />);
    expect(finishedHtml(instant.container)).toBe(end);
  });

  it("a tap during the intro shows the finished screen at once", () => {
    const { container } = render(<Welcome />);
    act(() => {
      vi.advanceTimersByTime(800);
    });
    // Still typing: the untyped rest is held as invisible text.
    expect(container.querySelector("h1 .invisible")).not.toBeNull();

    act(() => {
      fireEvent.pointerDown(window);
    });
    expect(container.querySelector("[data-guides]")).toBeNull();
    expect(styled(container)).toHaveLength(0);
    expect(container.querySelector("h1 .invisible")).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe(HEADLINE);
    expect(container.querySelector("h1")?.hasAttribute("aria-label")).toBe(false);
    // Every part's animation was cancelled, so none leaves a style behind.
    expect(cancelled.length).toBe(container.querySelectorAll("[data-part]").length);
    expect(container.querySelector("a[href='/school']")?.textContent).toContain("Get started");
  });

  it("under the test switch draws no outlines and hides nothing", () => {
    document.documentElement.dataset.fast = "1";
    const { container } = render(<Welcome />);
    expect(container.querySelector("[data-guides]")).toBeNull();
    expect(styled(container)).toHaveLength(0);
    expect(container.querySelector("h1")?.textContent).toBe(HEADLINE);
    expect(cancelled).toHaveLength(0);
  });
});
