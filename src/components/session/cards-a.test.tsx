import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardBasic, SHOW_ANSWER } from "./card-basic";
import { BLANK_LABEL, CardCloze, SHOW_NEXT_WORD, clozeParts } from "./card-cloze";
import { revealHint } from "./card-head";

// Made-up sample content for tests only.
const BASIC = {
  q: "What happens to quantity demanded when the price rises?",
  a: "It falls, all else equal.",
  source: "Lecture 2, slide 7",
};
const CLOZE = {
  q: "A good is {{price elastic}} when demand changes more than the {{price}} does, as with {{luxuries}}.",
  source: "Lecture 3, slide 4",
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
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.fast;
});

function basic(props: Partial<Parameters<typeof CardBasic>[0]> = {}) {
  const onRevealed = vi.fn();
  const user = userEvent.setup();
  const utils = render(
    <>
      <button type="button">Other</button>
      <CardBasic card={BASIC} section="learn" conceptNames={["Demand"]} rung={2} onRevealed={onRevealed} {...props} />
    </>,
  );
  return { ...utils, onRevealed, user };
}

function cloze(props: Partial<Parameters<typeof CardCloze>[0]> = {}) {
  const onRevealed = vi.fn();
  const user = userEvent.setup();
  const utils = render(
    <>
      <button type="button">Other</button>
      <CardCloze card={CLOZE} section="warm" conceptNames={["Elasticity", "Demand"]} rung={1} onRevealed={onRevealed} {...props} />
    </>,
  );
  return { ...utils, onRevealed, user };
}

/** The visible words of each blank, in order: "…" while closed. */
function blanks(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-blank]"), (el) => (el.hasAttribute("data-open") ? el.textContent ?? "" : "…"));
}

describe("CardBasic", () => {
  it("shows the head, the question and Show answer; the answer is hidden", () => {
    basic();
    expect(screen.getByTestId("sc-label").textContent).toBe("NEWDEMAND");
    expect(screen.getByRole("heading", { name: BASIC.q })).toBeTruthy();
    expect(screen.getByRole("button", { name: SHOW_ANSWER })).toBeTruthy();
    expect(screen.queryByText(BASIC.a)).toBeNull();
    expect(screen.queryByTestId("src-chip")).toBeNull();
  });

  it("reveals the answer with its source chip, and fires once", async () => {
    const { onRevealed, user } = basic();
    await user.click(screen.getByRole("button", { name: SHOW_ANSWER }));
    expect(screen.getByText(BASIC.a)).toBeTruthy();
    expect(screen.getByTestId("src-chip").textContent).toBe(BASIC.source);
    expect(screen.queryByRole("button", { name: SHOW_ANSWER })).toBeNull();
    await user.keyboard(" ");
    await user.keyboard(" ");
    expect(onRevealed).toHaveBeenCalledTimes(1);
  });

  it("Space reveals when focus is not on another button", async () => {
    const { onRevealed, user } = basic();
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard(" ");
    expect(screen.getByText(BASIC.a)).toBeTruthy();
    expect(onRevealed).toHaveBeenCalledTimes(1);
  });

  it("Space does nothing when focus is on another button", async () => {
    const { onRevealed, user } = basic();
    screen.getByRole("button", { name: "Other" }).focus();
    await user.keyboard(" ");
    expect(screen.queryByText(BASIC.a)).toBeNull();
    expect(onRevealed).not.toHaveBeenCalled();
  });

  it("Space on the focused Show answer button reveals once, not twice", async () => {
    const { onRevealed, user } = basic({ autoFocus: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: SHOW_ANSWER }));
    await user.keyboard(" ");
    expect(screen.getByText(BASIC.a)).toBeTruthy();
    expect(onRevealed).toHaveBeenCalledTimes(1);
  });

  it("ignores Space when keyboard is off", async () => {
    const { onRevealed, user } = basic({ keyboard: false });
    await user.keyboard(" ");
    expect(onRevealed).not.toHaveBeenCalled();
  });

  it("boss cards get the boss label and no pips", () => {
    const { container } = basic({ section: "boss", conceptNames: ["Demand", "Supply"] });
    expect(screen.getByTestId("sc-label").textContent).toBe("BOSS QUESTIONDEMAND + SUPPLY");
    expect(container.querySelector("[data-rung]")).toBeNull();
  });

  it("puts the main button into actionsEl when given", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    basic({ actionsEl: target });
    expect(target.querySelector("button")?.textContent).toContain(SHOW_ANSWER);
    target.remove();
  });
});

describe("clozeParts", () => {
  it("splits text and numbered blanks", () => {
    expect(clozeParts("A {{b c}} d {{e}}")).toEqual([
      { text: "A " },
      { blank: "b c", index: 0 },
      { text: " d " },
      { blank: "e", index: 1 },
    ]);
  });
});

