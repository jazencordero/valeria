import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotepadSaveResult } from "@/app/(app)/notes/actions";

// The real notes action reaches the database; the tests pass fake actions instead.
vi.mock("@/app/(app)/notes/actions", () => ({ saveNotepad: vi.fn() }));
const nav = vi.hoisted(() => ({ path: "/home" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));

import { GRADE_GROUP_LABEL } from "@/components/session/grade-buttons";
import {
  askTutor,
  COPIED_LINE,
  EMPTY_LINE,
  noteTitle,
  problemFor,
  RESTING_LINE,
  STOPPED_LINE,
  Tutor,
  TutorView,
  whereFromPage,
  type TutorActions,
  type TutorViewProps,
} from "./tutor";

const C = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";
const K = "33333333-3333-4333-8333-333333333333";

let wide = false;

beforeEach(() => {
  wide = false;
  nav.path = "/home";
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("1100px") ? wide : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  delete document.documentElement.dataset.tutor;
});

/** A UI message stream with `words` as text deltas. */
function streamResponse(words: string[], error = false): Response {
  const lines = [
    { type: "start" },
    { type: "text-start", id: "0" },
    ...words.map((delta) => ({ type: "text-delta", id: "0", delta })),
    ...(error ? [{ type: "error", errorText: "The answer stopped early. Try again." }] : [{ type: "text-end", id: "0" }, { type: "finish" }]),
  ];
  const body = lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fakeActions(over: Partial<TutorActions> = {}) {
  return {
    ask: vi.fn<TutorActions["ask"]>(async (_body, onText) => {
      onText("Present value is");
      onText("Present value is what money later is worth now.");
      return { ok: true };
    }),
    copyText: vi.fn<TutorActions["copyText"]>(async () => ({ text: "PROMPT-TEXT", note: null })),
    saveNote: vi.fn<TutorActions["saveNote"]>(async () => ({ ok: true, id: C }) as NotepadSaveResult),
    writeClipboard: vi.fn<TutorActions["writeClipboard"]>(async () => {}),
    ...over,
  } satisfies TutorActions;
}

async function openTutor() {
  fireEvent.click(await screen.findByTestId("tutor-button"));
  return screen.getByRole("dialog", { name: "Tutor" });
}

function type(text: string) {
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: text } });
}

