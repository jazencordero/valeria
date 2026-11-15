/*
 * M9-16: select text in a lecture to start a note. Runs in jsdom: selection,
 * the "Add note" button, the quote it hands on, and stored highlights
 * re-applied by matching the text.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADD_NOTE, applyHighlights, canNote, placeButton, quoteOf, SelectNote } from "./select-note";

const FIRST = "Working memory holds about four chunks at once.";
const SECOND = "Rehearsal keeps an item there longer.";

function Harness({
  active = true,
  highlights = [],
  onAdd = () => {},
}: {
  active?: boolean;
  highlights?: readonly string[];
  onAdd?: (q: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={ref} className="relative">
      <article className="lec-body" aria-label="Lecture text">
        <section>
          <h2>Memory</h2>
          <p data-testid="p1">{FIRST}</p>
          <p data-testid="p2">{SECOND}</p>
        </section>
      </article>
      <p data-testid="outside">Outside the lecture text.</p>
      <SelectNote containerRef={ref} active={active} highlights={highlights} onAdd={onAdd} />
    </div>
  );
}

function textOf(testId: string): Text {
  return screen.getByTestId(testId).firstChild as Text;
}

/** Selects [start, end) of a text node (or across two) and fires selectionchange. */
function select(startNode: Text, start: number, endNode: Text = startNode, end: number = start) {
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(startNode, start);
  r.setEnd(endNode, end);
  sel.addRange(r);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
  return r;
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  cleanup();
  vi.unstubAllGlobals();
});

describe("quoteOf / canNote", () => {
  it("collapses whitespace and needs more than two characters", () => {
    expect(quoteOf("  a\n\n  b  ")).toBe("a b");
    expect(canNote("ab")).toBe(false);
    expect(canNote("  ab \n")).toBe(false);
    expect(canNote("abc")).toBe(true);
  });
});

describe("placeButton", () => {
  const box = { top: 0, bottom: 1000, left: 0, width: 600 };
  it("goes above the selection, below it on touch or near the top", () => {
    const sel = { top: 400, bottom: 420, left: 100, width: 200 };
    expect(placeButton(sel, box, false)).toMatchObject({ below: false, top: 400 - 56, left: 140 });
    expect(placeButton(sel, box, true)).toMatchObject({ below: true, top: 430 });
    expect(placeButton({ ...sel, top: 40, bottom: 60 }, box, false).below).toBe(true);
  });
  it("stays inside the container", () => {
    expect(placeButton({ top: 400, bottom: 420, left: 590, width: 10 }, box, false).left).toBe(480);
    expect(placeButton({ top: 400, bottom: 420, left: 0, width: 10 }, box, false).left).toBe(0);
  });
});

describe("SelectNote", () => {
  it("does nothing for two characters", () => {
    render(<Harness />);
    select(textOf("p1"), 0, textOf("p1"), 2);
    expect(screen.queryByRole("button", { name: ADD_NOTE })).toBeNull();
  });

  it("shows Add note for a longer selection inside the lecture text only", () => {
    render(<Harness />);
    select(textOf("outside"), 0, textOf("outside"), 10);
    expect(screen.queryByRole("button", { name: ADD_NOTE })).toBeNull();
    select(textOf("p1"), 0, textOf("p1"), 14);
    expect(screen.getByRole("button", { name: ADD_NOTE })).toBeTruthy();
  });

  it("shows nothing outside Read view", () => {
    render(<Harness active={false} />);
    select(textOf("p1"), 0, textOf("p1"), FIRST.length);
    expect(screen.queryByRole("button", { name: ADD_NOTE })).toBeNull();
  });

  it("hands on the selection as the quote and marks it", () => {
    const onAdd = vi.fn();
    render(<Harness onAdd={onAdd} />);
    select(textOf("p1"), 0, textOf("p1"), FIRST.length);
    const btn = screen.getByRole("button", { name: ADD_NOTE });
    fireEvent.pointerDown(btn);
    fireEvent.click(btn);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(FIRST);
    const marks = document.querySelectorAll("mark.hl");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe(FIRST);
    expect(screen.queryByRole("button", { name: ADD_NOTE })).toBeNull();
  });

  it("quotes part of a sentence exactly, and a selection across paragraphs", () => {
    const onAdd = vi.fn();
    render(<Harness onAdd={onAdd} />);
    select(textOf("p1"), 15, textOf("p1"), 30);
    fireEvent.click(screen.getByRole("button", { name: ADD_NOTE }));
    expect(onAdd).toHaveBeenLastCalledWith(FIRST.slice(15, 30));
    expect(screen.getByTestId("p1").textContent).toBe(FIRST);

    select(textOf("p2"), 0, textOf("p2"), 9);
    fireEvent.click(screen.getByRole("button", { name: ADD_NOTE }));
    expect(onAdd).toHaveBeenLastCalledWith("Rehearsal");
  });

  it("re-applies a stored highlight by matching the text", () => {
    const stored = "four chunks";
    render(<Harness highlights={[stored]} />);
    const marks = document.querySelectorAll<HTMLElement>("mark.hl");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe(stored);
    expect(marks[0].dataset.quote).toBe(stored);
    expect(screen.getByTestId("p1").textContent).toBe(FIRST);
  });

  it("re-applies one that runs across paragraphs, and only once", () => {
    const stored = "at once.Rehearsal keeps";
    const { rerender } = render(<Harness highlights={[stored]} />);
    const marks = () => Array.from(document.querySelectorAll<HTMLElement>("mark.hl"));
    expect(marks().map((m) => m.textContent).join("")).toBe(stored);
    rerender(<Harness highlights={[stored, "not in this lecture"]} />);
    expect(marks().map((m) => m.textContent).join("")).toBe(stored);
    const art = document.querySelector<HTMLElement>("article.lec-body")!;
    expect(applyHighlights(art, [stored])).toBe(0);
  });
});