describe("CardCloze", () => {
  it("shows each blank as a button reading … with the reveal label", () => {
    const { container } = cloze();
    const buttons = screen.getAllByRole("button", { name: BLANK_LABEL });
    expect(buttons).toHaveLength(3);
    buttons.forEach((b) => expect(b.textContent).toBe("…"));
    expect(blanks(container)).toEqual(["…", "…", "…"]);
    expect(screen.getByTestId("sc-label").textContent).toBe("WARM-UPELASTICITY + DEMAND");
  });

  it("Show next word opens the blanks in order, then the source chip, and fires once", async () => {
    const { container, onRevealed, user } = cloze();
    const next = () => screen.getByRole("button", { name: SHOW_NEXT_WORD });

    await user.click(next());
    expect(blanks(container)).toEqual(["price elastic", "…", "…"]);
    expect(onRevealed).not.toHaveBeenCalled();
    expect(screen.queryByTestId("src-chip")).toBeNull();

    await user.click(next());
    expect(blanks(container)).toEqual(["price elastic", "price", "…"]);

    await user.click(next());
    expect(blanks(container)).toEqual(["price elastic", "price", "luxuries"]);
    expect(screen.getByTestId("src-chip").textContent).toBe(CLOZE.source);
    expect(screen.queryByRole("button", { name: SHOW_NEXT_WORD })).toBeNull();
    expect(onRevealed).toHaveBeenCalledTimes(1);

    await user.keyboard(" ");
    expect(onRevealed).toHaveBeenCalledTimes(1);
  });

  it("each word of an opened phrase is its own underlined span", async () => {
    const { container, user } = cloze();
    await user.click(screen.getByRole("button", { name: SHOW_NEXT_WORD }));
    const words = container.querySelectorAll("[data-open] .border-accent");
    expect(Array.from(words, (w) => w.textContent)).toEqual(["price", "elastic"]);
  });

  it("Space opens the next blank when focus is not on another button", async () => {
    const { container, onRevealed, user } = cloze();
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard(" ");
    expect(blanks(container)).toEqual(["price elastic", "…", "…"]);
    await user.keyboard(" ");
    await user.keyboard(" ");
    expect(blanks(container)).toEqual(["price elastic", "price", "luxuries"]);
    expect(onRevealed).toHaveBeenCalledTimes(1);
  });

  it("Space does nothing when focus is on another button", async () => {
    const { container, onRevealed, user } = cloze();
    screen.getByRole("button", { name: "Other" }).focus();
    await user.keyboard(" ");
    expect(blanks(container)).toEqual(["…", "…", "…"]);
    expect(onRevealed).not.toHaveBeenCalled();
  });

  it("tapping a blank opens that one and moves focus to the next closed blank", async () => {
    const { container, user } = cloze();
    const [, second] = screen.getAllByRole("button", { name: BLANK_LABEL });
    second.focus();
    await user.keyboard(" ");
    expect(blanks(container)).toEqual(["…", "price", "…"]);
    expect(document.activeElement?.getAttribute("data-blank")).toBe("0");
    // Show next word still goes in order from the first closed blank.
    await user.click(screen.getByRole("button", { name: SHOW_NEXT_WORD }));
    expect(blanks(container)).toEqual(["price elastic", "price", "…"]);
  });
});

describe("revealHint", () => {
  it("matches the prototype copy", () => {
    expect(revealHint()).toBe("Space to reveal · 1–4 to grade");
    expect(revealHint(true)).toBe("Space to reveal · 1 or 2 to grade");
  });
});

describe("line breaks and why (M3-55)", () => {
  const SIX = "max z = 3x + 2y\ns.t. x + y <= 4\nx + 3y <= 6\nx <= 3\nx >= 0\ny >= 0";
  const WHY = "Each line is one constraint.\nThe last two keep it feasible.\nSo the model is complete.";

  it("a six-line basic answer keeps its six lines", async () => {
    const { user } = basic({ card: { ...BASIC, a: SIX } });
    await user.click(screen.getByRole("button", { name: SHOW_ANSWER }));
    const answer = screen.getByText((_, el) => el?.tagName === "P" && el.textContent === SIX);
    expect(answer.textContent!.split("\n")).toHaveLength(6);
    expect(answer.className).toContain("whitespace-pre-line");
  });

  it("shows the why on a basic card after reveal, with its line breaks", async () => {
    const { user } = basic({ card: { ...BASIC, why: WHY } });
    expect(screen.queryByTestId("sc-why")).toBeNull();
    await user.click(screen.getByRole("button", { name: SHOW_ANSWER }));
    const why = screen.getByTestId("sc-why");
    expect(why.textContent).toBe(`Why. ${WHY}`);
    expect(why.className).toContain("whitespace-pre-line");
  });

  it("shows no why line on a basic card without one", async () => {
    const { user } = basic();
    await user.click(screen.getByRole("button", { name: SHOW_ANSWER }));
    expect(screen.queryByTestId("sc-why")).toBeNull();
  });

  it("shows the why on a fill-the-gap card once every blank is open", async () => {
    const { user } = cloze({ card: { ...CLOZE, why: WHY } });
    expect(screen.queryByTestId("sc-why")).toBeNull();
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole("button", { name: SHOW_NEXT_WORD }));
    expect(screen.getByTestId("sc-why").textContent).toBe(`Why. ${WHY}`);
  });

  it("shows no why line on a fill-the-gap card without one", async () => {
    const { user } = cloze();
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole("button", { name: SHOW_NEXT_WORD }));
    expect(screen.queryByTestId("sc-why")).toBeNull();
  });
});
