import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let path = "/home";
vi.mock("next/navigation", () => ({ usePathname: () => path }));

import {
  PAGE_TRANSITION_CSS,
  PageTransition,
  TAB_ORDER,
  focusHeading,
  tabDirection,
  tabTransitionTypes,
} from "./page-transition";

function stubMatchMedia(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: reduce && query.includes("reduce"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

function Frame({ title }: { title: string }) {
  return (
    <main id="main">
      <PageTransition>
        <h1>{title}</h1>
      </PageTransition>
    </main>
  );
}

/** Renders the frame on `from`, then moves to `to`. Returns <main>'s animate spy. */
function go(from: string, to: string, before?: () => void) {
  path = from;
  const view = render(<Frame title="First" />);
  const main = view.container.querySelector("main")!;
  const animate = vi.fn();
  main.animate = animate as unknown as typeof main.animate;
  before?.();
  path = to;
  view.rerender(<Frame title="Second" />);
  return { animate, heading: view.container.querySelector("h1")! };
}

beforeEach(() => stubMatchMedia(false));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.fast;
});

describe("tab order and direction", () => {
  it("is Home, Assignments, Exams, Grades, Calendar", () => {
    expect(TAB_ORDER).toEqual(["home", "assignments", "exams", "grades", "calendar"]);
  });

  it("goes forward to a later tab and back to an earlier one", () => {
    expect(tabDirection("home", "exams")).toBe(1);
    expect(tabDirection("calendar", "assignments")).toBe(-1);
    expect(tabDirection("exams", "exams")).toBe(0);
    expect(tabDirection(null, "exams")).toBe(0);
    expect(tabDirection("exams", null)).toBe(0);
  });

  it("gives a link its transition type from the page it is on", () => {
    expect(tabTransitionTypes("/home", "/grades")).toEqual(["tab-forward"]);
    expect(tabTransitionTypes("/grades", "/assignments")).toEqual(["tab-back"]);
    // A page below a tab belongs to that tab.
    expect(tabTransitionTypes("/exams/abc", "/home")).toEqual(["tab-back"]);
    expect(tabTransitionTypes("/exams/abc", "/exams")).toBeUndefined();
    // Not between two tabs: no transition.
    expect(tabTransitionTypes("/settings", "/home")).toBeUndefined();
    expect(tabTransitionTypes(null, "/home")).toBeUndefined();
  });
});

describe("transition styles", () => {
  it("moves the old page 10 px one way and the new page in from the other", () => {
    expect(PAGE_TRANSITION_CSS).toContain(
      "::view-transition-old(.tab-forward), ::view-transition-new(.tab-back) { --ready-tab-y: -10px; }",
    );
    expect(PAGE_TRANSITION_CSS).toContain(
      "::view-transition-new(.tab-forward), ::view-transition-old(.tab-back) { --ready-tab-y: 10px; }",
    );
    expect(PAGE_TRANSITION_CSS).toContain("120ms linear both ready-tab-out");
    expect(PAGE_TRANSITION_CSS).toContain("220ms var(--e-out, ease-out) 120ms both ready-tab-in");
  });

  it("with reduced motion keeps the fades and removes the movement", () => {
    const reduced = PAGE_TRANSITION_CSS.split("@media (prefers-reduced-motion: reduce)")[1];
    expect(reduced).toBeTruthy();
    expect(reduced).toContain("--ready-tab-y: 0px");
    expect(reduced).not.toContain("animation");
    expect(reduced).not.toContain("opacity");
  });
});

describe("focusHeading", () => {
  it("adds tabindex only when the heading has none", () => {
    document.body.innerHTML = `<div id="a"><h1>Plain</h1></div><div id="b"><h1 tabindex="0">Set</h1></div>`;
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    expect(focusHeading(a)).toBe(true);
    expect(a.querySelector("h1")!.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(a.querySelector("h1"));
    expect(focusHeading(b)).toBe(true);
    expect(b.querySelector("h1")!.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(b.querySelector("h1"));
    document.body.innerHTML = "";
  });

  it("says so when there is no heading", () => {
    expect(focusHeading(document.createElement("div"))).toBe(false);
  });
});

describe("PageTransition", () => {
  it("leaves focus alone on first load", () => {
    path = "/exams";
    const view = render(<Frame title="Exams" />);
    const heading = view.container.querySelector("h1")!;
    expect(document.activeElement).toBe(document.body);
    expect(heading.hasAttribute("tabindex")).toBe(false);
  });

  it("moves focus to the new heading after a tab change", () => {
    const { heading } = go("/home", "/exams");
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });

  it("does not move focus on Home", () => {
    go("/exams", "/home");
    expect(document.activeElement).toBe(document.body);
  });

  it("does not move focus within one tab", () => {
    go("/exams", "/exams/abc");
    expect(document.activeElement).toBe(document.body);
  });

  it("without View Transitions, fades the new page in", () => {
    const { animate } = go("/home", "/exams");
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][0]).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 220 });
  });

  it("with reduced motion the fallback is still a fade only, 150 ms", () => {
    stubMatchMedia(true);
    const { animate } = go("/home", "/exams");
    expect(animate.mock.calls[0][0]).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 150 });
  });

  it("leaves the fade to the browser when it has View Transitions", () => {
    const doc = document as unknown as { startViewTransition?: unknown };
    doc.startViewTransition = () => {};
    try {
      const { animate } = go("/home", "/exams");
      expect(animate).not.toHaveBeenCalled();
    } finally {
      delete doc.startViewTransition;
    }
  });

  it("does not fade on browser back or forward, but still moves focus", () => {
    const { animate, heading } = go("/home", "/exams", () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(animate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(heading);
  });

  it("a click after a history move makes the next change a normal one", () => {
    const { animate } = go("/home", "/exams", () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
      document.body.click();
    });
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("does not fade under the fast test switch", () => {
    document.documentElement.dataset.fast = "1";
    const { animate } = go("/home", "/exams");
    expect(animate).not.toHaveBeenCalled();
  });
});
