import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GradeButtons, GRADE_GROUP_LABEL } from "./grade-buttons";
import {
  sessionKeyAction,
  STOP_CONFIRM_SELECTOR,
  useSessionKeys,
  type SessionKeyHandlers,
  type SessionKeyState,
} from "./use-session-keys";

afterEach(cleanup);

function Harness({ state, handlers, children }: { state: SessionKeyState; handlers: SessionKeyHandlers; children?: React.ReactNode }) {
  useSessionKeys(state, handlers);
  return <div>{children}</div>;
}

function spies() {
  return { onReveal: vi.fn(), onChoose: vi.fn(), onGrade: vi.fn(), onContinue: vi.fn(), onCheck: vi.fn() };
}

const press = (key: string, init: KeyboardEventInit = {}, target: Element | Document = document) =>
  fireEvent.keyDown(target, { key, ...init });

function only(h: ReturnType<typeof spies>, name: keyof ReturnType<typeof spies> | null) {
  for (const [k, fn] of Object.entries(h)) {
    if (k === name) expect(fn, k).toHaveBeenCalledTimes(1);
    else expect(fn, k).not.toHaveBeenCalled();
  }
}

describe("useSessionKeys: one case per row of the key table", () => {
  it.each([
    ["front basic", { phase: "front", cardType: "basic", gradeMode: "four" }, " ", "onReveal", undefined],
    ["front basic", { phase: "front", cardType: "basic", gradeMode: "four" }, "Enter", "onReveal", undefined],
    ["front cloze", { phase: "front", cardType: "cloze", gradeMode: "two" }, " ", "onReveal", undefined],
    ["front cloze", { phase: "front", cardType: "cloze", gradeMode: "two" }, "Enter", "onReveal", undefined],
    ["front mcq", { phase: "front", cardType: "mcq", gradeMode: "four" }, "1", "onChoose", 0],
    ["front mcq", { phase: "front", cardType: "mcq", gradeMode: "four" }, "4", "onChoose", 3],
    ["graded four", { phase: "graded", cardType: "basic", gradeMode: "four" }, "1", "onGrade", 1],
    ["graded four", { phase: "graded", cardType: "basic", gradeMode: "four" }, "2", "onGrade", 2],
    ["graded four", { phase: "graded", cardType: "basic", gradeMode: "four" }, "3", "onGrade", 3],
    ["graded four", { phase: "graded", cardType: "basic", gradeMode: "four" }, "4", "onGrade", 4],
    ["graded two", { phase: "graded", cardType: "basic", gradeMode: "two" }, "1", "onGrade", 1],
    ["graded two", { phase: "graded", cardType: "basic", gradeMode: "two" }, "2", "onGrade", 3],
    ["fb", { phase: "fb", cardType: "mcq", gradeMode: "four" }, "Enter", "onContinue", undefined],
    ["fb", { phase: "fb", cardType: "mcq", gradeMode: "four" }, " ", "onContinue", undefined],
  ] as const)("%s: %j fires %s", (_name, state, key, handler, arg) => {
    const h = spies();
    render(<Harness state={state} handlers={h} />);
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    only(h, handler);
    if (arg !== undefined) expect(h[handler]).toHaveBeenCalledWith(arg);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("does nothing for keys that have no meaning in the state", () => {
    const cases: [SessionKeyState, string][] = [
      [{ phase: "graded", cardType: "basic", gradeMode: "two" }, "3"],
      [{ phase: "graded", cardType: "basic", gradeMode: "two" }, "4"],
      [{ phase: "graded", cardType: "basic", gradeMode: "four" }, " "],
      [{ phase: "front", cardType: "basic", gradeMode: "four" }, "1"],
      [{ phase: "front", cardType: "mcq", gradeMode: "four" }, " "],
      [{ phase: "front", cardType: "match", gradeMode: "four" }, "Enter"],
      [{ phase: "front", cardType: "explain", gradeMode: "four" }, " "],
      [{ phase: "fb", cardType: "mcq", gradeMode: "four" }, "1"],
      [{ phase: "done", gradeMode: "four" }, "Enter"],
      [{ phase: "graded", cardType: "basic", gradeMode: "four" }, "5"],
    ];
    for (const [state, key] of cases) {
      const h = spies();
      const { unmount } = render(<Harness state={state} handlers={h} />);
      press(key);
      only(h, null);
      unmount();
    }
  });

  it("leaves Escape to the frame", () => {
    const h = spies();
    render(<Harness state={{ phase: "graded", cardType: "basic", gradeMode: "four" }} handlers={h} />);
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    only(h, null);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("is silent while the frame's stop confirm is open", () => {
    const h = spies();
    render(
      <Harness state={{ phase: "graded", cardType: "basic", gradeMode: "four" }} handlers={h}>
        <div role="group" aria-label="Stop the session?" />
      </Harness>,
    );
    expect(document.querySelector(STOP_CONFIRM_SELECTOR)).not.toBeNull();
    press("3");
    press("Enter");
    only(h, null);
  });

  it("is silent when the caller pauses it", () => {
    const h = spies();
    render(<Harness state={{ phase: "graded", cardType: "basic", gradeMode: "four", paused: true }} handlers={h} />);
    press("3");
    only(h, null);
  });
});

describe("typing guard", () => {
  it.each(["textarea", "input"] as const)("never fires while typing in a %s", (tag) => {
    const h = spies();
    render(
      <Harness state={{ phase: "front", cardType: "basic", gradeMode: "four" }} handlers={h}>
        {tag === "textarea" ? <textarea data-testid="field" /> : <input data-testid="field" />}
      </Harness>,
    );
    const field = screen.getByTestId("field");
    for (const key of [" ", "Enter", "1", "2", "3", "4"]) press(key, {}, field);
    only(h, null);
  });

  it("fires nothing for digits in a textarea while graded", () => {
    const h = spies();
    render(
      <Harness state={{ phase: "graded", cardType: "explain", gradeMode: "two" }} handlers={h}>
        <textarea data-testid="field" />
      </Harness>,
    );
    press("1", {}, screen.getByTestId("field"));
    only(h, null);
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])("Cmd/Ctrl + Enter in the textarea checks (%j)", (mod) => {
    const h = spies();
    render(
      <Harness state={{ phase: "front", cardType: "explain", gradeMode: "four" }} handlers={h}>
        <textarea data-testid="field" />
      </Harness>,
    );
    const field = screen.getByTestId("field");
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...mod });
    field.dispatchEvent(ev);
    only(h, "onCheck");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("Cmd/Ctrl + Enter outside a text field does nothing", () => {
    const h = spies();
    render(<Harness state={{ phase: "front", cardType: "basic", gradeMode: "four" }} handlers={h} />);
    press("Enter", { metaKey: true });
    press("Enter", { ctrlKey: true });
    only(h, null);
  });
});

describe("guards", () => {
  const graded: SessionKeyState = { phase: "graded", cardType: "basic", gradeMode: "four" };

  it("ignores events already defaultPrevented", () => {
    const h = spies();
    render(<Harness state={graded} handlers={h} />);
    const ev = new KeyboardEvent("keydown", { key: "3", bubbles: true, cancelable: true });
    ev.preventDefault();
    document.dispatchEvent(ev);
    only(h, null);
  });

  it.each([{ altKey: true }, { shiftKey: true }, { metaKey: true }, { ctrlKey: true }])("ignores modifiers %j", (mod) => {
    const h = spies();
    render(<Harness state={graded} handlers={h} />);
    press("3", mod);
    only(h, null);
  });

  it("ignores key repeats", () => {
    const h = spies();
    render(<Harness state={graded} handlers={h} />);
    press("3", { repeat: true });
    only(h, null);
  });

  it("a focused button other than reveal keeps Space and Enter", () => {
    const h = spies();
    render(
      <Harness state={{ phase: "front", cardType: "cloze", gradeMode: "four" }} handlers={h}>
        <button data-testid="other">Hint</button>
        <button data-testid="blank" data-blank="">
          ___
        </button>
        <button data-testid="reveal" data-reveal="">
          Show answer
        </button>
      </Harness>,
    );
    press("Enter", {}, screen.getByTestId("other"));
    expect(h.onReveal).not.toHaveBeenCalled();
    press("Enter", {}, screen.getByTestId("blank"));
    press(" ", {}, screen.getByTestId("reveal"));
    expect(h.onReveal).toHaveBeenCalledTimes(2);
  });

  it("sessionKeyAction is pure and maps two-button 1/2 to grades 1/3", () => {
    const base = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, repeat: false, isComposing: false, target: null };
    const s: SessionKeyState = { phase: "graded", gradeMode: "two", cardType: "basic" };
    expect(sessionKeyAction({ ...base, key: "1" }, s)).toEqual({ type: "grade", g: 1 });
    expect(sessionKeyAction({ ...base, key: "2" }, s)).toEqual({ type: "grade", g: 3 });
    expect(sessionKeyAction({ ...base, key: "3" }, s)).toBeNull();
  });
});

describe("GradeButtons", () => {
  it("two-button mode: Missed and Got it with their intervals, focus on Got it", () => {
    const onGrade = vi.fn();
    render(<GradeButtons mode="two" next={{ 1: "1 min", 3: "3 d" }} onGrade={onGrade} />);
    const group = screen.getByRole("group", { name: GRADE_GROUP_LABEL });
    const buttons = group.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toBe("Missedagain in 1 min");
    expect(buttons[1].textContent).toBe("Got itnext in 3 d");
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(onGrade.mock.calls).toEqual([[1], [3]]);
  });

  it("four-button mode: Again, Hard, Good, Easy with next in, focus on Good", () => {
    const onGrade = vi.fn();
    const MIN = 60_000;
    render(
      <GradeButtons mode="four" next={{ 1: "1 min", 2: 6 * MIN, 3: 3 * 1440 * MIN, 4: "8 d" }} onGrade={onGrade} />,
    );
    const buttons = screen.getByRole("group", { name: GRADE_GROUP_LABEL }).querySelectorAll("button");
    expect([...buttons].map((b) => b.textContent)).toEqual([
      "Againnext in 1 min",
      "Hardnext in 6 min",
      "Goodnext in 3 d",
      "Easynext in 8 d",
    ]);
    expect(document.activeElement).toBe(buttons[2]);
    buttons.forEach((b) => fireEvent.click(b));
    expect(onGrade.mock.calls).toEqual([[1], [2], [3], [4]]);
  });

  it("keys and buttons together: 1/2 in two-button mode grade 1 and 3", () => {
    function Session() {
      const [log, setLog] = useState<number[]>([]);
      useSessionKeys({ phase: "graded", cardType: "basic", gradeMode: "two" }, { onGrade: (g) => setLog((l) => [...l, g]) });
      return (
        <>
          <GradeButtons mode="two" next={{ 1: "1 min", 3: "3 d" }} onGrade={() => {}} />
          <p data-testid="log">{log.join(",")}</p>
        </>
      );
    }
    render(<Session />);
    press("1", {}, document.activeElement ?? document);
    press("2", {}, document.activeElement ?? document);
    expect(screen.getByTestId("log").textContent).toBe("1,3");
  });
});
