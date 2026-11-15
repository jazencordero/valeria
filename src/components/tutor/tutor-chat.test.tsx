import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState as useStateForTest } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GRADE_GROUP_LABEL } from "@/components/session/grade-buttons";
import {
  COPIED_LINE,
  EMPTY_LINE,
  MESSAGE_MAX,
  modelLabel,
  RESTING_LINE,
  STARTERS,
  STOPPED_LINE,
  STUDY_ASK_LINE,
  studyAskedKey,
  TutorChat,
  TutorChatView,
  whereFromPage,
  type TutorApi,
  type TutorChatProps,
  type TutorChatViewProps,
} from "./tutor-chat";
import {
  aboutCount,
  AMBER_FROM,
  ESTIMATE_LINE,
  FREE_LEVEL_LINE,
  LEVEL_CHOICES,
  LEVEL_KEY,
  meterWords,
  resetDay,
  ZERO_LINE,
  type TutorMeter,
} from "./tutor-controls";

const C = "11111111-1111-4111-8111-111111111111";
const NOTE = "22222222-2222-4222-8222-222222222222";
const ANSWER_ID = "33333333-3333-4333-8333-333333333333";
const DEEP_ID = "44444444-4444-4444-8444-444444444444";
const CARD = "55555555-5555-4555-8555-555555555555";
const FREE = "groq:openai/gpt-oss-120b";
const QUOTE = "PV = FV / (1 + r)^t";
const WHERE = { kind: "lecture" as const, courseId: C, n: 3, section: 1 };

beforeEach(() => {
  document.documentElement.dataset.fast = "1";
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  delete document.documentElement.dataset.fast;
});

/** A UI message stream with `words` as text deltas, as the route sends it. */
function streamResponse(words: string[], meta: Record<string, unknown> = {}, error = false): Response {
  const lines = [
    { type: "start", messageMetadata: { model: FREE, questionId: "q", answerId: ANSWER_ID, deeper: false, ...meta } },
    { type: "text-start", id: "0" },
    ...words.map((delta) => ({ type: "text-delta", id: "0", delta })),
    ...(error ? [{ type: "error", errorText: STOPPED_LINE }] : [{ type: "text-end", id: "0" }, { type: "finish" }]),
  ];
  const body = lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

type Body = Record<string, unknown>;

function fakeApi(handle: (body: Body) => Response | Promise<Response>) {
  const calls: Body[] = [];
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    calls.push(body);
    return handle(body);
  });
  const writeClipboard = vi.fn<(text: string) => Promise<void>>(async () => {});
  const api: TutorApi = { fetch: fetch as unknown as typeof globalThis.fetch, writeClipboard };
  return { api, calls, fetch, writeClipboard };
}

const loaded = (messages: unknown[] = [], deeperAvailable = false) => Response.json({ messages, deeperAvailable });

function renderChat(api: TutorApi, over: Partial<TutorChatProps> = {}) {
  const props: TutorChatProps = {
    noteId: null,
    quote: QUOTE,
    where: () => WHERE,
    resolveNoteId: vi.fn(async () => NOTE),
    onSaveToNote: vi.fn(),
    api,
    ...over,
  };
  render(<TutorChat {...props} />);
  return props;
}

const box = () => screen.getByLabelText("Ask the tutor") as HTMLTextAreaElement;

