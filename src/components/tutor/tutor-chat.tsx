"use client";

/**
 * The tutor's chat (M2-28, step B). It lives inside the notes side panel, under the note
 * (src/components/notes/notepad.tsx mounts it only for an account with the tutor switched on;
 * the switch is decided on the server in src/app/(app)/layout.tsx).
 *
 * What she sees: her questions and the streamed answers; under each answer a small line with
 * the model that answered, "Save to note" (appends the answer to the note above), "Go deeper"
 * (only while the large model is available; reruns that question there) and, under the box,
 * "Copy for Claude" (a ready-made study prompt on her clipboard; nothing is sent anywhere).
 * An empty chat about a highlight starts with three one-tap starters. When every AI service is
 * busy the chat says `RESTING_LINE` and her text goes back in the box. No limits are shown:
 * there is no daily cap.
 *
 * What the chat is about (sent as `where`, decided by `whereFromPage`): a lecture page and the
 * section nearest the top of the screen; an exam page; a study session and the card on screen,
 * and whether she has answered or revealed it (the grade buttons or the feedback strip are
 * showing; the server sends no card text before that); an assignment page; anywhere else. With
 * a highlight, the passage itself goes as `quote`.
 *
 * Which stored chat it is (the route keys chats by note, else by place):
 * - A stored note: the note's chat, loaded when the note opens.
 * - A new note: decided at her first question and then kept while the note stays open. If the
 *   note already holds words it is stored first (`resolveNoteId`, the notepad's own save) and
 *   the chat is the note's; if it is still empty (only the highlight, or nothing), the chat is
 *   the place's. A new note without a highlight shows the place's stored chat, and when that
 *   has messages it carries on there, so the notes button gives the same chat about where she
 *   is. A new highlight starts empty, with the starters.
 *
 * `TutorChatView` is the pure view (plain props); `TutorChat` talks to POST /api/ai/tutor
 * (src/app/api/ai/tutor/route.ts) and reads its UI message stream by hand (the AI SDK stays in
 * src/server/ai, tests/arch/ai-boundary.test.ts).
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { GRADE_GROUP_LABEL } from "@/components/session/grade-buttons";
import { Button } from "@/components/ui/button";
import type { TutorWhere } from "@/server/tutor/context";

/** Same words as TUTOR_RESTING in src/server/tutor/context.ts (tested equal). */
export const RESTING_LINE = "The tutor is resting. Try again in a minute.";
export const STOPPED_LINE = "The answer stopped early. Try again.";
export const SLOW_LINE = "That is a lot of questions in one minute. Wait a moment, then ask again.";
export const PROBLEM_LINE = "Something went wrong, so nothing was sent. Try again.";
export const EMPTY_LINE = "Ask anything you are studying. I explain it from the start, one idea at a time.";
export const COPIED_LINE = "Copied. Paste it into your own Claude chat.";
export const COPY_BLOCKED_LINE = "Copying was blocked by the browser. Try again.";
export const STARTERS = ["Explain this simply", "Give me an example", "Quiz me on this"] as const;
export const MESSAGE_MAX = 4000;
const ROUTE = "/api/ai/tutor";

export type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Answers: "provider:model", for the small line under it. */
  model?: string | null;
  /** Answers: the stored id ("Go deeper" needs it). */
  answerId?: string | null;
  /** Answers: this one came from "Go deeper". */
  deeper?: boolean;
  /** Answers: appended to the note. */
  saved?: boolean;
};

export type TutorChatViewProps = {
  turns: ChatTurn[];
  /** An answer is on its way (the last answer is the one streaming). */
  busy: boolean;
  draft: string;
  /** One quiet line under the box (resting, an error, "Copied ..."). */
  status: string | null;
  /** "Go deeper" can be offered (a key is set and the month's budget is not spent). */
  deeperAvailable: boolean;
  /** The chat is about a highlight: an empty chat starts with the starters. */
  aboutQuote: boolean;
  onDraft: (text: string) => void;
  onSend: () => void;
  onStarter: (text: string) => void;
  onSaveToNote: (turnId: string) => void;
  onDeeper: (turnId: string) => void;
  onCopy: () => void;
};

/** "groq:openai/gpt-oss-120b" -> "groq · gpt-oss-120b". */
export function modelLabel(model: string | null | undefined): string {
  if (!model) return "";
  const cut = model.indexOf(":");
  const provider = cut === -1 ? "" : model.slice(0, cut);
  const name = (cut === -1 ? model : model.slice(cut + 1)).split("/").pop() ?? "";
  return provider ? `${provider} · ${name}` : name;
}

