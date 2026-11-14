import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardMcq, PICK_TEXT, PickPrompt, WHY_LABEL, type CardMcqProps } from "./card-mcq";
import {
  BOSS_HEAD,
  BOSS_SUB,
  FeedbackStrip,
  MISS_HEAD,
  MISS_SUB,
  PASS_HEADS,
  SLIPS_HEAD,
  feedbackCopy,
} from "./feedback-strip";

const CARD: CardMcqProps["card"] = {
  q: "Demand for a good is elastic. The price goes up 10%. What happens to revenue?",
  opts: [
    ["It goes up", false],
    ["It goes down", true],
    ["It stays the same", false],
    ["It doubles", false],
  ],
  why: "Elastic means quantity falls by more than 10%, so price times quantity shrinks.",
  source: "Lecture 3, slide 14",
};

beforeEach(() => {
  // Instant motion, so nothing waits on animation frames.
  document.documentElement.dataset.fast = "1";
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
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete document.documentElement.dataset.fast;
});

function key(k: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(document, { key: k, ...init });
}

describe("CardMcq", () => {
  it("labels options A to D and has no why before a pick", () => {
    render(<CardMcq card={CARD} />);
    for (const [i, l] of ["A", "B", "C", "D"].entries()) {
      expect(screen.getByTestId(`mcq-opt-${i}`).textContent).toContain(l);
    }
    expect(screen.queryByTestId("mcq-why")).toBeNull();
  });

  it.each([1, 2, 3, 4])("key %i chooses that option", (n) => {
    const onResult = vi.fn();
    render(<CardMcq card={CARD} onResult={onResult} />);
    key(String(n));
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({ picked: n - 1, right: 1, correct: n === 2, grade: n === 2 ? 3 : 1 });
  });

  it("ignores keys past the last option, modifiers and typing in a field", () => {
    const onResult = vi.fn();
    const three = { ...CARD, opts: CARD.opts.slice(0, 3) };
    render(
      <>
        <input data-testid="field" />
        <CardMcq card={three} onResult={onResult} />
      </>,
    );
    key("4");
    key("5");
    key("1", { metaKey: true });
    fireEvent.keyDown(screen.getByTestId("field"), { key: "1" });
    expect(onResult).not.toHaveBeenCalled();
  });

  it("a right pick marks it right with a check and shows the why and source", () => {
    render(<CardMcq card={CARD} />);
    fireEvent.click(screen.getByTestId("mcq-opt-1"));
    expect(screen.getByTestId("mcq-opt-1").dataset.state).toBe("right");
    expect(screen.getByTestId("mcq-check")).toBeTruthy();
    const why = screen.getByTestId("mcq-why");
    expect(why.textContent).toContain(WHY_LABEL);
    expect(why.textContent).toContain(CARD.why);
    expect(why.textContent).toContain(CARD.source);
  });

  it("a wrong pick marks it wrong and shows the right one", () => {
    render(<CardMcq card={CARD} />);
    key("3");
    expect(screen.getByTestId("mcq-opt-2").dataset.state).toBe("wrong");
    expect(screen.getByTestId("mcq-opt-1").dataset.state).toBe("right");
    expect(screen.getByTestId("mcq-opt-0").dataset.state).toBeUndefined();
  });

  it("ignores a second pick and reports the result once", () => {
    const onResult = vi.fn();
    render(<CardMcq card={CARD} onResult={onResult} />);
    key("1");
    key("2");
    fireEvent.click(screen.getByTestId("mcq-opt-3"));
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0]).toMatchObject({ picked: 0, correct: false });
    expect(screen.getByTestId("mcq-opt-0").dataset.state).toBe("wrong");
    expect(screen.getByTestId("mcq-opt-3").dataset.state).toBeUndefined();
    for (let i = 0; i < 4; i++) expect((screen.getByTestId(`mcq-opt-${i}`) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keys off: only taps choose", () => {
    const onResult = vi.fn();
    render(<CardMcq card={CARD} onResult={onResult} keys={false} />);
    key("2");
    expect(onResult).not.toHaveBeenCalled();
  });

  it("initialPick starts answered without reporting", () => {
    const onResult = vi.fn();
    render(<CardMcq card={CARD} onResult={onResult} initialPick={0} />);
    expect(screen.getByTestId("mcq-opt-0").dataset.state).toBe("wrong");
    key("2");
    expect(onResult).not.toHaveBeenCalled();
  });

  it("PickPrompt says the line", () => {
    render(<PickPrompt />);
    expect(screen.getByTestId("mcq-pick").textContent).toBe(PICK_TEXT);
    expect(PICK_TEXT).toBe("Pick an answer.");
  });
});

