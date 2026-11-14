import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMessage, parseMarkdown } from "@/components/chat/message";
import {
  TYPE_CAP_MS,
  Typewriter,
  capTimeline,
  charDelay,
  planTimeline,
} from "./typewriter";

let reducedMotion = false;

// jsdom has no Web Animations; Vitonen cancels its animations when calm.
if (typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = () => [];
}

beforeEach(() => {
  reducedMotion = false;
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: reducedMotion && query.includes("reduce"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.fast;
});

/** The typed (visible) part of a <Typewriter>. */
function typed(container: HTMLElement): string {
  return container.firstElementChild?.firstElementChild?.textContent ?? "";
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

const LONG = Array.from(
  { length: 12 },
  () => "Holt-Winters wins on A and B, the baseline does better on C.",
).join(" ");

describe("charDelay", () => {
  it("is 14 to 22 ms a character", () => {
    expect(charDelay("a b", 0, 0)).toBe(14);
    expect(charDelay("a b", 0, 1)).toBe(22);
  });

  it("pauses 110 ms after , : ; and 240 ms after . ? ! …", () => {
    for (const ch of [",", ":", ";"]) expect(charDelay(`a${ch} b`, 1, 0)).toBe(14 + 110);
    for (const ch of [".", "?", "!", "…"]) expect(charDelay(`a${ch} b`, 1, 0)).toBe(14 + 240);
  });

  it("goes 0.65x in the middle of long words only", () => {
    // "forecasting": 11 letters, the middle is positions 2 to 8.
    expect(charDelay("forecasting", 5, 0)).toBeCloseTo(14 * 0.65);
    expect(charDelay("forecasting", 1, 0)).toBe(14);
    expect(charDelay("forecasting", 9, 0)).toBe(14);
    // Short words never speed up.
    expect(charDelay("weeks", 2, 0)).toBe(14);
  });
});

describe("planTimeline", () => {
  it("adds 240 ms after a paragraph that does not end a sentence", () => {
    const ends = planTimeline([{ kind: "text", text: "Done." }]);
    const open = planTimeline([{ kind: "text", text: "Done:" }]);
    expect(open.total - ends.total).toBeCloseTo(110);
    expect(open.total).toBeGreaterThan(240);
  });

  it("puts faded blocks 110 ms apart", () => {
    const { at } = planTimeline([{ kind: "reveal", count: 3 }]);
    expect(at).toEqual([0, 110, 220]);
  });

  it("caps the whole message at 2.4 s", () => {
    const plan = planTimeline([{ kind: "text", text: LONG }]);
    expect(plan.total).toBeGreaterThan(TYPE_CAP_MS);
    const capped = capTimeline(plan);
    expect(Math.max(...capped)).toBeLessThan(TYPE_CAP_MS);
    // A short message keeps its natural speed.
    const short = planTimeline([{ kind: "text", text: "Hi." }]);
    expect(capTimeline(short)).toEqual(short.at);
  });
});

describe("Typewriter", () => {
  it("types a long message in no more than 2.4 s", () => {
    const onDone = vi.fn();
    const { container } = render(<Typewriter text={LONG} onDone={onDone} />);
    advance(1200);
    const half = typed(container);
    expect(half.length).toBeGreaterThan(0);
    expect(half.length).toBeLessThan(LONG.length);
    expect(onDone).not.toHaveBeenCalled();
    advance(TYPE_CAP_MS - 1200);
    expect(typed(container)).toBe(LONG);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("types at the natural speed when that is under the cap", () => {
    const { container } = render(<Typewriter text="Where do you want to start?" />);
    advance(60);
    // About 14 to 22 ms a character: a few characters, not the whole line.
    const n = typed(container).length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(6);
  });

  it("pauses after punctuation", () => {
    const { container } = render(<Typewriter text="A, bcdefghijkl" />);
    advance(30);
    expect(typed(container)).toBe("A,");
    advance(100);
    // Still inside the 110 ms pause after the comma.
    expect(typed(container)).toBe("A,");
    advance(30);
    expect(typed(container).length).toBeGreaterThan(2);
  });

  it("is instant when calm", () => {
    reducedMotion = true;
    const onDone = vi.fn();
    const { container } = render(<Typewriter text={LONG} onDone={onDone} />);
    expect(typed(container)).toBe(LONG);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("is instant with the fast test switch", () => {
    document.documentElement.dataset.fast = "1";
    const { container } = render(<Typewriter text={LONG} />);
    expect(typed(container)).toBe(LONG);
  });

  it("finishes on tap", () => {
    const onDone = vi.fn();
    const { container } = render(<Typewriter text={LONG} onDone={onDone} />);
    advance(100);
    expect(typed(container).length).toBeLessThan(LONG.length);
    fireEvent.click(container.firstElementChild as HTMLElement);
    expect(typed(container)).toBe(LONG);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("types only what has arrived while streaming", () => {
    const onDone = vi.fn();
    const first = "Three things, from the brief.";
    const { container, rerender } = render(
      <Typewriter text={first} complete={false} onDone={onDone} />,
    );
    advance(5000);
    expect(typed(container)).toBe(first);
    expect(onDone).not.toHaveBeenCalled();

    const more = `${first} Forecast weeks 45 to 52.`;
    rerender(<Typewriter text={more} complete={false} onDone={onDone} />);
    // Waiting did not count: the new part types (after the 240 ms full stop
    // pause), it does not jump in at once.
    advance(320);
    const partial = typed(container);
    expect(partial.length).toBeGreaterThan(first.length);
    expect(partial.length).toBeLessThan(more.length);

    advance(2000);
    expect(typed(container)).toBe(more);
    expect(onDone).not.toHaveBeenCalled();
    rerender(<Typewriter text={more} complete onDone={onDone} />);
    advance(10);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("AssistantMessage", () => {
  const TABLE = [
    "Done on `weekly_demand.csv`, 104 weeks per product.",
    "",
    "MAPE",
    "| Product | Holt-Winters | Seasonal naive |",
    "|---|---|---|",
    "| A | **6.8%** | 11.2% |",
    "| B | **9.1%** | 9.4% |",
  ].join("\n");

  it("parses paragraphs, lists, tables with a caption, bold and code", () => {
    const blocks = parseMarkdown(`${TABLE}\n\n1. One.\n2. Two.`);
    expect(blocks.map((b) => b.type)).toEqual(["p", "table", "list"]);
    const [p, table] = blocks;
    expect(p.type === "p" && p.spans[1]).toEqual({ text: "weekly_demand.csv", code: true });
    expect(table.type === "table" && table.caption?.[0].text).toBe("MAPE");
    expect(table.type === "table" && table.rows[0][1]).toEqual([{ text: "6.8%", bold: true }]);
  });

  it("fades table rows in 110 ms apart, after the paragraph", () => {
    render(<AssistantMessage text={TABLE} />);
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.className.includes("opacity-0"))).toBe(true);
    advance(TYPE_CAP_MS);
    expect(rows.every((r) => r.className.includes("opacity-100"))).toBe(true);
  });

  it("never renders markdown as HTML", () => {
    reducedMotion = true;
    const { container } = render(
      <AssistantMessage text={'<img src=x onerror="alert(1)"> and **bold**'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  });

  it("shows the typing dots while nothing has arrived yet", () => {
    render(<AssistantMessage text="" complete={false} />);
    expect(screen.getByRole("status", { name: "Ready is writing" })).toBeTruthy();
  });
});
