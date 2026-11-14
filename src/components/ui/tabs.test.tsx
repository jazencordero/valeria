import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tabs, type TabItem } from "./tabs";

const three: TabItem[] = [
  { id: "overview", label: "Overview", content: <p>Overview body</p> },
  { id: "whatif", label: "What if", content: <p>What if body</p> },
  { id: "graded", label: "Graded", content: <p>Graded body</p> },
];

const five: TabItem[] = [
  { id: "today", label: "Today", content: <p>Today body</p> },
  { id: "progress", label: "Progress", content: <p>Progress body</p> },
  { id: "lectures", label: "Lectures", count: 4, content: <p>Lectures body</p> },
  { id: "practise", label: "Practise", content: <p>Practise body</p> },
  { id: "notes", label: "Notes", count: 2, content: <p>Notes body</p> },
];

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

beforeEach(() => {
  document.documentElement.dataset.fast = "1";
  stubMatchMedia();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.fast;
});

function selected() {
  return screen
    .getAllByRole("tab")
    .find((t) => t.getAttribute("aria-selected") === "true");
}

describe("Tabs", () => {
  it("has tablist, tab and tabpanel roles, with only the active tab in the Tab order", () => {
    render(<Tabs tabs={three} />);
    expect(screen.getByRole("tablist", { name: "Sections" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].id);
    expect(tabs[0].getAttribute("aria-controls")).toBe(panel.id);
  });

  it("arrow keys move and wrap", async () => {
    const user = userEvent.setup();
    render(<Tabs tabs={three} />);
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    await user.keyboard("{ArrowLeft}");
    expect(selected()?.textContent).toBe("Graded");
    expect(document.activeElement).toBe(tabs[2]);
    await user.keyboard("{ArrowRight}");
    expect(selected()?.textContent).toBe("Overview");
    expect(document.activeElement).toBe(tabs[0]);
    await user.keyboard("{ArrowRight}");
    expect(selected()?.textContent).toBe("What if");
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("Home and End jump to the ends", async () => {
    const user = userEvent.setup();
    render(<Tabs tabs={five} />);
    screen.getAllByRole("tab")[1].focus();
    await user.keyboard("{End}");
    expect(selected()?.textContent).toBe("Notes 2");
    await user.keyboard("{Home}");
    expect(selected()?.textContent).toBe("Today");
  });

  it("shows only the active panel", async () => {
    const user = userEvent.setup();
    render(<Tabs tabs={three} />);
    const panels = () =>
      Array.from(document.querySelectorAll('[role="tabpanel"]')) as HTMLElement[];
    expect(panels().map((p) => p.hidden)).toEqual([false, true, true]);
    await user.click(screen.getByRole("tab", { name: "Graded" }));
    expect(panels().map((p) => p.hidden)).toEqual([true, true, false]);
    expect(screen.getByRole("tabpanel").textContent).toBe("Graded body");
  });

  it("remembers the chosen tab in sessionStorage", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Tabs tabs={three} memoryKey="gp-demo" />);
    await user.click(screen.getByRole("tab", { name: "What if" }));
    expect(window.sessionStorage.getItem("ready.tabs.gp-demo")).toBe("whatif");
    unmount();
    render(<Tabs tabs={three} memoryKey="gp-demo" />);
    expect(selected()?.textContent).toBe("What if");
    expect(screen.getByRole("tabpanel").textContent).toBe("What if body");
  });

  it("fires onShown the first time each panel appears", async () => {
    const user = userEvent.setup();
    const onShown = vi.fn();
    render(<Tabs tabs={three} onShown={onShown} />);
    expect(onShown).toHaveBeenCalledWith("overview");
    await user.click(screen.getByRole("tab", { name: "What if" }));
    await user.click(screen.getByRole("tab", { name: "Overview" }));
    await user.click(screen.getByRole("tab", { name: "What if" }));
    expect(onShown.mock.calls.map((c) => c[0])).toEqual(["overview", "whatif"]);
  });

  it("shows counts after the label", () => {
    render(<Tabs tabs={five} />);
    expect(screen.getByRole("tab", { name: "Lectures 4" })).toBeTruthy();
  });
});