describe("Tutor (wired)", () => {
  it("renders nothing for a user without the switch: no button", async () => {
    render(<Tutor enabled={false} actions={fakeActions()} />);
    await act(async () => {});
    expect(screen.queryByTestId("tutor-button")).toBeNull();
    expect(document.querySelector("[data-tutor-host]")).toBeNull();
  });

  it("with the switch: one named button that opens the drawer, empty at first", async () => {
    render(<Tutor enabled actions={fakeActions()} />);
    expect(await screen.findByRole("button", { name: "Tutor, ask a question" })).toBeTruthy();
    const dialog = await openTutor();
    expect(dialog.textContent).toContain(EMPTY_LINE);
    expect(document.activeElement).toBe(screen.getByLabelText("Your question"));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("tutor-button"));
  });

  it("sends her message with where she is and shows the streamed answer", async () => {
    nav.path = `/courses/${C}/lectures/3`;
    window.history.pushState({}, "", `/courses/${C}/lectures/3`);
    const actions = fakeActions();
    render(<Tutor enabled actions={actions} />);
    await openTutor();
    type("What is present value?");
    fireEvent.click(screen.getByTestId("tutor-send"));
    await waitFor(() => expect(screen.getByTestId("tutor-answer").textContent).toContain("what money later is worth now."));
    expect(screen.getByTestId("tutor-mine").textContent).toContain("What is present value?");
    expect(actions.ask).toHaveBeenCalledWith(
      { text: "What is present value?", where: { kind: "lecture", courseId: C, n: 3, section: 0 }, history: [] },
      expect.any(Function),
    );
    expect((screen.getByLabelText("Your question") as HTMLTextAreaElement).value).toBe("");
    window.history.pushState({}, "", "/");
  });

  it("every provider busy: the resting line, her text kept in the box, nothing about limits", async () => {
    const actions = fakeActions({ ask: vi.fn(async () => ({ ok: false as const, line: RESTING_LINE })) });
    render(<Tutor enabled actions={actions} />);
    await openTutor();
    type("Explain annuities");
    fireEvent.click(screen.getByTestId("tutor-send"));
    await waitFor(() => expect(screen.getByTestId("tutor-status").textContent).toBe("The tutor is resting. Try again in a minute."));
    expect((screen.getByLabelText("Your question") as HTMLTextAreaElement).value).toBe("Explain annuities");
    expect(screen.queryByTestId("tutor-mine")).toBeNull();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/left today|limit/i);
  });

  it("Copy for Claude puts the prompt on her clipboard and sends nothing else", async () => {
    const actions = fakeActions({ copyText: vi.fn(async () => ({ text: "PROMPT-TEXT", note: "Copied without course text: no." })) });
    render(<Tutor enabled actions={actions} />);
    await openTutor();
    type("my topic");
    fireEvent.click(screen.getByTestId("tutor-copy"));
    await waitFor(() => expect(actions.writeClipboard).toHaveBeenCalledWith("PROMPT-TEXT"));
    expect(actions.copyText).toHaveBeenCalledWith({ text: "my topic", where: { kind: "other" } });
    expect(actions.ask).not.toHaveBeenCalled();
    expect(screen.getByTestId("tutor-status").textContent).toBe(`${COPIED_LINE} Copied without course text: no.`);
  });

  it("Save to notes stores the answer attached to the page she is on", async () => {
    window.history.pushState({}, "", `/exams/${S}`);
    const actions = fakeActions();
    render(<Tutor enabled actions={actions} />);
    await openTutor();
    type("What is NPV?");
    fireEvent.click(screen.getByTestId("tutor-send"));
    const save = await screen.findByRole("button", { name: "Save to notes" });
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByTestId("tutor-save").textContent).toBe("Saved to notes"));
    expect(actions.saveNote).toHaveBeenCalledWith({
      path: `/exams/${S}`,
      title: "Tutor: What is NPV?",
      body: "Present value is what money later is worth now.",
      quote: null,
      highlighted: false,
    });
    expect((screen.getByTestId("tutor-save") as HTMLButtonElement).disabled).toBe(true);
    window.history.pushState({}, "", "/");
  });

  it("New chat empties the drawer", async () => {
    render(<Tutor enabled actions={fakeActions()} />);
    await openTutor();
    type("Hi");
    fireEvent.click(screen.getByTestId("tutor-send"));
    await screen.findByTestId("tutor-answer");
    fireEvent.click(screen.getByTestId("tutor-new"));
    expect(screen.queryByTestId("tutor-answer")).toBeNull();
    expect(screen.getByTestId("tutor-empty")).toBeTruthy();
  });

  it("from 1100 px it is a side panel: not modal, no scrim, and it makes room on the page", async () => {
    wide = true;
    render(<Tutor enabled actions={fakeActions()} />);
    const dialog = await openTutor();
    expect(dialog.getAttribute("aria-modal")).toBeNull();
    expect(dialog.dataset.layout).toBe("side");
    expect(screen.queryByTestId("tutor-scrim")).toBeNull();
    expect(document.documentElement.dataset.tutor).toBe("open");
  });

  it("beside an open notepad panel it sits to its left", async () => {
    wide = true;
    const notes = document.createElement("section");
    notes.id = "notepad";
    document.body.appendChild(notes);
    render(<Tutor enabled actions={fakeActions()} />);
    const dialog = await openTutor();
    await waitFor(() => expect(dialog.className).toContain("right-[380px]"));
    expect(document.documentElement.dataset.tutor).toBe("beside-notes");
  });

  it("under 1100 px it is a modal sheet with a scrim", async () => {
    render(<Tutor enabled actions={fakeActions()} />);
    const dialog = await openTutor();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.dataset.layout).toBe("bottom");
    expect(screen.getByTestId("tutor-scrim")).toBeTruthy();
    expect(document.documentElement.dataset.tutor).toBeUndefined();
  });
});