const LINK =
  "inline-flex min-h-[44px] cursor-pointer items-center border-0 bg-transparent p-0 text-[13px] text-ink-2 underline " +
  "decoration-line decoration-2 underline-offset-4 hover:text-ink disabled:cursor-default disabled:no-underline " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]";

export function TutorChatView(props: TutorChatViewProps) {
  const { turns, busy, draft, status, deeperAvailable, aboutQuote } = props;
  const headingId = useId();
  const boxId = useId();
  const logRef = useRef<HTMLDivElement>(null);
  const streaming = busy ? [...turns].reverse().find((t) => t.role === "assistant") : undefined;

  // Keep the newest words in view.
  useEffect(() => {
    const log = logRef.current;
    if (log && typeof log.scrollTo === "function") log.scrollTo({ top: log.scrollHeight });
  }, [turns]);

  const onBoxKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!busy && draft.trim()) props.onSend();
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex min-h-0 flex-1 flex-col" data-testid="tutor-chat">
      <h3 id={headingId} className="sr-only">
        Tutor
      </h3>
      <div
        ref={logRef}
        role="log"
        aria-label="Tutor conversation"
        aria-busy={busy}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-1 pb-2"
        data-testid="tutor-log"
      >
        {turns.length === 0 ? (
          aboutQuote ? (
            <div role="group" aria-label="Ask about this passage" className="flex flex-wrap gap-1.5" data-testid="tutor-starters">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={busy}
                  onClick={() => props.onStarter(s)}
                  className="inline-flex min-h-[44px] cursor-pointer items-center border-0 bg-transparent p-0 focus-visible:outline-none [&:focus-visible>span]:outline-2 [&:focus-visible>span]:outline-offset-2 [&:focus-visible>span]:outline-[var(--accent)]"
                >
                  <span className="inline-flex min-h-[32px] items-center rounded-full border border-line bg-paper px-3 py-1 text-[13px] text-ink hover:border-ink-3">
                    {s}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="m-0 mt-2 text-[14px] text-ink-2" data-testid="tutor-empty">
              {EMPTY_LINE}
            </p>
          )
        ) : (
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {turns.map((turn) =>
              turn.role === "user" ? (
                <li
                  key={turn.id}
                  className="ml-8 self-end rounded-[18px] rounded-br-[6px] bg-paper px-3.5 py-2.5 text-[15px] whitespace-pre-wrap [overflow-wrap:anywhere]"
                  data-testid="tutor-mine"
                >
                  <span className="sr-only">You: </span>
                  {turn.text}
                </li>
              ) : (
                <li key={turn.id} className="mr-2 text-[15px] leading-[1.55]" data-testid="tutor-answer">
                  <span className="sr-only">Tutor: </span>
                  <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{turn.text}</span>
                  {turn === streaming ? (
                    <span className="ml-1 inline-block h-[1em] w-[2px] animate-pulse bg-ink-3 align-[-2px] motion-reduce:animate-none" aria-hidden="true" />
                  ) : null}
                  {turn !== streaming && turn.text ? (
                    <div className="mt-1 flex flex-wrap items-center gap-x-4">
                      {turn.model ? (
                        <span className="mono w-full text-[11px] text-ink-3" data-testid="tutor-model">
                          {turn.deeper ? "Deeper · " : ""}
                          {modelLabel(turn.model)}
                        </span>
                      ) : null}
                      <button type="button" className={LINK} onClick={() => props.onSaveToNote(turn.id)} disabled={turn.saved} data-testid="tutor-save">
                        {turn.saved ? "Saved to note" : "Save to note"}
                      </button>
                      {deeperAvailable && turn.answerId && !turn.deeper ? (
                        <button type="button" className={LINK} onClick={() => props.onDeeper(turn.id)} disabled={busy} data-testid="tutor-deeper">
                          Go deeper
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ),
            )}
          </ol>
        )}
      </div>

      <form
        className="flex-none border-t border-line pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && draft.trim()) props.onSend();
        }}
      >
        <label htmlFor={boxId} className="sr-only">
          Ask the tutor
        </label>
        <textarea
          id={boxId}
          value={draft}
          maxLength={MESSAGE_MAX}
          rows={2}
          placeholder="Ask the tutor"
          onChange={(e) => props.onDraft(e.target.value)}
          onKeyDown={onBoxKey}
          data-testid="tutor-box"
          className="block w-full resize-none rounded-[14px] border border-line bg-paper px-3.5 py-2 text-[16px] text-ink placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        />
        <p className="m-0 min-h-[20px] pt-1 text-[13px] text-ink-2" aria-live="polite" data-testid="tutor-status">
          {status ?? (draft.length > MESSAGE_MAX - 500 ? `${MESSAGE_MAX - draft.length} characters left` : "")}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={props.onCopy} data-testid="tutor-copy">
            Copy for Claude
          </Button>
          <Button type="submit" size="sm" disabled={busy || !draft.trim()} data-testid="tutor-send">
            {busy ? "Answering…" : "Ask"}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Where she is

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The section of a lecture page nearest the top of the screen (0 when none). */
function sectionInView(doc: Document): number {
  const sections = Array.from(doc.querySelectorAll<HTMLElement>(".lec-sec"));
  const line = (doc.defaultView?.innerHeight ?? 800) * 0.35;
  let index = 0;
  sections.forEach((s, i) => {
    if (s.getBoundingClientRect().top <= line) index = i;
  });
  return index;
}

/**
 * Where she is, from the path and (lecture section, study card) the page on screen. A study
 * card counts as answered or revealed only while its grade buttons or feedback strip show.
 */
export function whereFromPage(pathname: string, doc: Document | null): TutorWhere {
  const [section, id, sub, n] = pathname.split(/[?#]/, 1)[0].split("/").filter(Boolean);
  if (!id || !UUID.test(id)) return { kind: "other" };
  switch (section) {
    case "courses":
      if (sub === "lectures" && n && /^[1-9]\d{0,5}$/.test(n)) {
        return { kind: "lecture", courseId: id, n: Number(n), section: doc ? sectionInView(doc) : 0 };
      }
      return { kind: "other" };
    case "exams":
      return { kind: "exam", examId: id };
    case "assignments":
      return { kind: "assignment", assignmentId: id };
    case "study": {
      const card = doc?.querySelector<HTMLElement>('[data-testid="session-card"]');
      const cardId = card?.dataset.cardId;
      const revealed = Boolean(
        doc?.querySelector(`[role="group"][aria-label="${GRADE_GROUP_LABEL}"]`) || doc?.querySelector('[data-testid="feedback"]'),
      );
      return cardId && UUID.test(cardId)
        ? { kind: "study", sessionId: id, cardId, revealed }
        : { kind: "study", sessionId: id, revealed: false };
    }
    default:
      return { kind: "other" };
  }
}

// ---------------------------------------------------------------------------
// The requests

export type AnswerMeta = { model: string | null; questionId: string | null; answerId: string | null; deeper: boolean };

type Chunk = { type?: unknown; [key: string]: unknown };

/** The chat's line for a refused request. */
export function problemFor(status: number, body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error;
  if (status === 503 || error === "tutor_resting" || error === "ai_busy") return RESTING_LINE;
  if (status === 429 || error === "slow_down") return SLOW_LINE;
  if (error === "not_signed_in") return "You are signed out. Open Ready again, then ask.";
  return PROBLEM_LINE;
}

function readMeta(raw: unknown, into: AnswerMeta): void {
  if (typeof raw !== "object" || raw === null) return;
  const m = raw as Record<string, unknown>;
  if (typeof m.model === "string") into.model = m.model;
  if (typeof m.questionId === "string") into.questionId = m.questionId;
  if (typeof m.answerId === "string") into.answerId = m.answerId;
  if (typeof m.deeper === "boolean") into.deeper = m.deeper;
}

export type AskResult = { ok: true; meta: AnswerMeta } | { ok: false; status: number; line: string };

/**
 * Posts one question (or "Go deeper") and reads the UI message stream: `onText` gets the
 * answer so far; the `start` chunk's `messageMetadata` (or the `x-tutor-model` header) says
 * which model answered and the stored ids.
 */
export async function askTutor(
  body: Record<string, unknown>,
  onText: (text: string) => void,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<AskResult> {
  let res: Response;
  try {
    res = await fetcher(ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  } catch {
    return { ok: false, status: 0, line: PROBLEM_LINE };
  }
  if (!res.ok || !res.body) {
    const parsed: unknown = await res.json().catch(() => null);
    return { ok: false, status: res.status, line: problemFor(res.status, parsed) };
  }
  const meta: AnswerMeta = { model: res.headers.get("x-tutor-model"), questionId: null, answerId: null, deeper: body.deeper === true };
  let text = "";
  let textId: string | null = null;
  let failed = false;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += value;
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let chunk: Chunk;
          try {
            chunk = JSON.parse(data) as Chunk;
          } catch {
            continue;
          }
          if (chunk.type === "start" || chunk.type === "message-metadata" || chunk.type === "finish") {
            readMeta(chunk.messageMetadata, meta);
          } else if (chunk.type === "text-start") {
            if (text && chunk.id !== textId) text += "\n\n";
            textId = String(chunk.id ?? "");
          } else if (chunk.type === "text-delta" && typeof chunk.delta === "string") {
            text += chunk.delta;
            onText(text);
          } else if (chunk.type === "error") {
            failed = true;
          }
        }
      }
      if (done) break;
    }
  } catch {
    failed = true;
  }
  if (failed || !text.trim()) return { ok: false, status: res.status, line: STOPPED_LINE };
  return { ok: true, meta };
}

type Loaded = { messages: { id: string; role: "user" | "assistant"; text: string; model: string | null }[]; deeperAvailable: boolean };

async function postJson<T>(fetcher: typeof fetch, body: Record<string, unknown>, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetcher(ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wired

export type TutorApi = {
  fetch: typeof fetch;
  writeClipboard: (text: string) => Promise<void>;
};

const DEFAULT_API: TutorApi = {
  fetch: (input, init) => fetch(input, init),
  writeClipboard: (text) => navigator.clipboard.writeText(text),
};

/** /dev/tutor: a chat already in a state, with no load. */
export type TutorPreview = { turns: ChatTurn[]; busy?: boolean; deeperAvailable?: boolean; draft?: string; status?: string | null };

export type TutorChatProps = {
  /** The note's stored id when it opened (null for a new note). Remount (`key`) per note. */
  noteId: string | null;
  /** The passage the note quotes (a highlight), sent with every question. */
  quote: string | null;
  /** Where she is, read when a question goes out. */
  where: () => TutorWhere;
  /** A new note's id for the chat: stores it first when it holds words (null when it is empty). */
  resolveNoteId: () => Promise<string | null>;
  /** "Save to note": the notepad appends the text to the note's body and saves it its own way. */
  onSaveToNote: (text: string) => void;
  api?: TutorApi;
  preview?: TutorPreview;
};

let turnSeq = 0;
const localId = () => `turn-${++turnSeq}`;

/** The chat's key: undecided, the note's id, or the place (null). */
type Key = { decided: false } | { decided: true; noteId: string | null };

export function TutorChat({ noteId, quote, where, resolveNoteId, onSaveToNote, api = DEFAULT_API, preview }: TutorChatProps) {
  const [turns, setTurns] = useState<ChatTurn[]>(preview?.turns ?? []);
  const [draft, setDraft] = useState(preview?.draft ?? "");
  const [busy, setBusy] = useState(preview?.busy ?? false);
  const [status, setStatus] = useState<string | null>(preview?.status ?? null);
  const [deeperAvailable, setDeeperAvailable] = useState(preview?.deeperAvailable ?? false);
  const key = useRef<Key>(noteId ? { decided: true, noteId } : { decided: false });
  const aborter = useRef<AbortController | null>(null);
  const busyRef = useRef(busy);

  const setBusyBoth = useCallback((b: boolean) => {
    busyRef.current = b;
    setBusy(b);
  }, []);

  // Stop a streaming answer when the note closes.
  useEffect(() => () => aborter.current?.abort(), []);

  // The stored chat (and whether "Go deeper" can be offered), once per note.
  useEffect(() => {
    if (preview) return;
    const controller = new AbortController();
    const body: Record<string, unknown> = { mode: "load", where: where() };
    if (noteId) body.noteId = noteId;
    void postJson<Loaded>(api.fetch, body, controller.signal).then((loaded) => {
      if (!loaded || controller.signal.aborted) return;
      setDeeperAvailable(loaded.deeperAvailable === true);
      // A new highlight starts empty; otherwise show the stored chat (note's or place's).
      if (quote && !noteId) return;
      const messages = Array.isArray(loaded.messages) ? loaded.messages : [];
      if (messages.length > 0) {
        if (!key.current.decided) key.current = { decided: true, noteId: null };
        setTurns(
          messages.map((m) =>
            m.role === "assistant"
              ? { id: m.id, role: "assistant", text: m.text, model: m.model, answerId: m.id }
              : { id: m.id, role: "user", text: m.text },
          ),
        );
      }
    });
    return () => controller.abort();
    // Once per note: the parent remounts the chat for another note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chatNoteId = useCallback(async (): Promise<string | null> => {
    if (key.current.decided) return key.current.noteId;
    const id = await resolveNoteId().catch(() => null);
    key.current = { decided: true, noteId: id };
    return id;
  }, [resolveNoteId]);

  const ask = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || busyRef.current) return;
      const mine: ChatTurn = { id: localId(), role: "user", text: question };
      const answer: ChatTurn = { id: localId(), role: "assistant", text: "" };
      setTurns((list) => [...list, mine, answer]);
      setDraft("");
      setStatus(null);
      setBusyBoth(true);
      const id = await chatNoteId();
      const body: Record<string, unknown> = { text: question, where: where() };
      if (id) body.noteId = id;
      if (quote) body.quote = quote.slice(0, MESSAGE_MAX);
      const controller = new AbortController();
      aborter.current = controller;
      const out = await askTutor(
        body,
        (so) => setTurns((list) => list.map((t) => (t.id === answer.id ? { ...t, text: so } : t))),
        api.fetch,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setBusyBoth(false);
      if (out.ok) {
        setTurns((list) =>
          list.map((t) => (t.id === answer.id ? { ...t, model: out.meta.model, answerId: out.meta.answerId, deeper: out.meta.deeper } : t)),
        );
        return;
      }
      // Half an answer is never kept: her text goes back in the box.
      setTurns((list) => list.filter((t) => t.id !== mine.id && t.id !== answer.id));
      setDraft((now) => (now.trim() ? now : question));
      setStatus(out.line);
    },
    [api.fetch, chatNoteId, quote, setBusyBoth, where],
  );

  const deeper = useCallback(
    async (turnId: string) => {
      if (busyRef.current) return;
      const index = turns.findIndex((t) => t.id === turnId);
      const from = turns[index];
      if (!from?.answerId) return;
      // The new answer goes after the last answer to the same question.
      const answer: ChatTurn = { id: localId(), role: "assistant", text: "", deeper: true };
      setTurns((list) => {
        const pos = list.findIndex((t) => t.id === turnId);
        let end = pos + 1;
        while (end < list.length && list[end].role === "assistant") end += 1;
        return [...list.slice(0, end), answer, ...list.slice(end)];
      });
      setStatus(null);
      setBusyBoth(true);
      const id = key.current.decided ? key.current.noteId : null;
      const body: Record<string, unknown> = { deeper: true, answerId: from.answerId, where: where() };
      if (id) body.noteId = id;
      const controller = new AbortController();
      aborter.current = controller;
      const out = await askTutor(
        body,
        (so) => setTurns((list) => list.map((t) => (t.id === answer.id ? { ...t, text: so } : t))),
        api.fetch,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setBusyBoth(false);
      if (out.ok) {
        setTurns((list) => list.map((t) => (t.id === answer.id ? { ...t, model: out.meta.model, answerId: out.meta.answerId, deeper: true } : t)));
        return;
      }
      setTurns((list) => list.filter((t) => t.id !== answer.id));
      // No key or no budget left: "Go deeper" goes away quietly.
      if (out.status === 409) setDeeperAvailable(false);
      else setStatus(out.line);
    },
    [api.fetch, setBusyBoth, turns, where],
  );

  const copy = useCallback(async () => {
    const out = await postJson<{ text: string; note: string | null }>(api.fetch, { mode: "copy", text: draft, where: where() });
    if (!out || typeof out.text !== "string") {
      setStatus(PROBLEM_LINE);
      return;
    }
    try {
      await api.writeClipboard(out.text);
      setStatus(out.note ? `${COPIED_LINE} ${out.note}` : COPIED_LINE);
    } catch {
      setStatus(COPY_BLOCKED_LINE);
    }
  }, [api, draft, where]);

  const save = (turnId: string) => {
    const turn = turns.find((t) => t.id === turnId);
    if (!turn || turn.saved || !turn.text.trim()) return;
    onSaveToNote(turn.text.trim());
    setTurns((list) => list.map((t) => (t.id === turnId ? { ...t, saved: true } : t)));
  };

  return (
    <TutorChatView
      turns={turns}
      busy={busy}
      draft={draft}
      status={status}
      deeperAvailable={deeperAvailable}
      aboutQuote={Boolean(quote)}
      onDraft={(text) => {
        setDraft(text);
        if (status) setStatus(null);
      }}
      onSend={() => void ask(draft)}
      onStarter={(text) => void ask(text)}
      onSaveToNote={save}
      onDeeper={(id) => void deeper(id)}
      onCopy={() => void copy()}
    />
  );
}
