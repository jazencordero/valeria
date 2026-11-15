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

describe("Notepad with the tutor (M2-28)", () => {
  function tutorApi() {
    const calls: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(b);
      if (b.mode === "load") return Response.json({ messages: [], deeperAvailable: false });
      const lines = [
        { type: "start", messageMetadata: { model: "groq:openai/gpt-oss-120b", answerId: NOTE_ID, questionId: "q", deeper: false } },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: "PV is today's worth." },
        { type: "text-end", id: "0" },
        { type: "finish" },
      ];
      return new Response(lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join(""), { status: 200 });
    });
    return { calls, api: { fetch: fetch as unknown as typeof globalThis.fetch, writeClipboard: vi.fn(async () => {}) } };
  }

  it("without the switch: no chat and no handles", async () => {
    wide = true;
    render(<NotepadView pathname="/home" actions={fakeActions()} />);
    const pad = await openPad();
    expect(pad.className).toBe("np");
    expect(screen.queryByTestId("tutor-chat")).toBeNull();
    expect(screen.queryAllByRole("separator")).toHaveLength(0);
  });

  it("with the switch on a phone: note on top, chat below, a split handle and no width handle", async () => {
    const { api } = tutorApi();
    render(<NotepadView pathname="/home" actions={fakeActions()} tutor tutorApi={api} />);
    const pad = await openPad();
    expect(pad.getAttribute("aria-modal")).toBe("true");
    expect(pad.querySelector("#np-top")?.contains(body())).toBe(true);
    expect(screen.getByTestId("tutor-chat")).toBeTruthy();
    const split = screen.getByRole("separator", { name: "Resize the note and the tutor" });
    expect(split.getAttribute("aria-valuenow")).toBe("45");
    fireEvent.keyDown(split, { key: "ArrowDown" });
    expect(split.getAttribute("aria-valuenow")).toBe("50");
    fireEvent.keyDown(split, { key: "Home" });
    expect(split.getAttribute("aria-valuenow")).toBe("20");
    expect(screen.queryByTestId("notepad-edge")).toBeNull();
  });

  it("wide: the panel's edge sets the width, 360 px to 70% of the window, remembered", async () => {
    wide = true;
    vi.stubGlobal("innerWidth", 1200);
    const { api } = tutorApi();
    const { unmount } = render(<NotepadView pathname="/home" actions={fakeActions()} tutor tutorApi={api} />);
    let pad = await openPad();
    expect(pad.hasAttribute("aria-modal")).toBe(false);
    const edge = screen.getByRole("separator", { name: "Resize the notes panel" });
    expect(edge.getAttribute("aria-valuenow")).toBe("420");
    expect(edge.getAttribute("aria-valuemax")).toBe("840");
    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(edge.getAttribute("aria-valuenow")).toBe("444");
    expect(pad.style.width).toBe("444px");
    fireEvent.keyDown(edge, { key: "End" });
    expect(edge.getAttribute("aria-valuenow")).toBe("840");
    fireEvent.keyDown(edge, { key: "Home" });
    fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(edge.getAttribute("aria-valuenow")).toBe("360");
    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(localStorage.getItem("ready-notes-width")).toBe("384");
    unmount();

    render(<NotepadView pathname="/home" actions={fakeActions()} tutor tutorApi={api} />);
    pad = await openPad();
    expect(pad.style.width).toBe("384px");
  });

  it("a highlight opens the chat with the starters; Save to note appends the answer to the note and saves it", async () => {
    const { api, calls } = tutorApi();
    const actions = fakeActions();
    render(<NotepadView pathname="/home" actions={actions} tutor tutorApi={api} />);
    act(() => openNotepad({ quote: "PV = FV / (1 + r)^t" }));
    await flush(20);
    fireEvent.change(body(), { target: { value: "My line" } });
    fireEvent.click(screen.getByRole("button", { name: "Explain this simply" }));
    await flush(SAVE_PAUSE_MS);
    await flush(20);
    expect(calls[1]).toEqual({ text: "Explain this simply", where: { kind: "other" }, noteId: NOTE_ID, quote: "PV = FV / (1 + r)^t" });
    fireEvent.click(screen.getByRole("button", { name: "Save to note" }));
    expect((body() as HTMLTextAreaElement).value).toBe("My line\n\nPV is today's worth.");
    await flush(SAVE_PAUSE_MS);
    expect(actions.save).toHaveBeenLastCalledWith(expect.objectContaining({ id: NOTE_ID, body: "My line\n\nPV is today's worth." }));
  });
});

describe("Notepad over a study session (Ask about this card)", () => {
  const SESSION = "/study/5b1d2c3e-0000-4000-8000-000000000001";
  const CARD = "6c2e3d4f-0000-4000-8000-00000000000a";
  const ask = () =>
    act(() => {
      window.dispatchEvent(new CustomEvent("ready:notepad", { detail: { quote: "Q?\n\nAnswer: A.", card: { id: CARD } } }));
    });
  const api = {
    fetch: vi.fn(async () => Response.json({ messages: [], deeperAvailable: false })) as unknown as typeof globalThis.fetch,
    writeClipboard: vi.fn(async () => {}),
  };

  it("without the switch the card ask opens nothing", async () => {
    render(<NotepadView pathname={SESSION} actions={fakeActions()} />);
    ask();
    await flush(20);
    expect(screen.queryByRole("dialog", { name: "Notepad" })).toBeNull();
  });

  it("outside a session the card ask opens nothing", async () => {
    render(<NotepadView pathname="/home" actions={fakeActions()} tutor tutorApi={api} />);
    ask();
    await flush(20);
    expect(screen.queryByRole("dialog", { name: "Notepad" })).toBeNull();
  });

  it("with the switch it opens over the session on the card, takes the inert mark off its layer, and closes when the card goes", async () => {
    render(<NotepadView pathname={SESSION} actions={fakeActions()} tutor tutorApi={api} />);
    await flush(0);
    const layer = document.querySelector<HTMLElement>("[data-notepad-layer]")!;
    layer.inert = true;
    layer.setAttribute("aria-hidden", "true");
    ask();
    await flush(20);
    const pad = screen.getByRole("dialog", { name: "Notepad" });
    expect(pad.className).toBe("np tutor over");
    expect(pad.querySelector(".np-quote")?.textContent).toBe("Q?\n\nAnswer: A.");
    expect(layer.hasAttribute("data-open")).toBe(true);
    expect(layer.inert).toBe(false);
    expect(layer.hasAttribute("aria-hidden")).toBe(false);
    act(() => {
      window.dispatchEvent(new CustomEvent("ready:notepad-card-gone"));
    });
    await flush(400);
    expect(screen.queryByRole("dialog", { name: "Notepad" })).toBeNull();
    expect(layer.hasAttribute("data-open")).toBe(false);
  });

  it("a plain open during a session still closes at once, as before", async () => {
    render(<NotepadView pathname={SESSION} actions={fakeActions()} tutor tutorApi={api} />);
    act(() => openNotepad({ quote: "Something" }));
    await flush(400);
    expect(screen.queryByRole("dialog", { name: "Notepad" })).toBeNull();
  });
});