describe("TutorChatView", () => {
  const base: TutorChatViewProps = {
    turns: [],
    busy: false,
    draft: "",
    status: null,
    deeperAvailable: false,
    aboutQuote: true,
    onDraft: () => {},
    onSend: () => {},
    onStarter: () => {},
    onSaveToNote: () => {},
    onDeeper: () => {},
    onCopy: () => {},
  };

  it("an empty chat about a highlight shows the three starters, exactly", () => {
    const onStarter = vi.fn();
    render(<TutorChatView {...base} onStarter={onStarter} />);
    const group = screen.getByRole("group", { name: "Ask about this passage" });
    expect(Array.from(group.querySelectorAll("button")).map((b) => b.textContent)).toEqual([
      "Explain this simply",
      "Give me an example",
      "Quiz me on this",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Quiz me on this" }));
    expect(onStarter).toHaveBeenCalledWith("Quiz me on this");
  });

  it("an empty chat about a place has no starters, just the line", () => {
    render(<TutorChatView {...base} aboutQuote={false} />);
    expect(screen.queryByTestId("tutor-starters")).toBeNull();
    expect(screen.getByTestId("tutor-empty").textContent).toBe(EMPTY_LINE);
  });

  it("the box takes at most 4,000 characters; no limit line otherwise", () => {
    render(<TutorChatView {...base} />);
    expect(MESSAGE_MAX).toBe(4000);
    expect(box().maxLength).toBe(4000);
    expect(screen.getByTestId("tutor-chat").textContent).not.toMatch(/left today|daily|limit/i);
  });

  it("under an answer: the model, Save to note, and Go deeper only when available", () => {
    const turns = [
      { id: "q", role: "user" as const, text: "Why?" },
      { id: "a", role: "assistant" as const, text: "Because.", model: FREE, answerId: ANSWER_ID },
    ];
    const { rerender } = render(<TutorChatView {...base} turns={turns} deeperAvailable />);
    expect(screen.getByTestId("tutor-model").textContent).toBe("groq · gpt-oss-120b");
    expect(screen.getByRole("button", { name: "Save to note" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go deeper" })).toBeTruthy();
    rerender(<TutorChatView {...base} turns={turns} deeperAvailable={false} />);
    expect(screen.queryByRole("button", { name: "Go deeper" })).toBeNull();
  });

  it("no actions under the answer while it streams", () => {
    const turns = [
      { id: "q", role: "user" as const, text: "Why?" },
      { id: "a", role: "assistant" as const, text: "Becau" },
    ];
    render(<TutorChatView {...base} turns={turns} busy deeperAvailable />);
    expect(screen.queryByTestId("tutor-save")).toBeNull();
    expect(screen.getByTestId("tutor-send").textContent).toContain("Answering…");
  });

  it("modelLabel reads provider:model", () => {
    expect(modelLabel("anthropic:claude-haiku-5-5")).toBe("anthropic · claude-haiku-5-5");
    expect(modelLabel(null)).toBe("");
  });
});

describe("TutorChat (wired)", () => {
  it("RESTING_LINE is the server's TUTOR_RESTING", () => {
    const src = readFileSync(join(process.cwd(), "src/server/tutor/context.ts"), "utf8");
    expect(src).toContain(`export const TUTOR_RESTING = "${RESTING_LINE}";`);
  });

  it("a starter asks about the highlight: where, the quote and the note's id; the answer streams in", async () => {
    const { api, calls } = fakeApi((b) => (b.mode === "load" ? loaded([], false) : streamResponse(["Present value ", "is today's worth."])));
    const props = renderChat(api);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: STARTERS[0] }));
    await waitFor(() => expect(screen.getByTestId("tutor-answer").textContent).toContain("Present value is today's worth."));
    expect(calls[0]).toEqual({ mode: "load", where: WHERE });
    expect(calls[1]).toEqual({ text: "Explain this simply", where: WHERE, noteId: NOTE, quote: QUOTE });
    expect(screen.getByTestId("tutor-mine").textContent).toContain("Explain this simply");
    expect(screen.getByTestId("tutor-model").textContent).toBe("groq · gpt-oss-120b");
    expect(props.resolveNoteId).toHaveBeenCalledTimes(1);
  });

  it("the chat's note is decided at the first question and kept (an empty new note: the place)", async () => {
    const { api, calls } = fakeApi((b) => (b.mode === "load" ? loaded() : streamResponse(["Ok."])));
    const props = renderChat(api, { resolveNoteId: vi.fn(async () => null) });
    await act(async () => {});
    fireEvent.change(box(), { target: { value: "One" } });
    fireEvent.click(screen.getByTestId("tutor-send"));
    await waitFor(() => expect(screen.getAllByTestId("tutor-answer")).toHaveLength(1));
    fireEvent.change(box(), { target: { value: "Two" } });
    fireEvent.click(screen.getByTestId("tutor-send"));
    await waitFor(() => expect(screen.getAllByTestId("tutor-answer")).toHaveLength(2));
    expect(calls[1]).toEqual({ text: "One", where: WHERE, quote: QUOTE });
    expect(calls[2]).toEqual({ text: "Two", where: WHERE, quote: QUOTE });
    expect(props.resolveNoteId).toHaveBeenCalledTimes(1);
  });

  it("a stored note loads its chat when it opens, and offers Go deeper when the large model is there", async () => {
    const { api, calls } = fakeApi(() =>
      loaded(
        [
          { id: "q1", role: "user", text: "What is r?", model: null, replyTo: null, quote: QUOTE, createdAt: "2026-11-15T10:00:00Z" },
          { id: ANSWER_ID, role: "assistant", text: "The rate per period.", model: FREE, replyTo: "q1", quote: null, createdAt: "2026-11-15T10:00:01Z" },
        ],
        true,
      ),
    );
    const props = renderChat(api, { noteId: NOTE });
    expect(await screen.findByText("The rate per period.")).toBeTruthy();
    expect(calls[0]).toEqual({ mode: "load", where: WHERE, noteId: NOTE });
    expect(screen.getByRole("button", { name: "Go deeper" })).toBeTruthy();
    expect(screen.queryByTestId("tutor-starters")).toBeNull();
    expect(props.resolveNoteId).not.toHaveBeenCalled();
  });

  it("Save to note hands the answer to the notepad, once", async () => {
    const { api } = fakeApi((b) => (b.mode === "load" ? loaded() : streamResponse(["An annuity is equal payments."])));
    const props = renderChat(api);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: STARTERS[1] }));
    const save = await screen.findByRole("button", { name: "Save to note" });
    fireEvent.click(save);
    expect(props.onSaveToNote).toHaveBeenCalledWith("An annuity is equal payments.");
    const saved = screen.getByRole("button", { name: "Saved to note" }) as HTMLButtonElement;
    expect(saved.disabled).toBe(true);
    fireEvent.click(saved);
    expect(props.onSaveToNote).toHaveBeenCalledTimes(1);
  });

  it("Go deeper reruns that question and adds the deeper answer under it", async () => {
    const { api, calls } = fakeApi((b) => {
      if (b.mode === "load") return loaded([], true);
      if (b.deeper) return streamResponse(["A longer answer."], { model: "anthropic:large", answerId: DEEP_ID, deeper: true });
      return streamResponse(["Short."]);
    });
    renderChat(api, { noteId: NOTE });
    await act(async () => {});
    fireEvent.change(box(), { target: { value: "Why discount?" } });
    fireEvent.click(screen.getByTestId("tutor-send"));
    fireEvent.click(await screen.findByRole("button", { name: "Go deeper" }));
    await waitFor(() => expect(screen.getAllByTestId("tutor-answer")).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByTestId("tutor-model")[1].textContent).toBe("Deeper · anthropic · large"));
    expect(calls[2]).toEqual({ deeper: true, answerId: ANSWER_ID, where: WHERE, noteId: NOTE });
    expect(screen.getAllByTestId("tutor-answer")[1].textContent).toContain("A longer answer.");
    // No Go deeper on the deeper answer itself.
    expect(screen.getAllByRole("button", { name: "Go deeper" })).toHaveLength(1);
  });

  it("Go deeper refused (no key or budget left, 409): it goes away quietly", async () => {
    const { api } = fakeApi((b) => {
      if (b.mode === "load") return loaded([], true);
      if (b.deeper) return Response.json({ error: "deeper_unavailable" }, { status: 409 });
      return streamResponse(["Short."]);
    });
    renderChat(api, { noteId: NOTE });
    await act(async () => {});
    fireEvent.change(box(), { target: { value: "Why?" } });
    fireEvent.click(screen.getByTestId("tutor-send"));
    fireEvent.click(await screen.findByRole("button", { name: "Go deeper" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Go deeper" })).toBeNull());
    expect(screen.getAllByTestId("tutor-answer")).toHaveLength(1);
    expect(screen.getByTestId("tutor-status").textContent).toBe("");
  });

  it("every provider busy: the resting line, her text kept in the box", async () => {
    const { api } = fakeApi((b) =>
      b.mode === "load" ? loaded() : Response.json({ error: "tutor_resting", message: RESTING_LINE }, { status: 503 }),
    );
    renderChat(api);
    await act(async () => {});
    fireEvent.change(box(), { target: { value: "Explain annuities" } });
    fireEvent.click(screen.getByTestId("tutor-send"));
    await waitFor(() => expect(screen.getByTestId("tutor-status").textContent).toBe("The tutor is resting. Try again in a minute."));
    expect(box().value).toBe("Explain annuities");
    expect(screen.queryByTestId("tutor-mine")).toBeNull();
    expect(screen.queryByTestId("tutor-answer")).toBeNull();
  });

  it("an answer that stops part-way is not kept", async () => {
    const { api } = fakeApi((b) => (b.mode === "load" ? loaded() : streamResponse(["Half"], {}, true)));
    renderChat(api);
    await act(async () => {});
    fireEvent.change(box(), { target: { value: "Q" } });
    fireEvent.click(screen.getByTestId("tutor-send"));
    await waitFor(() => expect(screen.getByTestId("tutor-status").textContent).toBe(STOPPED_LINE));
    expect(screen.queryByTestId("tutor-answer")).toBeNull();
    expect(box().value).toBe("Q");
  });

  it("Copy for Claude puts the prompt on her clipboard and asks no AI", async () => {
    const { api, calls, writeClipboard } = fakeApi((b) =>
      b.mode === "copy" ? Response.json({ text: "PROMPT-TEXT", note: null }) : loaded(),
    );
    renderChat(api);
    await act(async () => {});
    fireEvent.change(box(), { target: { value: "my question" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy for Claude" }));
    await waitFor(() => expect(screen.getByTestId("tutor-status").textContent).toBe(COPIED_LINE));
    expect(writeClipboard).toHaveBeenCalledWith("PROMPT-TEXT");
    expect(calls).toEqual([{ mode: "load", where: WHERE }, { mode: "copy", text: "my question", where: WHERE }]);
  });
});

describe("whereFromPage", () => {
  it("reads lecture, exam and other places from the path", () => {
    expect(whereFromPage(`/courses/${C}/lectures/3`, null)).toEqual({ kind: "lecture", courseId: C, n: 3, section: 0 });
    expect(whereFromPage(`/exams/${C}`, null)).toEqual({ kind: "exam", examId: C });
    expect(whereFromPage("/home", null)).toEqual({ kind: "other" });
  });

  it("a study card counts as revealed only while its grade buttons show", () => {
    document.body.innerHTML = `<div data-testid="session-card" data-card-id="${CARD}"></div>`;
    expect(whereFromPage(`/study/${C}`, document)).toEqual({ kind: "study", sessionId: C, cardId: CARD, revealed: false });
    document.body.insertAdjacentHTML("beforeend", `<div role="group" aria-label="${GRADE_GROUP_LABEL}"></div>`);
    expect(whereFromPage(`/study/${C}`, document)).toEqual({ kind: "study", sessionId: C, cardId: CARD, revealed: true });
  });
});

describe("TutorChat about a study card (Ask about this card)", () => {
  const STUDY = { kind: "study" as const, sessionId: C, cardId: CARD, revealed: true };

  it("shows the card's stored chat even with the card as the quote", async () => {
    const { api, calls } = fakeApi(() => loaded([{ id: ANSWER_ID, role: "assistant", text: "Earlier answer", model: FREE }]));
    renderChat(api, { card: true, quote: "What is PV?\n\nAnswer: Today's worth.", where: () => STUDY });
    await screen.findByText("Earlier answer");
    expect(calls).toEqual([{ mode: "load", where: STUDY }]);
  });

  it("asks by the card's place, never sends the card text, and never stores the note first", async () => {
    const { api, calls } = fakeApi((b) => (b.mode === "load" ? loaded() : streamResponse(["Because."])));
    const props = renderChat(api, { card: true, quote: "What is PV?\n\nAnswer: Today's worth.", where: () => STUDY });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: STARTERS[0] }));
    await screen.findByText("Because.");
    expect(calls[1]).toEqual({ text: STARTERS[0], where: STUDY });
    expect(props.resolveNoteId).not.toHaveBeenCalled();
  });
});

describe("TutorChat: the course's study rule, asked once", () => {
  const COURSE = { courseId: C, courseName: "Finance 101" };
  const withStudy = (rule: string | null, messages: unknown[] = []) =>
    Response.json({ messages, deeperAvailable: false, study: rule ? { ...COURSE, rule } : null });
  const question = () => screen.queryByRole("group", { name: STUDY_ASK_LINE });

  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it("shows the question, as a labelled group with three named buttons, only while the rule is unknown", async () => {
    const { api } = fakeApi(() => withStudy("unknown"));
    renderChat(api);
    const group = await screen.findByRole("group", { name: STUDY_ASK_LINE });
    expect(STUDY_ASK_LINE).toBe("May Ready use this course's slides to explain things to you? Check the course's rules on AI.");
    expect(within(group).getAllByRole("button")).toHaveLength(3);
    for (const name of ["Yes", "No", "Not sure"]) expect(within(group).getByRole("button", { name })).toBeTruthy();
  });

  for (const rule of ["allowed", "not_allowed", null]) {
    it(`no question when the rule is ${rule ?? "not there (no course in view)"}`, async () => {
      const { api, calls } = fakeApi(() => withStudy(rule));
      renderChat(api, { quote: null, where: () => ({ kind: "other" }) });
      await waitFor(() => expect(calls).toHaveLength(1));
      await act(async () => {});
      expect(question()).toBeNull();
    });
  }

  for (const [label, rule] of [
    ["Yes", "allowed"],
    ["No", "not_allowed"],
  ] as const) {
    it(`${label} stores '${rule}' for the course in view and the question goes away`, async () => {
      const { api, calls } = fakeApi((b) => (b.mode === "load" ? withStudy("unknown") : Response.json({ ok: true, rule })));
      renderChat(api);
      await screen.findByRole("group", { name: STUDY_ASK_LINE });
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(question()).toBeNull());
      expect(calls[1]).toEqual({ mode: "study-rule", courseId: C, rule });
      expect(window.localStorage.getItem(studyAskedKey(C))).toBeNull();
    });
  }

  it("a refused save keeps the question and says so", async () => {
    const { api } = fakeApi((b) => (b.mode === "load" ? withStudy("unknown") : Response.json({ error: "not_found" }, { status: 404 })));
    renderChat(api);
    await screen.findByRole("group", { name: STUDY_ASK_LINE });
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(screen.getByTestId("tutor-status").textContent).toMatch(/Something went wrong/));
    expect(question()).not.toBeNull();
  });

  it("Not sure stores nothing, hides it, and this device does not ask again for that course (another course still asks)", async () => {
    const { api, calls } = fakeApi(() => withStudy("unknown"));
    renderChat(api);
    await screen.findByRole("group", { name: STUDY_ASK_LINE });
    fireEvent.click(screen.getByRole("button", { name: "Not sure" }));
    expect(question()).toBeNull();
    expect(calls).toHaveLength(1);
    expect(window.localStorage.getItem(studyAskedKey(C))).toBe("1");
    cleanup();

    renderChat(api);
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => {});
    expect(question()).toBeNull();
    cleanup();

    const OTHER_COURSE = "66666666-6666-4666-8666-666666666666";
    const other = fakeApi(() => Response.json({ messages: [], deeperAvailable: false, study: { courseId: OTHER_COURSE, courseName: "Stats", rule: "unknown" } }));
    renderChat(other.api);
    expect(await screen.findByRole("group", { name: STUDY_ASK_LINE })).toBeTruthy();
  });

  it("storage that throws: the question still works and is simply asked again", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { api } = fakeApi(() => withStudy("unknown"));
    renderChat(api);
    await screen.findByRole("group", { name: STUDY_ASK_LINE });
    fireEvent.click(screen.getByRole("button", { name: "Not sure" }));
    expect(question()).toBeNull();
    vi.restoreAllMocks();
  });

  it("after Yes, the next question is sent as usual and nothing in the chat says there is no material", async () => {
    const { api, calls } = fakeApi((b) =>
      b.mode === "load" ? withStudy("unknown") : b.mode === "study-rule" ? Response.json({ ok: true, rule: "allowed" }) : streamResponse(["From your slides."]),
    );
    renderChat(api);
    await screen.findByRole("group", { name: STUDY_ASK_LINE });
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(question()).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: STARTERS[0] }));
    await screen.findByText("From your slides.");
    expect(calls[2]).toEqual({ text: STARTERS[0], where: WHERE, noteId: NOTE, quote: QUOTE });
    expect(screen.getByTestId("tutor-chat").textContent).not.toMatch(/course material|no material/i);
  });

  it("works in the study card mode too (the panel over a session)", async () => {
    const STUDY = { kind: "study" as const, sessionId: NOTE, cardId: CARD, revealed: true };
    const { api, calls } = fakeApi((b) => (b.mode === "load" ? withStudy("unknown") : Response.json({ ok: true, rule: "not_allowed" })));
    renderChat(api, { card: true, quote: "What is PV?", where: () => STUDY });
    await screen.findByRole("group", { name: STUDY_ASK_LINE });
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    await waitFor(() => expect(question()).toBeNull());
    expect(calls[1]).toEqual({ mode: "study-rule", courseId: C, rule: "not_allowed" });
  });
});