describe("feedbackCopy", () => {
  it("cycles the pass headings by cards passed", () => {
    expect(PASS_HEADS).toEqual(["Nice.", "Exactly.", "Yes.", "Spot on."]);
    const heads = [0, 1, 2, 3, 4].map((passed) => feedbackCopy({ grade: 3, concept: "Elasticity", passed }).head);
    expect(heads).toEqual(["Nice.", "Exactly.", "Yes.", "Spot on.", "Nice."]);
  });

  it("right: + concept", () => {
    expect(feedbackCopy({ grade: 3, concept: "Elasticity" })).toEqual({ ok: true, head: "Nice.", line: "+ Elasticity" });
  });

  it("boss: Boss down. and the exam line", () => {
    expect(feedbackCopy({ grade: 3, concept: "Elasticity", boss: true, passed: 2 })).toEqual({
      ok: true,
      head: BOSS_HEAD,
      line: BOSS_SUB,
    });
    expect(BOSS_HEAD).toBe("Boss down.");
    expect(BOSS_SUB).toBe("That is how the exam asks it.");
  });

  it("pass with slips: Got there.", () => {
    expect(feedbackCopy({ grade: 2, concept: "Elasticity" })).toEqual({ ok: true, head: SLIPS_HEAD, line: "+ Elasticity" });
    expect(SLIPS_HEAD).toBe("Got there.");
  });

  it("miss: Not quite. and it comes back", () => {
    expect(feedbackCopy({ grade: 1, concept: "Elasticity", boss: true })).toEqual({ ok: false, head: MISS_HEAD, line: MISS_SUB });
    expect(MISS_HEAD).toBe("Not quite.");
    expect(MISS_SUB).toBe("It comes back in a minute.");
  });

  it("sub overrides the line", () => {
    expect(feedbackCopy({ grade: 3, concept: "X", sub: "Two of three." }).line).toBe("Two of three.");
  });
});

describe("FeedbackStrip", () => {
  it("renders heading, sub line and tone", () => {
    render(<FeedbackStrip grade={1} concept="Elasticity" onContinue={() => {}} />);
    expect(screen.getByTestId("fb-head").textContent).toBe("Not quite.");
    expect(screen.getByTestId("fb-sub").textContent).toBe("It comes back in a minute.");
    expect(screen.getByTestId("fb-strip").dataset.ok).toBeUndefined();
    cleanup();
    render(<FeedbackStrip grade={3} concept="Elasticity" passed={3} onContinue={() => {}} />);
    expect(screen.getByTestId("fb-head").textContent).toBe("Spot on.");
    expect(screen.getByTestId("fb-strip").dataset.ok).toBe("true");
  });

  it("focuses Continue", () => {
    render(<FeedbackStrip grade={3} concept="Elasticity" onContinue={() => {}} />);
    expect(document.activeElement).toBe(screen.getByTestId("fb-continue"));
  });

  it.each(["Enter", " "])("%j continues, once", (k) => {
    const onContinue = vi.fn();
    render(<FeedbackStrip grade={3} concept="Elasticity" onContinue={onContinue} />);
    key(k);
    key(k);
    fireEvent.click(screen.getByTestId("fb-continue"));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("a tap on Continue continues", () => {
    const onContinue = vi.fn();
    render(<FeedbackStrip grade={1} concept="Elasticity" onContinue={onContinue} autoFocus={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("does not auto-advance and ignores other keys", () => {
    vi.useFakeTimers();
    const onContinue = vi.fn();
    render(<FeedbackStrip grade={3} concept="Elasticity" onContinue={onContinue} />);
    key("a");
    key("Escape");
    vi.advanceTimersByTime(10_000);
    expect(onContinue).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
