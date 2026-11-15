import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_FAILED,
  CHECK_IT,
  CardExplain,
  EXPLAIN_PLACEHOLDER,
  HAD_TAG,
  MISSING_TAG,
  MODEL_ANSWER,
  QUICK_CHECK_NOTE,
  type CardExplainHandle,
  type CardExplainProps,
  type ExplainCheck,
} from "./card-explain";
import { GRADE_GROUP_LABEL } from "./grade-buttons";
import { useSessionKeys } from "./use-session-keys";

// Made-up sample content for tests only.
const CARD: CardExplainProps["card"] = {
  q: "Explain price elasticity of demand in your own words.",
  rubric: [
    ["How much quantity reacts to price", ["quantity", "react"]],
    ["Measured in percentages", ["percent", "%"]],
    ["Elastic when above one", ["above one", "greater than 1"]],
  ],
  model: "It is how strongly the quantity demanded reacts to a price change, in percent. Above one is elastic.",
  source: "Lecture 3, slide 4",
};
const ID = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

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

function setup(props: Partial<CardExplainProps> = {}, check: ExplainCheck = vi.fn()) {
  const onRevealed = vi.fn();
  const onChecked = vi.fn();
  const onGrade = vi.fn();
  const user = userEvent.setup();
  const utils = render(
    <CardExplain
      cardId={ID}
      card={CARD}
      section="learn"
      conceptNames={["Elasticity"]}
      rung={3}
      check={check}
      onRevealed={onRevealed}
      onChecked={onChecked}
      onGrade={onGrade}
      {...props}
    />,
  );
  return { ...utils, user, onRevealed, onChecked, onGrade, check };
}

const box = () => screen.getByPlaceholderText(EXPLAIN_PLACEHOLDER);
const marks = () => within(screen.getByTestId("rubric")).getAllByRole("listitem").map((li) => li.dataset.mark);