// ---------------------------------------------------------------------------
// The model picker and the usage chip (M2-28 follow-up)

const METER = (fraction: number, budget = 150): TutorMeter => ({
  usedEur: fraction * budget,
  budgetEur: budget,
  fraction,
  resetsOn: "2026-12-01",
  paidAvailable: fraction < 1,
  levels: {
    quick: { answersLeft: 338_123, basis: "own" },
    balanced: { answersLeft: 14_321, basis: "default" },
    deep: { answersLeft: 2_655, basis: "default" },
  },
});

describe("the model picker", () => {
  const base: TutorChatViewProps = {
    turns: [],
    busy: false,
    draft: "Hi",
    status: null,
    deeperAvailable: true,
    aboutQuote: false,
    onDraft: () => {},
    onSend: () => {},
    onStarter: () => {},
    onSaveToNote: () => {},
    onDeeper: () => {},
    onCopy: () => {},
  };
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it("is a named radio group of three plain-word levels with hints and cost marks 1, 3 and 4 (the price ratios)", () => {
    const onLevel = vi.fn();
    render(<TutorChatView {...base} level="quick" onLevel={onLevel} />);
    const group = screen.getByRole("group", { name: "Answer model" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(["quick", "balanced", "deep"]);
    expect(within(group).getByRole("radio", { name: /^Quick, lowest cost/ })).toHaveProperty("checked", true);
    expect(within(group).getByRole("radio", { name: /^Balanced, about 20 times/ })).toHaveProperty("checked", false);
    expect(within(group).getByRole("radio", { name: /^Deep, about 80 times/ })).toBeTruthy();
    // No model ids in the labels.
    expect(group.textContent).not.toMatch(/claude|haiku|sonnet|fable/i);
    expect(Object.values(LEVEL_CHOICES).map((c) => c.dots)).toEqual([1, 3, 4]);
    expect(screen.getAllByTestId("tutor-level-dots").map((d) => d.children.length)).toEqual([1, 3, 4]);
    // The hint of the chosen level describes it.
    const quick = within(group).getByRole("radio", { name: /^Quick/ });
    const hint = document.getElementById(quick.getAttribute("aria-describedby")!);
    expect(hint?.textContent).toBe(LEVEL_CHOICES.quick.hint);
    fireEvent.click(within(group).getByRole("radio", { name: /^Deep/ }));
    expect(onLevel).toHaveBeenCalledWith("deep");
    // It sits beside Ask.
    expect(screen.getByTestId("tutor-levels").parentElement).toBe(screen.getByTestId("tutor-send").parentElement);
  });

  it("with no key or no budget left it is one disabled line: Free model this month", () => {
    render(<TutorChatView {...base} deeperAvailable={false} level="deep" />);
    expect(screen.queryByRole("radio")).toBeNull();
    const line = screen.getByTestId("tutor-level-free");
    expect(line.textContent).toBe(FREE_LEVEL_LINE);
    expect(FREE_LEVEL_LINE).toBe("Free model this month");
    expect(line.getAttribute("aria-disabled")).toBe("true");
  });

  it("is remembered on this device and sent as `level` (never a model id); Go deeper is still a one-shot rerun", async () => {
    window.localStorage.setItem(LEVEL_KEY, "balanced");
    const { api, calls } = fakeApi((b) => {
      if (b.mode === "load") return Response.json({ messages: [], deeperAvailable: true, paidLevels: true, meter: null });
      if (b.deeper) return streamResponse(["Deeper."], { model: "anthropic:claude-fable-5-2", answerId: DEEP_ID, deeper: true });
      return streamResponse(["Sure."], { model: "anthropic:claude-sonnet-5-5" });
    });
    renderChat(api, { quote: null });
    await act(async () => {});
    expect(screen.getByRole("radio", { name: /^Balanced/ })).toHaveProperty("checked", true);
    fireEvent.change(box(), { target: { value: "What is PV?" } });
    fireEvent.click(screen.getByTestId("tutor-send"));
    await screen.findByText("Sure.");
    expect(calls[1]).toMatchObject({ text: "What is PV?", level: "balanced" });
    // The small line still says which model answered.
    expect(screen.getByTestId("tutor-model").textContent).toBe("anthropic · claude-sonnet-5-5");

    fireEvent.click(screen.getByRole("radio", { name: /^Deep/ }));
    expect(window.localStorage.getItem(LEVEL_KEY)).toBe("deep");
    fireEvent.click(screen.getByTestId("tutor-deeper"));
    await screen.findByText("Deeper.");
    expect(calls[2]).toMatchObject({ deeper: true, answerId: ANSWER_ID, where: WHERE });
    expect(calls[2]).not.toHaveProperty("level");
    expect(JSON.stringify(calls)).not.toMatch(/claude-/);
  });

  it("without paid levels nothing about a level is sent; blocked storage falls back to Quick", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { api, calls } = fakeApi((b) => (b.mode === "load" ? loaded() : streamResponse(["Free."])));
    renderChat(api, { quote: null });
    await act(async () => {});
    expect(screen.getByTestId("tutor-level-free")).toBeTruthy();
    fireEvent.change(box(), { target: { value: "Hi" } });
    fireEvent.click(screen.getByTestId("tutor-send"));
    await screen.findByText("Free.");
    expect(calls[1]).not.toHaveProperty("level");
    vi.restoreAllMocks();
  });
});

describe("the usage chip", () => {
  const base: TutorChatViewProps = {
    turns: [],
    busy: false,
    draft: "",
    status: null,
    deeperAvailable: true,
    aboutQuote: false,
    onDraft: () => {},
    onSend: () => {},
    onStarter: () => {},
    onSaveToNote: () => {},
    onDeeper: () => {},
    onCopy: () => {},
  };

  it("words: about-counts, euros, the reset day", () => {
    expect([aboutCount(7), aboutCount(338_123), aboutCount(14_321), aboutCount(2_655)]).toEqual(["7", "340,000", "14,000", "2,700"]);
    expect(resetDay("2026-12-01")).toBe("1 Dec");
    const w = meterWords(METER(0.08));
    expect(w.used).toBe("about 12 of 150 EUR used");
    expect(w.levels).toBe("That is about 340,000 Quick answers, 14,000 Balanced, or 2,700 Deep ones.");
    expect(w.resets).toBe("Resets 1 Dec.");
    expect(meterWords({ ...METER(0.001), usedEur: 0.2 }).used).toBe("about under 1 of 150 EUR used");
  });

  it("no meter (no key): no chip", () => {
    render(<TutorChatView {...base} meter={null} />);
    expect(screen.queryByTestId("tutor-meter")).toBeNull();
  });

  it("is a button whose name has the numbers; it opens a dialog with the bar, what is left, the reset and the zero line; Escape closes it and focus returns", () => {
    function Harness() {
      const [open, setOpen] = useStateForTest(false);
      return <TutorChatView {...base} meter={METER(0.08)} meterOpen={open} onMeterOpen={setOpen} />;
    }
    render(<Harness />);
    const chip = screen.getByRole("button", { name: /about 12 of 150 EUR used/ });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(chip.textContent).toBe("8%");
    expect(chip.dataset.amber).toBeUndefined();
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "Tutor allowance this month" });
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(dialog);
    const meter = within(dialog).getByRole("meter", { name: "Allowance used" });
    expect(meter.getAttribute("aria-valuetext")).toBe("about 12 of 150 EUR used");
    expect(dialog.textContent).toContain("About 12 of 150 EUR used, about 138 EUR left.");
    expect(dialog.textContent).toContain("340,000 Quick answers");
    expect(dialog.textContent).toContain("Resets 1 Dec.");
    expect(dialog.textContent).toContain(ZERO_LINE);
    expect(ZERO_LINE).toBe("At zero, answers come from the free models until it resets.");
    expect(dialog.textContent).toContain(ESTIMATE_LINE);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(chip);
    // A tap outside also closes it.
    fireEvent.click(chip);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it(`is amber from ${AMBER_FROM * 100}%, never red, and the ring does not animate with reduced motion`, () => {
    render(<TutorChatView {...base} meter={METER(0.85)} meterOpen onMeterOpen={() => {}} />);
    const chip = screen.getByTestId("tutor-meter");
    expect(chip.dataset.amber).toBe("true");
    expect(screen.getByTestId("tutor-meter-ring").getAttribute("stroke")).toBe("var(--due)");
    expect(screen.getByTestId("tutor-meter-ring").getAttribute("class")).toContain("motion-reduce:transition-none");
    expect(screen.getByTestId("tutor-meter-bar").getAttribute("style")).toContain("var(--due)");
    expect(document.body.innerHTML).not.toMatch(/text-red|bg-red|danger|stroke="var\(--accent\)"/);
  });

  it("the wired chat shows the chip from the load answer and reads the usage mode again when it opens", async () => {
    const { api, calls } = fakeApi((b) => {
      if (b.mode === "load") return Response.json({ messages: [], deeperAvailable: true, paidLevels: true, meter: METER(0.08) });
      if (b.mode === "usage") return Response.json({ meter: METER(0.5) });
      return streamResponse(["x"]);
    });
    renderChat(api, { quote: null });
    const chip = await screen.findByRole("button", { name: /about 12 of 150 EUR used/ });
    expect(calls.map((c) => c.mode)).toEqual(["load"]);
    fireEvent.click(chip);
    await screen.findByRole("button", { name: /about 75 of 150 EUR used/ });
    expect(calls.map((c) => c.mode)).toEqual(["load", "usage"]);
  });
});

