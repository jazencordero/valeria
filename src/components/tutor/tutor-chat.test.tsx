import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  TutorChat,
  TutorChatView,
  whereFromPage,
  type TutorApi,
  type TutorChatProps,
  type TutorChatViewProps,
} from "./tutor-chat";

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