describe("TutorView", () => {
  const base: TutorViewProps = {
    open: true,
    wide: false,
    turns: [],
    busy: false,
    draft: "",
    status: null,
    onOpen: () => {},
    onClose: () => {},
    onDraft: () => {},
    onSend: () => {},
    onNewChat: () => {},
    onCopy: () => {},
    onSave: () => {},
  };

  it("mid-answer: the answer grows, Send waits, no Save button yet", () => {
    render(
      <TutorView
        {...base}
        busy
        draft="next"
        turns={[
          { id: "1", role: "user", text: "Why?" },
          { id: "2", role: "assistant", text: "Because" },
        ]}
      />,
    );
    expect(screen.getByTestId("tutor-answer").textContent).toContain("Because");
    expect((screen.getByTestId("tutor-send") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("tutor-save")).toBeNull();
    expect(screen.getByRole("log").getAttribute("aria-busy")).toBe("true");
  });

  it("Enter sends, Shift+Enter does not", () => {
    const onSend = vi.fn();
    render(<TutorView {...base} draft="Hello" onSend={onSend} />);
    const box = screen.getByLabelText("Your question");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("caps her message at 4,000 characters", () => {
    render(<TutorView {...base} />);
    expect((screen.getByLabelText("Your question") as HTMLTextAreaElement).maxLength).toBe(4000);
  });
});

describe("whereFromPage", () => {
  it("reads lecture, exam, assignment and anywhere else from the address", () => {
    expect(whereFromPage(`/courses/${C}/lectures/4`, null)).toEqual({ kind: "lecture", courseId: C, n: 4, section: 0 });
    expect(whereFromPage(`/exams/${C}`, null)).toEqual({ kind: "exam", examId: C });
    expect(whereFromPage(`/exams/${C}/documents/plan`, null)).toEqual({ kind: "exam", examId: C });
    expect(whereFromPage(`/assignments/${C}`, null)).toEqual({ kind: "assignment", assignmentId: C });
    expect(whereFromPage("/home", null)).toEqual({ kind: "other" });
    expect(whereFromPage(`/courses/${C}`, null)).toEqual({ kind: "other" });
    expect(whereFromPage("/exams/not-a-uuid", null)).toEqual({ kind: "other" });
  });

  it("a study card counts as revealed only when the grade buttons or the feedback strip show", () => {
    document.body.innerHTML = `<div data-testid="session-card" data-card-id="${K}"></div>`;
    expect(whereFromPage(`/study/${S}`, document)).toEqual({ kind: "study", sessionId: S, cardId: K, revealed: false });
    document.body.innerHTML += `<div role="group" aria-label="${GRADE_GROUP_LABEL}"></div>`;
    expect(whereFromPage(`/study/${S}`, document)).toEqual({ kind: "study", sessionId: S, cardId: K, revealed: true });
    document.body.innerHTML = `<div data-testid="session-card" data-card-id="${K}"></div><div data-testid="feedback"></div>`;
    expect(whereFromPage(`/study/${S}`, document)).toMatchObject({ revealed: true });
    document.body.innerHTML = "";
    expect(whereFromPage(`/study/${S}`, document)).toEqual({ kind: "study", sessionId: S, revealed: false });
  });
});

describe("askTutor", () => {
  const body = { text: "q", where: { kind: "other" as const }, history: [] };

  it("reads the UI message stream", async () => {
    const seen: string[] = [];
    const out = await askTutor(body, (t) => seen.push(t), async () => streamResponse(["One ", "idea."]));
    expect(out).toEqual({ ok: true });
    expect(seen.at(-1)).toBe("One idea.");
  });

  it("503 is the resting line; a stream that fails part-way is the stopped line", async () => {
    const busy = await askTutor(body, () => {}, async () => Response.json({ error: "tutor_resting", message: RESTING_LINE }, { status: 503 }));
    expect(busy).toEqual({ ok: false, line: "The tutor is resting. Try again in a minute." });
    const broken = await askTutor(body, () => {}, async () => streamResponse(["Half"], true));
    expect(broken).toEqual({ ok: false, line: STOPPED_LINE });
    expect(problemFor(429, { error: "slow_down" })).toMatch(/one minute/);
  });

  it("names a note after her question", () => {
    expect(noteTitle("What is NPV?\nmore")).toBe("Tutor: What is NPV?");
    expect(noteTitle(undefined)).toBe("Tutor");
    expect(noteTitle("x".repeat(200)).length).toBe(80);
  });
});