describe("CardExplain", () => {
  it("shows the prompt, the textarea and Check it, no rubric yet", () => {
    setup();
    expect(screen.getByRole("heading", { name: CARD.q })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: EXPLAIN_PLACEHOLDER })).toBeTruthy();
    expect(screen.getByRole("button", { name: CHECK_IT })).toBeTruthy();
    expect(screen.queryByTestId("rubric")).toBeNull();
    expect(screen.queryByRole("group", { name: GRADE_GROUP_LABEL })).toBeNull();
  });

  it("empty text: no request, the rubric neutral and unmarked", async () => {
    const check = vi.fn<ExplainCheck>();
    const { user, onChecked } = setup({}, check);
    await user.type(box(), "   ");
    await user.click(screen.getByRole("button", { name: CHECK_IT }));
    expect(check).not.toHaveBeenCalled();
    expect(marks()).toEqual(["neutral", "neutral", "neutral"]);
    expect(screen.queryByText(HAD_TAG)).toBeNull();
    expect(screen.queryByText(MISSING_TAG)).toBeNull();
    expect(screen.getByText(MODEL_ANSWER)).toBeTruthy();
    expect(screen.getByText(CARD.source)).toBeTruthy();
    expect(onChecked).toHaveBeenCalledWith(expect.objectContaining({ rubric: [false, false, false], failed: false }));
  });

  it("marks had and missing from the route's labels", async () => {
    const check = vi.fn<ExplainCheck>().mockResolvedValue({
      had: ["How much quantity reacts to price", "Elastic when above one"],
      missing: ["Measured in percentages"],
      fallback: false,
    });
    const { user, onChecked } = setup({}, check);
    await user.type(box(), "Quantity reacts to price; above one it is elastic.");
    await user.click(screen.getByRole("button", { name: CHECK_IT }));
    expect(await screen.findByTestId("rubric")).toBeTruthy();
    expect(marks()).toEqual(["had", "miss", "had"]);
    expect(screen.getAllByText(HAD_TAG)).toHaveLength(2);
    expect(screen.getAllByText(MISSING_TAG)).toHaveLength(1);
    expect(screen.queryByText(QUICK_CHECK_NOTE)).toBeNull();
    expect(check).toHaveBeenCalledWith(ID, "Quantity reacts to price; above one it is elastic.");
    expect(onChecked).toHaveBeenCalledWith(expect.objectContaining({ rubric: [true, false, true], fallback: false }));
  });

  it("shows Quick check only when the answer is the keyword fallback", async () => {
    const check = vi.fn<ExplainCheck>().mockResolvedValue({
      had: ["Measured in percentages"],
      missing: ["How much quantity reacts to price", "Elastic when above one"],
      fallback: true,
    });
    const { user } = setup({}, check);
    await user.type(box(), "It is in percent.");
    await user.click(screen.getByRole("button", { name: CHECK_IT }));
    expect(await screen.findByText(QUICK_CHECK_NOTE)).toBeTruthy();
    expect(marks()).toEqual(["miss", "had", "miss"]);
  });

  it("sends the request once, even on Cmd+Enter then a click, with the session keys listening", async () => {
    let resolve: (v: Awaited<ReturnType<ExplainCheck>>) => void = () => {};
    const check = vi.fn<ExplainCheck>(() => new Promise((r) => (resolve = r)));
    const onRevealed = vi.fn();
    function Session() {
      const card = useRef<CardExplainHandle>(null);
      useSessionKeys(
        { phase: "front", cardType: "explain", gradeMode: "four" },
        { onCheck: () => card.current?.check() },
      );
      return (
        <CardExplain
          ref={card}
          cardId={ID}
          card={CARD}
          section="learn"
          conceptNames={["Elasticity"]}
          rung={3}
          check={check}
          onRevealed={onRevealed}
          onGrade={() => {}}
        />
      );
    }
    const user = userEvent.setup();
    render(<Session />);
    await user.type(box(), "Quantity reacts.");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.click(screen.getByRole("button", { name: CHECK_IT }));
    expect(check).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ had: [], missing: CARD.rubric.map(([l]) => l), fallback: false }));
    expect(marks()).toEqual(["miss", "miss", "miss"]);
    expect(onRevealed).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Enter in the textarea checks", async () => {
    const check = vi.fn<ExplainCheck>().mockResolvedValue({ had: [], missing: [], fallback: false });
    const { user } = setup({}, check);
    await user.type(box(), "Something.");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(check).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("rubric")).toBeTruthy();
  });

  it("a plain Enter adds a line and does not check", async () => {
    const check = vi.fn<ExplainCheck>();
    const { user } = setup({}, check);
    await user.type(box(), "One{Enter}Two");
    expect(check).not.toHaveBeenCalled();
    expect((box() as HTMLTextAreaElement).value).toBe("One\nTwo");
  });

  it("shows the grade buttons after the check, and she grades", async () => {
    const check = vi.fn<ExplainCheck>().mockResolvedValue({ had: [], missing: [], fallback: false });
    const { user, onGrade, onRevealed } = setup({ gradeMode: "two", next: { 1: "1 min", 3: "3 d" } }, check);
    expect(screen.queryByRole("group", { name: GRADE_GROUP_LABEL })).toBeNull();
    await user.type(box(), "Something.");
    await user.click(screen.getByRole("button", { name: CHECK_IT }));
    const group = await screen.findByRole("group", { name: GRADE_GROUP_LABEL });
    expect(screen.queryByRole("button", { name: CHECK_IT })).toBeNull();
    expect(onRevealed).toHaveBeenCalledTimes(1);
    await user.click(within(group).getByRole("button", { name: /Got it/ }));
    expect(onGrade).toHaveBeenCalledWith(3);
  });

  it("a failed request shows the rubric neutral with a short line", async () => {
    const check = vi.fn<ExplainCheck>().mockRejectedValue(new Error("busy"));
    const { user, onChecked } = setup({}, check);
    await user.type(box(), "Something.");
    await user.click(screen.getByRole("button", { name: CHECK_IT }));
    expect(await screen.findByText(CHECK_FAILED)).toBeTruthy();
    expect(marks()).toEqual(["neutral", "neutral", "neutral"]);
    expect(screen.getByRole("group", { name: GRADE_GROUP_LABEL })).toBeTruthy();
    expect(onChecked).toHaveBeenCalledWith(expect.objectContaining({ failed: true }));
  });
});
