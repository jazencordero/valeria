import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotepadContextResult, NotepadSaveResult } from "@/app/(app)/notes/actions";
import type { AddCardsResult, ExamChoicesResult } from "@/app/(app)/notes/card-actions";

// The real actions reach the database; the view gets fakes instead.
vi.mock("@/app/(app)/notes/actions", () => ({
  saveNotepad: vi.fn(),
  notepadContext: vi.fn(),
}));
vi.mock("@/app/(app)/notes/card-actions", () => ({
  addCardsFromNote: vi.fn(),
  noteCardExams: vi.fn(),
}));
const toast = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ showToast: toast.show }));

import { COURSE_NO_EXAM, NOTHING_WRITTEN } from "./draft-cards";
import { NotepadView, openNotepad, SAVE_PAUSE_MS, type NotepadActions } from "./notepad";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const ASSIGNMENT = "/assignments/22222222-2222-4222-8222-222222222222";

let wide = false;

beforeEach(() => {
  document.documentElement.dataset.fast = "1";
  wide = false;
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("min-width: 700px") ? wide : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  toast.show.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.fast;
  localStorage.clear();
});

function fakeActions(
  save?: NotepadActions["save"],
  more: { label?: string; add?: AddCardsResult; exams?: ExamChoicesResult } = {},
) {
  const saveFn = vi.fn<NotepadActions["save"]>(
    save ?? (async (input) => ({ ok: true, id: input.id ?? NOTE_ID }) as NotepadSaveResult),
  );
  const contextFn = vi.fn<NotepadActions["context"]>(
    async () => ({ ok: true, label: more.label ?? "Case memo 2" }) as NotepadContextResult,
  );
  const addCards = vi.fn<NotepadActions["addCards"]>(
    async (_id, cards) => more.add ?? { ok: true, added: cards.length, skipped: 0, course: "Strategic IT Management" },
  );
  const exams = vi.fn<NotepadActions["exams"]>(async () => more.exams ?? { ok: true, exams: [] });
  return { save: saveFn, context: contextFn, addCards, exams };
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function openPad() {
  fireEvent.click(screen.getByRole("button", { name: "Notes, open the notepad" }));
  await flush(20);
  return screen.getByRole("dialog", { name: "Notepad" });
}

const body = () => screen.getByRole("textbox", { name: "Note" });
const title = () => screen.getByRole("textbox", { name: "Title" });

describe("Notepad", () => {
  it("attaches a new note to the page it was started on", async () => {
    const actions = fakeActions();
    render(<NotepadView pathname={ASSIGNMENT} actions={actions} />);
    await openPad();
    expect(actions.context).toHaveBeenCalledWith(ASSIGNMENT);
    expect(screen.getByTestId("notepad-chip").textContent).toBe("Case memo 2");
    fireEvent.change(body(), { target: { value: "Ask about the rubric" } });
    await flush(SAVE_PAUSE_MS);
    expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({ path: ASSIGNMENT, body: "Ask about the rubric" }));
  });

  it("discards an empty note on close", async () => {
    const actions = fakeActions();
    render(<NotepadView pathname="/home" actions={actions} />);
    await openPad();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await flush(1000);
    expect(screen.queryByRole("dialog")).toBeNull();

    // Typed, then wiped before the pause: still nothing stored.
    await openPad();
    fireEvent.change(title(), { target: { value: "x" } });
    fireEvent.change(title(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Close notepad" }));
    await flush(5000);
    expect(actions.save).not.toHaveBeenCalled();
  });

  it("a stored note emptied before closing is sent empty, so it is deleted", async () => {
    const actions = fakeActions(async () => ({ ok: true, id: NOTE_ID }));
    render(<NotepadView pathname="/home" actions={actions} />);
    await openPad();
    fireEvent.change(body(), { target: { value: "hello" } });
    await flush(SAVE_PAUSE_MS);
    fireEvent.change(body(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await flush(0);
    expect(actions.save).toHaveBeenCalledTimes(2);
    expect(actions.save).toHaveBeenLastCalledWith(expect.objectContaining({ id: NOTE_ID, title: "", body: "" }));
  });

  it("sends one save per pause, then says Saved", async () => {
    const actions = fakeActions();
    render(<NotepadView pathname="/home" actions={actions} />);
    await openPad();
    for (const v of ["T", "Th", "The", "The m", "The mi", "The mix"]) {
      fireEvent.change(body(), { target: { value: v } });
      await flush(200);
    }
    expect(actions.save).not.toHaveBeenCalled();
    expect(screen.getByTestId("notepad-saved").textContent).toBe("");
    await flush(SAVE_PAUSE_MS - 200);
    expect(actions.save).toHaveBeenCalledTimes(1);
    expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({ body: "The mix", path: "/home" }));
    expect(screen.getByTestId("notepad-saved").textContent).toBe("Saved");

    // The next pause updates the same note.
    fireEvent.change(body(), { target: { value: "The mix matters" } });
    expect(screen.getByTestId("notepad-saved").textContent).toBe("");
    await flush(SAVE_PAUSE_MS);
    expect(actions.save).toHaveBeenCalledTimes(2);
    expect(actions.save).toHaveBeenLastCalledWith(expect.objectContaining({ id: NOTE_ID, body: "The mix matters" }));
  });

  it("shows Not saved yet when a save fails, and retries", async () => {
    let calls = 0;
    const actions = fakeActions(async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return { ok: true, id: NOTE_ID };
    });
    render(<NotepadView pathname="/home" actions={actions} />);
    await openPad();
    fireEvent.change(body(), { target: { value: "Bring the calculator" } });
    await flush(SAVE_PAUSE_MS);
    expect(screen.getByTestId("notepad-saved").textContent).toBe("Not saved yet");
    await flush(2000);
    expect(actions.save).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("notepad-saved").textContent).toBe("Saved");
  });

  it("N opens a new note, but not while she types in a field", async () => {
    const actions = fakeActions();
    render(
      <>
        <input aria-label="Search" />
        <NotepadView pathname="/home" actions={actions} />
      </>,
    );
    const search = screen.getByRole("textbox", { name: "Search" });
    search.focus();
    fireEvent.keyDown(search, { key: "n" });
    await flush(20);
    expect(screen.queryByRole("dialog")).toBeNull();

    search.blur();
    fireEvent.keyDown(document.body, { key: "n" });
    await flush(20);
    expect(screen.getByRole("dialog", { name: "Notepad" })).toBeTruthy();

    // Typing an n in the note itself is just a letter.
    fireEvent.keyDown(body(), { key: "n" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("Escape closes the drawer", async () => {
    render(<NotepadView pathname="/home" actions={fakeActions()} />);
    await openPad();
    fireEvent.keyDown(title(), { key: "Escape" });
    await flush(1000);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a modal sheet on phones and a side panel from 700 px", async () => {
    const { unmount } = render(<NotepadView pathname="/home" actions={fakeActions()} />);
    let pad = await openPad();
    expect(pad.getAttribute("data-layout")).toBe("bottom");
    expect(pad.getAttribute("aria-modal")).toBe("true");
    unmount();

    wide = true;
    render(<NotepadView pathname="/home" actions={fakeActions()} />);
    pad = await openPad();
    expect(pad.getAttribute("data-layout")).toBe("side");
    expect(pad.hasAttribute("aria-modal")).toBe(false);
  });

  it("hides the button during a study session and while the drawer is open", async () => {
    const { rerender } = render(<NotepadView pathname="/study/abc" actions={fakeActions()} />);
    expect(screen.queryByRole("button", { name: "Notes, open the notepad" })).toBeNull();
    rerender(<NotepadView pathname="/home" actions={fakeActions()} />);
    await openPad();
    expect(screen.queryByRole("button", { name: "Notes, open the notepad" })).toBeNull();
  });

  it("List starts the line with a dash, Highlight toggles the marker", async () => {
    const actions = fakeActions();
    render(<NotepadView pathname="/home" actions={actions} />);
    await openPad();
    fireEvent.click(screen.getByRole("button", { name: "• List" }));
    await flush(20);
    expect((body() as HTMLTextAreaElement).value).toBe("- ");
    const hl = screen.getByRole("button", { name: "Highlight" });
    fireEvent.click(hl);
    expect(hl.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows Notes on the button the first time Home appears on a wide screen, then folds", async () => {
    wide = true;
    render(<NotepadView pathname="/home" actions={fakeActions()} />);
    await flush(10);
    expect(screen.getByRole("button", { name: "Notes, open the notepad" }).textContent).toContain("Notes");
    await flush(4500);
    expect(screen.getByRole("button", { name: "Notes, open the notepad" }).textContent).not.toContain("Notes");
    expect(localStorage.getItem("ready-notes-hint")).toBe("1");
  });
});

describe("Notepad: Turn into cards", () => {
  const turn = () => fireEvent.click(screen.getByRole("button", { name: "Turn into cards" }));
  const field = (name: string, n = 0) => screen.getAllByLabelText(name)[n] as HTMLInputElement;

  it("drafts up to three editable cards and adds the real count", async () => {
    const actions = fakeActions();
    render(<NotepadView pathname="/courses/33333333-3333-4333-8333-333333333333" actions={actions} />);
    await openPad();
    fireEvent.change(body(), {
      target: { value: "- SLA: the promised service level\n\nTCO - total cost of ownership\nVendor lock-in\nFourth line" },
    });
    turn();
    await flush(200);
    expect(screen.getByText("DRAFT CARDS")).toBeTruthy();
    expect(field("CARD 1 · FRONT").value).toBe("SLA");
    expect(field("BACK", 0).value).toBe("the promised service level");
    expect(field("CARD 2 · FRONT").value).toBe("TCO");
    expect(field("CARD 3 · FRONT").value).toBe("Explain: Vendor lock-in");
    expect(field("BACK", 2).value).toBe("Vendor lock-in");
    expect(screen.queryByLabelText("CARD 4 · FRONT")).toBeNull();
    expect(screen.getByRole("button", { name: "Add 3 cards" })).toBeTruthy();

    // An emptied front is skipped, and the button says so.
    fireEvent.change(field("CARD 2 · FRONT"), { target: { value: " " } });
    fireEvent.change(field("BACK", 0), { target: { value: "service level, in writing" } });
    fireEvent.click(screen.getByRole("button", { name: "Add 2 cards" }));
    await flush(50);
    // The note is stored first (no waiting for the pause), then the cards.
    expect(actions.save).toHaveBeenCalledTimes(1);
    expect(actions.addCards).toHaveBeenCalledWith(
      NOTE_ID,
      [
        { front: "SLA", back: "service level, in writing" },
        { front: "Explain: Vendor lock-in", back: "Vendor lock-in" },
      ],
      undefined,
    );
    expect(toast.show).toHaveBeenCalledWith("Added to Strategic IT Management. First review today.");
    expect(screen.queryByTestId("draft-cards")).toBeNull();
  });

  it("with nothing written, says each line becomes a card", async () => {
    const actions = fakeActions();
    render(<NotepadView pathname="/home" actions={actions} />);
    await openPad();
    turn();
    await flush(20);
    expect(screen.getByText(NOTHING_WRITTEN)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Add/ })).toBeNull();
  });

  it("a course with no exam: nothing added, no toast, a link to add one", async () => {
    const actions = fakeActions(undefined, { add: { ok: false, reason: "no_exam" } });
    render(<NotepadView pathname="/courses/33333333-3333-4333-8333-333333333333" actions={actions} />);
    await openPad();
    fireEvent.change(body(), { target: { value: "SLA: service level" } });
    turn();
    await flush(20);
    fireEvent.click(screen.getByRole("button", { name: "Add 1 card" }));
    await flush(50);
    expect(screen.getByTestId("draft-no-exam").textContent).toContain(COURSE_NO_EXAM);
    expect(screen.getByRole("link", { name: "Add an exam" }).getAttribute("href")).toBe("/exams");
    expect(toast.show).not.toHaveBeenCalled();
    // The drafts stay, so nothing she typed is lost.
    expect(field("CARD 1 · FRONT").value).toBe("SLA");
  });

  it("a General note asks which exam first", async () => {
    const actions = fakeActions(undefined, {
      label: "General",
      exams: {
        ok: true,
        exams: [
          { id: "44444444-4444-4444-8444-444444444444", label: "Final · Strategic IT Management" },
          { id: "55555555-5555-4555-8555-555555555555", label: "Quiz 4 · Forecasting Methods" },
        ],
      },
    });
    render(<NotepadView pathname="/home" actions={actions} />);
    await openPad();
    fireEvent.change(body(), { target: { value: "SLA: service level" } });
    turn();
    await flush(20);
    const add = screen.getByRole("button", { name: "Add 1 card" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Which exam?"), { target: { value: "55555555-5555-4555-8555-555555555555" } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await flush(50);
    expect(actions.addCards).toHaveBeenCalledWith(
      NOTE_ID,
      [{ front: "SLA", back: "service level" }],
      "55555555-5555-4555-8555-555555555555",
    );
  });

  it("cards she already has: no toast, and it says so", async () => {
    const actions = fakeActions(undefined, { add: { ok: true, added: 0, skipped: 1, course: "X" } });
    render(<NotepadView pathname="/courses/33333333-3333-4333-8333-333333333333" actions={actions} />);
    await openPad();
    fireEvent.change(body(), { target: { value: "SLA: service level" } });
    turn();
    await flush(20);
    fireEvent.click(screen.getByRole("button", { name: "Add 1 card" }));
    await flush(50);
    expect(toast.show).not.toHaveBeenCalled();
    expect(screen.getByTestId("draft-message").textContent).toBe("You already have this card.");
  });

  it("opens a stored note with the drafts showing", async () => {
    const actions = fakeActions();
    render(<NotepadView pathname="/notes" actions={actions} />);
    act(() => {
      openNotepad({
        note: { id: NOTE_ID, title: "Week 5", body: "SLA: service level", quote: null, highlighted: false, label: "Lecture 5 · Sourcing" },
        cards: true,
      });
    });
    await flush(200);
    expect(field("CARD 1 · FRONT").value).toBe("SLA");
    fireEvent.click(screen.getByRole("button", { name: "Add 1 card" }));
    await flush(50);
    expect(actions.save).not.toHaveBeenCalled();
    expect(actions.addCards).toHaveBeenCalledWith(NOTE_ID, [{ front: "SLA", back: "service level" }], undefined);
  });
});
