import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RollingNumber } from "./rolling-number";

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

/** Text a screen reader would read: everything outside aria-hidden. */
function accessibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return "";
  return Array.from(node.childNodes).map(accessibleText).join("");
}

function setup(value: number | string) {
  const utils = render(<RollingNumber value={value} />);
  const read = () => accessibleText(utils.container);
  const rolling = () => utils.container.querySelectorAll("[data-roll-in]").length;
  return { ...utils, read, rolling };
}

describe("RollingNumber", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubReducedMotion(false);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads the plain value at rest", () => {
    const { read } = setup(42);
    expect(read()).toBe("42");
  });

  it("rolls only the changed digits and keeps the accessible text equal to the value", () => {
    const { rerender, read, rolling } = setup(128);
    rerender(<RollingNumber value={135} />);
    expect(read()).toBe("135");
    expect(rolling()).toBe(2);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(rolling()).toBe(0);
    expect(read()).toBe("135");
  });

  it("keeps the accessible text right across fast changes", () => {
    const { rerender, read } = setup(10);
    for (const v of [11, 12, 19, 23, 99]) {
      rerender(<RollingNumber value={v} />);
      expect(read()).toBe(String(v));
    }
  });

  it("does not roll when the length changes", () => {
    const { rerender, read, rolling } = setup(9);
    rerender(<RollingNumber value={10} />);
    expect(rolling()).toBe(0);
    expect(read()).toBe("10");
  });

  it("does not roll when motion is calm", () => {
    stubReducedMotion(true);
    const { rerender, read, rolling } = setup(41);
    rerender(<RollingNumber value={42} />);
    expect(rolling()).toBe(0);
    expect(read()).toBe("42");
  });

  it("works with text values like percentages", () => {
    const { rerender, read, rolling } = setup("37%");
    rerender(<RollingNumber value="38%" />);
    expect(rolling()).toBe(1);
    expect(read()).toBe("38%");
  });
});
