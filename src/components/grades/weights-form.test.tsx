import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHOOLS } from "@/lib/schools";
import {
  formatTenths,
  NeedsWeightsCard,
  parsePercent,
  WeightsForm,
  type SaveWeightsAction,
  type WeightsFormItem,
} from "./weights-form";

// Made-up sample data.
const LMS = SCHOOLS.aalto.lms;
const COURSE = { id: "c0000000-0000-4000-8000-000000000001", name: "Sample Course" };
const ITEMS: WeightsFormItem[] = [
  { id: "a0000000-0000-4000-8000-000000000001", name: "Assignment 1", weight: 0.2 },
  { id: "a0000000-0000-4000-8000-000000000002", name: "Week 3 quiz", weight: null },
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

function setup(action: SaveWeightsAction = vi.fn(async () => ({ ok: true as const }))) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <WeightsForm
      open
      onClose={onClose}
      course={COURSE}
      items={ITEMS}
      lmsName={LMS}
      action={action}
      onSaved={onSaved}
    />,
  );
  return { action, onClose, onSaved, user: userEvent.setup() };
}

const save = () => screen.getByRole("button", { name: "Save" });
const total = () => screen.getByRole("status");

describe("parsePercent", () => {
  it("reads whole numbers, one decimal and a comma, in tenths", () => {
    expect(parsePercent("20")).toBe(200);
    expect(parsePercent(" 12.5 ")).toBe(125);
    expect(parsePercent("12,5")).toBe(125);
    expect(parsePercent("0")).toBe(0);
    expect(parsePercent("100")).toBe(1000);
    expect(parsePercent("")).toBe("empty");
  });

  it("refuses more than one decimal, more than 100 and words", () => {
    expect(parsePercent("12.55")).toBe("bad");
    expect(parsePercent("100.1")).toBe("bad");
    expect(parsePercent("-5")).toBe("bad");
    expect(parsePercent("abc")).toBe("bad");
  });

  it("formats tenths for people", () => {
    expect(formatTenths(200)).toBe("20");
    expect(formatTenths(125)).toBe("12.5");
  });
});

describe("WeightsForm", () => {
  it("lists each piece with its weight in percent, and the total", () => {
    setup();
    expect(screen.getByLabelText("Assignment 1")).toHaveProperty("value", "20");
    expect(screen.getByLabelText("Week 3 quiz")).toHaveProperty("value", "");
    expect(total().textContent).toContain("Total 20%");
    expect(total().textContent).toContain("80% still to place.");
  });

  it("keeps Save disabled until the total is exactly 100", async () => {
    const { user, action } = setup();
    expect(save()).toHaveProperty("disabled", true);

    await user.type(screen.getByLabelText("Week 3 quiz"), "70");
    expect(total().textContent).toContain("Total 90%");
    expect(save()).toHaveProperty("disabled", true);

    await user.clear(screen.getByLabelText("Week 3 quiz"));
    await user.type(screen.getByLabelText("Week 3 quiz"), "90");
    expect(total().textContent).toContain("Total 110%");
    expect(total().textContent).toContain("10% too much.");
    expect(save()).toHaveProperty("disabled", true);

    await user.click(save());
    expect(action).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText("Week 3 quiz"));
    await user.type(screen.getByLabelText("Week 3 quiz"), "80");
    expect(total().textContent).toContain("Adds up to 100%.");
    expect(save()).toHaveProperty("disabled", false);
  });

  it("marks a bad number and blocks Save", async () => {
    const { user } = setup();
    const quiz = screen.getByLabelText("Week 3 quiz");
    await user.type(quiz, "79.95");
    expect(quiz.getAttribute("aria-invalid")).toBe("true");
    const describedBy = quiz.getAttribute("aria-describedby");
    expect(describedBy && document.getElementById(describedBy)?.textContent).toContain("at most one decimal");
    expect(save()).toHaveProperty("disabled", true);
  });

  it("adding a piece updates the total, and Save sends every row", async () => {
    const { user, action, onSaved, onClose } = setup();
    await user.type(screen.getByLabelText("Week 3 quiz"), "20");
    expect(total().textContent).toContain("Total 40%");

    await user.click(screen.getByRole("button", { name: `Add a piece that is not in ${LMS} yet` }));
    // Focus goes to the new name field.
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Exam");
    await user.type(screen.getByLabelText("Exam percent"), "60");
    expect(total().textContent).toContain("Total 100%");
    expect(save()).toHaveProperty("disabled", false);

    await user.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(action).toHaveBeenCalledWith(COURSE.id, [
      { kind: "item", id: ITEMS[0].id, percent: 20 },
      { kind: "item", id: ITEMS[1].id, percent: 20 },
      { kind: "new", name: "Exam", percent: 60 },
    ]);
    expect(onSaved).toHaveBeenCalled();
  });

  it("an added piece needs a name before Save", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Week 3 quiz"), "20");
    await user.click(screen.getByRole("button", { name: `Add a piece that is not in ${LMS} yet` }));
    await user.type(screen.getByLabelText("New piece percent"), "60");
    expect(total().textContent).toContain("Give every added piece a name.");
    expect(save()).toHaveProperty("disabled", true);

    await user.click(screen.getByRole("button", { name: "Remove this piece" }));
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(total().textContent).toContain("Total 40%");
  });

  it("works from the keyboard alone", async () => {
    const { user, action } = setup();
    // Focus starts in the sheet; tab to the first field.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Assignment 1"));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Week 3 quiz"));
    await user.keyboard("10");
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: `Add a piece that is not in ${LMS} yet` }),
    );
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    await user.keyboard("Exam");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Exam percent"));
    await user.keyboard("70{Enter}");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledWith(COURSE.id, [
      { kind: "item", id: ITEMS[0].id, percent: 20 },
      { kind: "item", id: ITEMS[1].id, percent: 10 },
      { kind: "new", name: "Exam", percent: 70 },
    ]);
  });

  it("Enter does nothing while the total is not 100", async () => {
    const { user, action } = setup();
    await user.type(screen.getByLabelText("Week 3 quiz"), "50{Enter}");
    expect(action).not.toHaveBeenCalled();
  });

  it("announces a failed save and stays open", async () => {
    const action = vi.fn(async () => ({ ok: false as const, message: "That course is not in your list any more." }));
    const { user, onClose } = setup(action);
    await user.type(screen.getByLabelText("Week 3 quiz"), "80");
    await user.click(save());
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That course is not in your list any more.");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("NeedsWeightsCard", () => {
  it("says what to do and opens the sheet", async () => {
    const user = userEvent.setup();
    render(
      <NeedsWeightsCard
        course={COURSE}
        items={ITEMS}
        lmsName={LMS}
        action={vi.fn(async () => ({ ok: true as const }))}
      />,
    );
    expect(screen.getByText("Add the weights from the syllabus to see where this is heading.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add the weights" }));
    expect(screen.getByRole("dialog", { name: "How much each piece counts" })).toBeTruthy();
    expect(screen.getByLabelText("Assignment 1")).toBeTruthy();
  });
});
