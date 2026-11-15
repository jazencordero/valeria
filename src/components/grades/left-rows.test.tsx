import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GradedList, type RowItem } from "./graded-list";
import { LeftRows } from "./left-rows";
import type { WhatIfs } from "@/lib/grades/model";

// Made-up sample course: 90% and 74% graded (82% so far), two items left.
const SOME: RowItem[] = [
  { id: "a1", name: "Assignment 1", weight: 0.1, score: 90 },
  { id: "a2", name: "Assignment 2", weight: 0.1, score: 74 },
  { id: "a3", name: "Assignment 3", weight: 0.2, score: null, when: "Fri 21 Nov", handedIn: true },
  { id: "ex", name: "Exam", weight: 0.6, score: null, when: "Exam week" },
];

const NONE: RowItem[] = [
  { id: "p1", name: "Problem sets", weight: 0.4, score: null },
  { id: "ex", name: "Exam", weight: 0.6, score: null, when: "Exam week" },
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.fast;
});

/** A page that keeps what-ifs in memory, as the grade page will. */
function Page({ items, onRelease }: { items: RowItem[]; onRelease?: (id: string, v: number) => void }) {
  const [whatIfs, setWhatIfs] = useState<WhatIfs>({});
  return (
    <LeftRows
      items={items}
      whatIfs={whatIfs}
      onRelease={(id, v) => {
        onRelease?.(id, v);
        setWhatIfs((w) => ({ ...w, [id]: v }));
      }}
      onReset={() => setWhatIfs({})}
    />
  );
}

const slider = (name: string) => screen.getByRole("slider", { name: `What-if score for ${name}` });
const text = (id: string) => screen.getByTestId(id).textContent;

describe("LeftRows", () => {
  it("shows one row per ungraded item with meta, swing and MATTERS MOST", () => {
    render(<Page items={SOME} />);
    expect(screen.getByRole("heading", { name: "What is left" })).toBeTruthy();
    expect(screen.queryByTestId("left-a1")).toBeNull();
    const exam = within(screen.getByTestId("left-ex"));
    expect(exam.getByText("60% of the grade · Exam week")).toBeTruthy();
    expect(exam.getByTestId("matters-most").textContent).toBe("MATTERS MOST");
    expect(within(screen.getByTestId("left-a3")).queryByTestId("matters-most")).toBeNull();
    // Assignment 3 held at 82%: exam at 50% is 62.8% (2.3), at 100% capped at 5.0.
    expect(text("swing-ex")).toBe("grade 2.3 to 5.0");
    expect(text("reading-ex")).toBe("if you score 82%");
    expect(slider("Exam").getAttribute("aria-valuetext")).toBe("82%");
    expect(screen.queryByRole("button", { name: "Reset what-ifs" })).toBeNull();
  });

  it("updates the reading and the swing live while dragging, and releases once", () => {
    const onRelease = vi.fn();
    render(<Page items={SOME} onRelease={onRelease} />);
    const a3 = slider("Assignment 3");
    fireEvent.pointerDown(a3);
    fireEvent.input(a3, { target: { value: "40" } });
    fireEvent.input(a3, { target: { value: "0" } });
    expect(text("reading-a3")).toBe("if you score 0%");
    expect(a3.getAttribute("aria-valuetext")).toBe("0%");
    // Assignment 3 at 0%: exam at 50% is 46.4% (under 50%, so 0.0), at 100% 76.4% (3.6).
    expect(text("swing-ex")).toBe("grade 0.0 to 3.6");
    expect(onRelease).not.toHaveBeenCalled();

    fireEvent.pointerUp(a3);
    // The browser's change event at the end of the same drag must not release again.
    fireEvent.change(a3, { target: { value: "0" } });
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledWith("a3", 0);
    expect(text("reading-a3")).toBe("if you score 0%");
    expect(text("swing-ex")).toBe("grade 0.0 to 3.6");
  });

  it("releases once for a keyboard step", async () => {
    const user = userEvent.setup();
    const onRelease = vi.fn();
    render(<Page items={SOME} onRelease={onRelease} />);
    await user.tab();
    const a3 = slider("Assignment 3");
    expect(document.activeElement).toBe(a3);
    // jsdom does not step a range on arrow keys; do what the browser does:
    // keydown, input with the new value, change, keyup.
    fireEvent.keyDown(a3, { key: "ArrowRight" });
    fireEvent.input(a3, { target: { value: "83" } });
    expect(text("reading-a3")).toBe("if you score 83%");
    fireEvent.change(a3, { target: { value: "83" } });
    fireEvent.keyUp(a3, { key: "ArrowRight" });
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledWith("a3", 83);
  });

  it("needs a what-if first when nothing is graded, and the other swing appears once one is set", () => {
    render(<Page items={NONE} />);
    expect(text("swing-p1")).toBe("needs a what-if first");
    expect(text("swing-ex")).toBe("needs a what-if first");
    expect(text("reading-p1")).toBe("drag to try a score");
    // With nothing to compare, the heavier item matters most.
    expect(within(screen.getByTestId("left-ex")).getByTestId("matters-most")).toBeTruthy();

    fireEvent.input(slider("Problem sets"), { target: { value: "70" } });
    expect(text("reading-p1")).toBe("if you score 70%");
    expect(text("reading-ex")).toBe("drag to try a score");
    // Problem sets held at 70% (28): exam 50% is 58% (1.8), 100% is 88% (4.8).
    expect(text("swing-ex")).toBe("grade 1.8 to 4.8");
    expect(text("swing-p1")).toBe("needs a what-if first");
  });

  it("shows Reset what-ifs once a slider moved, and reset clears and hides it", async () => {
    const user = userEvent.setup();
    render(<Page items={SOME} />);
    const a3 = slider("Assignment 3");
    fireEvent.input(a3, { target: { value: "10" } });
    fireEvent.pointerUp(a3);
    const reset = screen.getByRole("button", { name: "Reset what-ifs" });
    await user.click(reset);
    expect(screen.queryByRole("button", { name: "Reset what-ifs" })).toBeNull();
    expect(text("reading-a3")).toBe("if you score 82%");
    expect((slider("Assignment 3") as HTMLInputElement).value).toBe("82");
    expect(text("swing-ex")).toBe("grade 2.3 to 5.0");
  });

  it("renders nothing when everything is graded", () => {
    const { container } = render(
      <LeftRows items={SOME.slice(0, 2)} whatIfs={{}} onRelease={() => {}} onReset={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("GradedList", () => {
  it("lists graded and still-to-come rows, with handed-in items waiting", () => {
    render(<GradedList items={SOME} />);
    expect(screen.getByTestId("row-a1").textContent).toBe("Assignment 1 · 10% · 90%");
    expect(screen.getByTestId("row-ex").textContent).toBe("Exam · 60% · Exam week");
    expect(screen.getByTestId("row-a3").textContent).toBe(
      "Assignment 3 · 20% · Handed in, waiting for a grade",
    );
    expect(screen.getByRole("heading", { name: "Still to come" })).toBeTruthy();
  });

  it("says Nothing graded yet.", () => {
    render(<GradedList items={NONE} />);
    expect(screen.getByText("Nothing graded yet.")).toBeTruthy();
  });
});
