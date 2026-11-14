import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CardMatch,
  MATCH_PROMPT,
  MatchPrompt,
  WRONG_MS,
  matchGrade,
  matchSub,
  type CardMatchProps,
} from "./card-match";
import { FeedbackStrip, SLIPS_HEAD } from "./feedback-strip";

const CARD: CardMatchProps["card"] = {
  q: "Match each word to what it means.",
  pairs: [
    ["Elastic", "Quantity reacts a lot to price"],
    ["Inelastic", "Quantity barely reacts to price"],
    ["Substitute", "A good bought instead of another"],
  ],
  order: [2, 0, 1],
};

beforeEach(() => {
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

const term = (k: number) => screen.getByTestId(`match-term-${k}`) as HTMLButtonElement;
const meaning = (k: number) => screen.getByTestId(`match-meaning-${k}`) as HTMLButtonElement;
const tap = (el: HTMLElement) => fireEvent.click(el);
const pair = (l: number, r: number) => {
  tap(term(l));
  tap(meaning(r));
};

describe("matchSub and matchGrade", () => {
  it("grades 3 with no slips and 2 with any", () => {
    expect(matchGrade(0)).toBe(3);
    expect(matchGrade(1)).toBe(2);
    expect(matchGrade(4)).toBe(2);
  });
  it("says the slips in a sentence", () => {
    expect(matchSub(0)).toBeUndefined();
    expect(matchSub(1)).toBe("1 slip. Close enough to move on.");
    expect(matchSub(3)).toBe("3 slips. Close enough to move on.");
  });
});

describe("CardMatch", () => {
  it("shows terms on the left and meanings in the card's order on the right", () => {
    render(<CardMatch card={CARD} />);
    const left = screen.getByTestId("match-terms").querySelectorAll("button");
    const right = screen.getByTestId("match-meanings").querySelectorAll("button");
    expect([...left].map((b) => b.textContent)).toEqual(["Elastic", "Inelastic", "Substitute"]);
    expect([...right].map((b) => b.textContent)).toEqual([
      "A good bought instead of another",
      "Quantity reacts a lot to price",
      "Quantity barely reacts to price",
    ]);
  });

  it("has the prompt line", () => {
    render(<MatchPrompt />);
    expect(screen.getByTestId("match-prompt").textContent).toBe(MATCH_PROMPT);
    expect(MATCH_PROMPT).toBe("Tap a term, then what it means.");
  });

  it("selects a term, and a second tap on it lets go", () => {
    render(<CardMatch card={CARD} />);
    tap(term(0));
    expect(term(0).dataset.state).toBe("sel");
    expect(term(0).getAttribute("aria-pressed")).toBe("true");
    tap(term(1));
    expect(term(0).dataset.state).toBeUndefined();
    expect(term(1).dataset.state).toBe("sel");
    tap(term(1));
    expect(term(1).dataset.state).toBeUndefined();
  });

  it("a meaning first does nothing but wiggle: no slip, no selection", () => {
    render(<CardMatch card={CARD} />);
    tap(meaning(0));
    expect(meaning(0).dataset.state).toBeUndefined();
    expect(screen.getByTestId("card-match").dataset.slips).toBe("0");
  });

  it("a right pair turns mint, is disabled and cannot be picked again", () => {
    const onResult = vi.fn();
    render(<CardMatch card={CARD} onResult={onResult} />);
    pair(0, 0);
    expect(term(0).dataset.state).toBe("ok");
    expect(meaning(0).dataset.state).toBe("ok");
    expect(term(0).disabled).toBe(true);
    expect(meaning(0).disabled).toBe(true);

    // Picking it again (even if a click got through) changes nothing.
    tap(term(0));
    expect(term(0).dataset.state).toBe("ok");
    tap(term(1));
    tap(meaning(0));
    expect(term(1).dataset.state).toBe("sel");
    expect(screen.getByTestId("card-match").dataset.slips).toBe("0");
    expect(onResult).not.toHaveBeenCalled();
  });

  it("a wrong pair is marked for 420 ms and counts a slip", () => {
    vi.useFakeTimers();
    render(<CardMatch card={CARD} />);
    pair(0, 1);
    expect(term(0).dataset.state).toBe("bad");
    expect(meaning(1).dataset.state).toBe("bad");
    expect(screen.getByTestId("card-match").dataset.slips).toBe("1");
    act(() => vi.advanceTimersByTime(WRONG_MS - 1));
    expect(term(0).dataset.state).toBe("bad");
    act(() => vi.advanceTimersByTime(1));
    expect(term(0).dataset.state).toBeUndefined();
    expect(meaning(1).dataset.state).toBeUndefined();
    // Nothing stays selected after a miss.
    tap(meaning(2));
    expect(screen.getByTestId("card-match").dataset.slips).toBe("1");
  });

  it("all right first time reports grade 3 with no slips, once", () => {
    const onResult = vi.fn();
    render(<CardMatch card={CARD} onResult={onResult} />);
    pair(0, 0);
    pair(1, 1);
    pair(2, 2);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({ slips: 0, grade: 3 });
    expect(screen.getByTestId("card-match").dataset.done).toBe("true");
    for (const k of [0, 1, 2]) expect(term(k).disabled).toBe(true);
  });

  it("counts every slip and reports grade 2", () => {
    vi.useFakeTimers();
    const onResult = vi.fn();
    render(<CardMatch card={CARD} onResult={onResult} />);
    pair(0, 1);
    pair(0, 2);
    act(() => vi.advanceTimersByTime(WRONG_MS));
    pair(0, 0);
    pair(2, 1);
    pair(1, 1);
    pair(2, 2);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({ slips: 3, grade: 2 });
    expect(matchSub(onResult.mock.calls[0][0].slips)).toBe("3 slips. Close enough to move on.");
  });

  it("the feedback strip reads 'Got there.' with the slip line", () => {
    render(<FeedbackStrip grade={2} concept="Price elasticity" sub={matchSub(2)} onContinue={() => {}} keys={false} />);
    expect(screen.getByTestId("fb-head").textContent).toBe(SLIPS_HEAD);
    expect(screen.getByTestId("fb-sub").textContent).toBe("2 slips. Close enough to move on.");
  });

  it("works from the keyboard: buttons in tab order, focus moves to the next open term", () => {
    render(<CardMatch card={CARD} />);
    for (const b of screen.getAllByRole("button")) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.getAttribute("type")).toBe("button");
    }
    term(0).focus();
    pair(0, 0);
    expect(document.activeElement).toBe(term(1));
  });

  it("previews start from the given state without reporting", () => {
    const onResult = vi.fn();
    const { unmount } = render(
      <CardMatch card={CARD} initialMatched={[0]} initialSelected={1} initialWrong={[2, 1]} initialSlips={1} onResult={onResult} />,
    );
    expect(term(0).dataset.state).toBe("ok");
    expect(term(1).dataset.state).toBe("sel");
    expect(meaning(1).dataset.state).toBe("bad");
    unmount();
    render(<CardMatch card={CARD} initialMatched={[0, 1, 2]} initialSlips={2} onResult={onResult} />);
    expect(screen.getByTestId("card-match").dataset.done).toBe("true");
    expect(onResult).not.toHaveBeenCalled();
  });
});
