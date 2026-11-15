"use client";

/**
 * The assignment workspace (M2-22): the chat where she works on one
 * assignment and hands it in. Source: prototype main-flow.html HTML 1631-1671
 * (#v-work, .work-grid, .sources, .work-head, .chips-wrap, .chat, .dock),
 * CSS 837-928 and the wide layout 958-1002.
 *
 * Top to bottom: the header (back, title, due line); Sources (a column from
 * 700 px, chips under it); the chat; the dock (suggestion chip, composer).
 *
 * The chat:
 * - Stored messages are shown as they are. A new chat starts with one
 *   assistant message built here, without AI ("I've read the brief and 3
 *   files. Where do you want to start?").
 * - The composer posts `{ assignmentId, text }` to /api/ai/assignment-chat
 *   (M2-14) and reads the AI SDK's UI message stream it answers with
 *   (`streamReply` below); the reply types in as it streams (M2-15). Not
 *   `useChat`: `@ai-sdk/react` is not a dependency and screens may not import
 *   the AI SDK (tests/arch/ai-boundary.test.ts).
 * - When the AI is busy (or the send fails before a reply starts) the
 *   sentence shows as a quiet line in the chat, her message goes back into the
 *   input, and her bubble is taken out again.
 * - The suggestion chip is `nextSuggestion` (M2-17). "Hand in to <LMS>"
 *   hands the draft in, "Back to home" goes home, anything else is sent.
 *
 * The course's AI rule (M2-21, M2-27), read through `assignmentHelp`:
 * - "off" or "unknown": no chat at all. The policy card (its question, or its
 *   off line with "Change answer"), the brief and the plain file hand-in.
 * - "explain": the chat, with the explain-only line. No draft is offered.
 * - "allowed": the chat; "Draft it with me" is offered.
 *
 * The draft (M2-19, M2-20): the card shows under the reply that wrote it
 * (only the latest one, since there is one draft per assignment). Its "Hand
 * in" fetches the PDF from /api/drafts/<id>/pdf, runs `prepareHandinAction`
 * and opens the Hand in sheet (M1-33). "Hand in my own file instead" opens
 * the file picker (M1-31) for her own file.
 *
 * After the hand-in: a receipt line in the chat ("Handed in to <LMS> at
 * 15:52."), the due line reads "Handed in 15:52" and the chip "Back to home".
 *
 * M4-13: the workspace opens out of the card she pressed Start on and the
 * back arrow shrinks it into that card again (`@/lib/motion/shared`, which
 * describes the whole transition). Here: `playArrival` when it mounts,
 * `closeWork` on the back arrow until the hand-in (after it Home rearranges
 * itself, M4-12, so the arrow is a plain link), and `holdShell` while it is
 * on screen: the sidebar stays visible but inert, and under 700 px the tab
 * bar goes away so the workspace covers everything. The header is the shared
 * `StickyHeader`.
 */
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  confirmHandinAction,
  prepareHandinAction,
  type PrepareHandinActionResult,
} from "@/app/(app)/assignments/[id]/actions";
import type { PolicyResult } from "@/app/(app)/assignments/[id]/policy-actions";
import { Composer } from "@/components/chat/composer";
import { DraftCard, draftFileName } from "@/components/chat/draft-card";
import { MessageList, type MessageListHandle } from "@/components/chat/message-list";
import { AssistantMessage, TypingDots, UserMessage } from "@/components/chat/message";
import { Suggestion } from "@/components/chat/suggestion";
import { AiPolicyCard, AI_OFF_LINE } from "@/components/work/ai-policy";
import { Brief } from "@/components/work/brief";
import { FilePick } from "@/components/work/file-pick";
import { HandinSheet, type HandinReview, type Result } from "@/components/work/handin-sheet";
import { SourceChips, SourcesColumn, type SourceFile } from "@/components/work/sources";
import { Button } from "@/components/ui/button";
import { StickyHeader } from "@/components/ui/sticky-header";
import { WORK_TRANSITION_CSS, closeWork, holdShell, playArrival } from "@/lib/motion/shared";
import { useMotionMode } from "@/lib/motion/use-calm";
import { assignmentHelp, type AiAssignments } from "@/lib/ai-policy";
import { nextSuggestion } from "@/lib/chat/suggest";
import { listDate, sameDay, timeLeft } from "@/lib/dates";
import type { CleanBrief } from "@/lib/html/clean";
import { handinPausedMessage } from "@/server/flags";

/* ---------- Props ---------- */

export type WorkspaceSource = {
  id: string;
  name: string;
  mime: string | null;
  course: string;
  readable: boolean;
};

/** A stored message part (src/server/chat/store.ts). */
export type WorkspacePart =
  | { type: "text"; text: string }
  | { type: "source"; label: string }
  | { type: "draft"; draftId: string }
  | { type: "receipt"; at: string };

export type WorkspaceMessage = {
  id: string;
  role: "user" | "assistant";
  parts: WorkspacePart[];
};

export type WorkspaceProps = {
  id: string;
  title: string;
  courseName: string;
  dueAt: Date | null;
  handedInAt: Date | null;
  brief: CleanBrief | null;
  files: WorkspaceSource[];
  acceptsFiles: boolean;
  maxBytes: number | null;
  maxFiles: number | null;
  lms: string;
  lmsUrl: string;
  /**
   * False when she has no Moodle connection (an account seeded from files, M3-57): every
   * hand-in becomes "Connect <LMS> to hand in", a link to /connect. Default true.
   */
  connected?: boolean;
  /** The course's `ai_assignments`. */
  aiAssignments: AiAssignments;
  /** Stores her answer to the policy card. Usually the bound server action. */
  setPolicy: (policy: AiAssignments) => Promise<PolicyResult>;
  /** The chat so far, oldest first. */
  messages: WorkspaceMessage[];
  /** Her draft, if the chat wrote one. */
  draft: { title: string; markdown: string } | null;
  /** The server's render time, so the due line hydrates the same. */
  now: Date;
  /** Where the back arrow and "Back to home" go. */
  homeHref?: string;
  /** The chat endpoint. Default /api/ai/assignment-chat. */
  chatApi?: string;
};

/* ---------- Copy ---------- */

const clock = (at: Date) => listDate(at).split(" · ")[1];

/**
 * The header's second line.
 * - Open, due today: `Due 21:00 · 5 h 12 min left`
 * - Open, another day: `Due TUE 17 · 23:59 · 2 days left`
 * - Open, past due: `Due TUE 17 · 23:59 · late by 3 h`
 * - Open, no due date: `No due date`
 * - Handed in today: `Handed in 15:52`; another day: `Handed in TUE 10 · 15:52`
 */
export function dueText(dueAt: Date | null, handedInAt: Date | null, now: Date): string {
  if (handedInAt) return `Handed in ${sameDay(handedInAt, now) ? clock(handedInAt) : listDate(handedInAt)}`;
  if (!dueAt) return "No due date";
  return `Due ${sameDay(dueAt, now) ? clock(dueAt) : listDate(dueAt)} · ${timeLeft(dueAt, now)}`;
}

/** The receipt line in the chat: "Handed in to <LMS> at 15:52." */
export function receiptText(lms: string, at: Date, now: Date): string {
  return `Handed in to ${lms} at ${sameDay(at, now) ? clock(at) : listDate(at)}.`;
}

/**
 * The first assistant message of a new chat, built without AI.
 * Where the course allows AI help the chat has the brief and the files;
 * where it only explains, it has neither, so it does not say it read them.
 */
export function firstMessage(hasBrief: boolean, fileCount: number, explainOnly: boolean): string {
  const start = "Where do you want to start?";
  if (explainOnly) return `I can explain the ideas behind this assignment. ${start}`;
  const files = `${fileCount} ${fileCount === 1 ? "file" : "files"}`;
  if (hasBrief && fileCount > 0) return `I've read the brief and ${files}. ${start}`;
  if (hasBrief) return `I've read the brief. ${start}`;
  if (fileCount > 0) return `I've read the ${files}. ${start}`;
  return start;
}

/** What the chat endpoint answered, as one quiet sentence. */
export function chatProblem(error: Error | undefined): string {
  const raw = error?.message ?? "";
  type Body = { error?: unknown; message?: unknown };
  let body: Body | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") body = parsed as Body;
  } catch {
    // Not JSON: a sentence from the stream itself, or a network error.
  }
  if (body) {
    if (body.error === "ai_busy" && typeof body.message === "string") return body.message;
    if (body.error === "ai_busy") return "AI is busy. Try again in a few minutes.";
    if (body.error === "slow_down") return "That is a lot of questions for one hour. Try again a bit later.";
    if (body.error === "ai_off_for_assignments") return AI_OFF_LINE;
    if (body.error === "not_signed_in") return "You are signed out. Open Ready again, then ask.";
    return "Something went wrong, so nothing was sent. Try again.";
  }
  if (raw === "The answer stopped early. Try again.") return raw;
  return "The connection dropped. Try again.";
}

type Problem = { text: string; link?: { href: string; label: string } };

/** The line shown when the hand-in review could not be made. */
function prepareProblem(r: Exclude<PrepareHandinActionResult, { ok: true }>, lms: string, lmsUrl: string): Problem {
  const there = { href: lmsUrl, label: `Open ${lms}` };
  switch (r.reason) {
    case "paused":
      return { text: handinPausedMessage(r.lms), link: { href: r.url ?? lmsUrl, label: `Open ${r.lms}` } };
    case "closed":
      return { text: "This assignment no longer takes a hand-in here.", link: there };
    case "no_files":
      return { text: `This assignment does not take files here. Hand it in on ${lms}.`, link: there };
    case "too_big":
      return { text: `That file is too big to hand in from here. Hand it in on ${lms}.`, link: there };
    case "no_file":
      return { text: "That file is empty or has no name. Pick it again." };
    case "not_found":
      return { text: "We could not find this assignment any more. Go back and open it again." };
    case "signed_out":
      return { text: "You are signed out. Open Ready again, then hand in." };
    case "invalid":
      return { text: "Something went wrong with the file. Pick it again." };
  }
}

/* ---------- The chat stream ---------- */

/*
 * The reply comes as the AI SDK's UI message stream (server-sent events,
 * `toUIMessageStreamResponse` in M2-14). Screens may not import the AI SDK
 * (tests/arch/ai-boundary.test.ts), so the few chunk types the chat needs are
 * read here: text, the `write_draft` tool call, and errors.
 */

type LiveDraft =
  | { state: "writing"; title: string }
  | { state: "saved"; title: string; markdown: string }
  | null;

type LiveTurn =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string; draft: LiveDraft };

type ChatStatus = "ready" | "submitted" | "streaming";

type Chunk = { type?: unknown; [key: string]: unknown };

/** The fields of one stream chunk the chat reads. */
export type ReplyUpdate = { text: string; draft: LiveDraft };

/**
 * Posts her message and reads the reply. `onUpdate` gets the whole reply so
 * far after every chunk. Throws with the response body when the answer is not
 * 2xx (so `chatProblem` can read `{error, message}`), and with the stream's
 * own sentence when it fails part-way.
 */
export async function streamReply(
  api: string,
  body: { assignmentId: string; text: string },
  fallbackTitle: string,
  onUpdate: (update: ReplyUpdate) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error((await res.text().catch(() => "")) || `status ${res.status}`);

  let text = "";
  let textId: string | null = null;
  let draft: LiveDraft = null;
  const draftCalls = new Map<string, { title: string; markdown?: string }>();

  const titleOf = (input: unknown) => {
    const t = (input as { title?: unknown } | null)?.title;
    return typeof t === "string" && t.trim() ? t.trim() : fallbackTitle;
  };
  const handle = (chunk: Chunk) => {
    switch (chunk.type) {
      case "text-start":
        if (text && chunk.id !== textId) text += "\n\n";
        textId = String(chunk.id ?? "");
        break;
      case "text-delta":
        if (typeof chunk.delta === "string") text += chunk.delta;
        break;
      case "tool-input-start":
        if (chunk.toolName === "write_draft") {
          draftCalls.set(String(chunk.toolCallId), { title: fallbackTitle });
          draft = { state: "writing", title: fallbackTitle };
        }
        break;
      case "tool-input-available":
        if (chunk.toolName === "write_draft") {
          const input = chunk.input as { markdown?: unknown } | null;
          const call = {
            title: titleOf(chunk.input),
            markdown: typeof input?.markdown === "string" ? input.markdown : undefined,
          };
          draftCalls.set(String(chunk.toolCallId), call);
          draft = { state: "writing", title: call.title };
        }
        break;
      case "tool-output-available": {
        const call = draftCalls.get(String(chunk.toolCallId));
        if (!call) break;
        const output = chunk.output as { saved?: unknown; title?: unknown } | null;
        // A refused call (not allowed, not asked, invalid) gives no card.
        draft =
          output?.saved === true && call.markdown
            ? {
                state: "saved",
                title: typeof output.title === "string" && output.title.trim() ? output.title.trim() : call.title,
                markdown: call.markdown,
              }
            : null;
        break;
      }
      case "tool-output-error":
        if (draftCalls.has(String(chunk.toolCallId))) draft = null;
        break;
      case "error":
        throw new Error(typeof chunk.errorText === "string" ? chunk.errorText : "");
      default:
        return;
    }
    onUpdate({ text, draft });
  };

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
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
        handle(chunk);
      }
    }
    if (done) break;
  }
}

const CITATION = /\[([^[\]\n]{1,300}?,\s*p\.\s*\d+)\]/g;

/** The same `[file, p. N]` labels the server stores as source parts. */
function citationsOf(text: string): string[] {
  const labels = new Set<string>();
  for (const match of text.matchAll(CITATION)) labels.add(match[1].replace(/\s+/g, " ").trim());
  return [...labels];
}

/** The newest live reply that carries a draft, and that draft. */
function latestLiveDraft(live: LiveTurn[]): { index: number; draft: NonNullable<LiveDraft> } | null {
  for (let i = live.length - 1; i >= 0; i--) {
    const turn = live[i];
    if (turn.role === "assistant" && turn.draft) return { index: i, draft: turn.draft };
  }
  return null;
}

let turnSeq = 0;
const turnId = () => `live-${++turnSeq}`;

/** Puts text back into the composer's input, as if she had typed it. */
function refill(container: HTMLElement | null, text: string) {
  const input = container?.querySelector<HTMLInputElement>("input[type=text]");
  if (!input) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

/* ---------- Small pieces ---------- */

function CheckIcon() {
  return (
    <svg className="ic size-4 text-accent" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14.5 5.5L8 12l6.5 6.5" />
    </svg>
  );
}

function QuietLine({ problem }: { problem: Problem }) {
  return (
    <p className="self-center text-center text-[13px] leading-[1.45] text-ink-3" data-testid="chat-note">
      {problem.text}
      {problem.link ? (
        <>
          {" "}
          <a
            href={problem.link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-ink-2 underline underline-offset-2"
          >
            {problem.link.label}
          </a>
        </>
      ) : null}
    </p>
  );
}

function ReceiptLine({ text }: { text: string }) {
  return (
    <p
      className="inline-flex items-center gap-2 self-center rounded-full border border-solid border-line bg-surface px-3.5 py-2 text-[13px] text-ink-2"
      data-testid="receipt-line"
    >
      <CheckIcon />
      {text}
    </p>
  );
}

const NO_SOURCES: string[] = [];

function LiveAssistant({ text, complete }: { text: string; complete: boolean }) {
  const sources = useMemo(() => (complete ? citationsOf(text) : NO_SOURCES), [text, complete]);
  return <AssistantMessage text={text} sources={sources} complete={complete} />;
}

/* ---------- The workspace ---------- */

const WIDE_PAD = "min-[700px]:px-[max(48px,calc((100%-720px)/2))]";
/** Where "Connect <LMS> to hand in" goes (M3-57). */
const CONNECT_HREF = "/connect";

type HandinFrom = "draft" | "file";

export function Workspace({
  id,
  title,
  courseName,
  dueAt,
  handedInAt,
  brief,
  files,
  acceptsFiles,
  maxBytes,
  maxFiles,
  lms,
  lmsUrl,
  connected = true,
  aiAssignments,
  setPolicy,
  messages: stored,
  draft,
  now,
  homeHref = "/home",
  chatApi = "/api/ai/assignment-chat",
}: WorkspaceProps) {
  const router = useRouter();
  const help = assignmentHelp({ aiAssignments });
  const chatOn = help !== "off";

  /* --- chat --- */
  const [live, setLive] = useState<LiveTurn[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const replying = status !== "ready";
  const abort = useRef<AbortController | null>(null);

  const list = useRef<MessageListHandle>(null);
  const dock = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);

  // The page area can hold more than this page (the demo line above it), so
  // the workspace takes the height that is left, and the dock stays on screen.
  useEffect(() => {
    const el = root.current;
    const area = el?.parentElement;
    if (!el || !area || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      el.style.height = `${Math.max(0, area.clientHeight - el.offsetTop)}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  // M4-13: the shell steps back while the workspace is on screen, and the
  // workspace plays its side of the open if Start led here.
  const mode = useMotionMode();
  useLayoutEffect(() => holdShell(), []);
  useLayoutEffect(() => {
    if (root.current) playArrival(root.current);
  }, []);

  const [lastInput, setLastInput] = useState(0);
  const [note, setNote] = useState<Problem | null>(null);

  // A server refresh (hand-in, policy answer) brings the live turns back as
  // stored messages; drop the live copies so nothing shows twice.
  const [seenStored, setSeenStored] = useState(stored);
  if (stored !== seenStored) {
    setSeenStored(stored);
    if (status === "ready") setLive([]);
  }

  useEffect(() => () => abort.current?.abort(), []);

  const send = async (text: string) => {
    if (replying) return;
    setNote(null);
    const userId = turnId();
    const replyId = turnId();
    setLive((turns) => [...turns, { id: userId, role: "user", text }]);
    setStatus("submitted");
    list.current?.scrollToEnd();
    const controller = new AbortController();
    abort.current = controller;
    try {
      await streamReply(
        chatApi,
        { assignmentId: id, text },
        title,
        ({ text: replyText, draft: replyDraft }) => {
          setStatus("streaming");
          setLive((turns) => {
            const reply = { id: replyId, role: "assistant" as const, text: replyText, draft: replyDraft };
            const at = turns.findIndex((t) => t.id === replyId);
            if (at === -1) return [...turns, reply];
            const next = [...turns];
            next[at] = reply;
            return next;
          });
        },
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      // Take her failed turn out of the chat and give her text back.
      setLive((turns) => turns.filter((t) => t.id !== userId && t.id !== replyId));
      setNote({ text: chatProblem(error instanceof Error ? error : undefined) });
      refill(dock.current, text);
    } finally {
      if (abort.current === controller) abort.current = null;
      if (!controller.signal.aborted) setStatus("ready");
    }
  };

  /* --- drafts --- */
  const liveDraft = latestLiveDraft(live);
  const savedLive = liveDraft?.draft.state === "saved" ? liveDraft.draft : null;
  const currentDraft = savedLive ? { title: savedLive.title, markdown: savedLive.markdown } : draft;
  const hasDraft = currentDraft !== null;
  const lastStoredDraft = useMemo(() => {
    for (let i = stored.length - 1; i >= 0; i--) {
      if (stored[i].parts.some((p) => p.type === "draft")) return i;
    }
    return -1;
  }, [stored]);

  /* --- hand-in --- */
  const [doneAt, setDoneAt] = useState<Date | null>(null);
  const handed = doneAt ?? handedInAt;
  const [preparing, setPreparing] = useState<HandinFrom | null>(null);
  const [fileProblem, setFileProblem] = useState<Problem | null>(null);
  // With the chat on, her own file waits behind "Hand in my own file instead".
  const [ownFile, setOwnFile] = useState(false);
  const [picked, setPicked] = useState<File | null>(null);
  const [review, setReview] = useState<HandinReview | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetKey, setSheetKey] = useState(0);
  // The file under review, the code from its review, and whether a confirm spent it.
  const handinFile = useRef<File | null>(null);
  const code = useRef<string | null>(null);
  const spent = useRef(false);

  const prepare = async (file: File) => {
    const r = await prepareHandinAction(id, formOf(file));
    if (r.ok) {
      code.current = r.review.code;
      spent.current = false;
    }
    return r;
  };

  const openReview = async (file: File, from: HandinFrom) => {
    const show = from === "file" ? setFileProblem : setNote;
    const r = await prepare(file);
    if (!r.ok) {
      show(prepareProblem(r, lms, lmsUrl));
      return;
    }
    handinFile.current = file;
    setReview({
      fileName: r.review.fileName,
      bytes: r.review.bytes,
      to: r.review.to,
      // The sheet needs a due time; without one it reads as on time.
      due: r.review.due ?? new Date(),
      earlyBy: r.review.earlyBy ?? "No due date",
      needsStatement: r.review.needsStatement,
    });
    setSheetKey((k) => k + 1);
    setSheetOpen(true);
  };

  const handInDraft = async () => {
    if (preparing || !currentDraft) return;
    setPreparing("draft");
    setNote(null);
    try {
      const res = await fetch(`/api/drafts/${id}/pdf`, { cache: "no-store" });
      if (!res.ok) {
        setNote({ text: "We could not make the PDF. Try again." });
        return;
      }
      const blob = await res.blob();
      const name = fileNameOf(res.headers.get("content-disposition")) ?? draftFileName(currentDraft.title);
      await openReview(new File([blob], name, { type: "application/pdf" }), "draft");
    } catch {
      setNote({ text: "The connection dropped, so nothing was sent. Try again." });
    } finally {
      setPreparing(null);
    }
  };

  const handInFile = async () => {
    if (preparing || !picked) return;
    setPreparing("file");
    setFileProblem(null);
    try {
      await openReview(picked, "file");
    } catch {
      setFileProblem({ text: "The connection dropped, so nothing was sent. Try again." });
    } finally {
      setPreparing(null);
    }
  };

  const submit = async (): Promise<Result> => {
    const file = handinFile.current;
    if (!file) return { ok: false, reason: "changed" };
    // A spent code cannot be used again: get a new review for the same file.
    if (spent.current || !code.current) {
      const again = await prepare(file);
      if (!again.ok) return { ok: false, reason: "expired" };
    }
    spent.current = true;
    const r = await confirmHandinAction(code.current, formOf(file));
    if (r.ok) return { ok: true, submittedAt: r.receipt.submittedAt };
    if (r.reason === "refused") return { ok: false, reason: "refused", message: r.message };
    if (r.reason === "signed_out" || r.reason === "invalid") return { ok: false, reason: "expired" };
    return { ok: false, reason: r.reason };
  };

  /* --- suggestion --- */
  const roles = useMemo(
    () => [...stored.map((m) => ({ role: m.role })), ...live.map((m) => ({ role: m.role }))],
    [stored, live],
  );
  const suggestion = nextSuggestion({
    messages: roles,
    hasDraft,
    handedIn: handed !== null,
    aiAssignments,
    lmsName: lms,
  });
  const onSuggestion = (label: string) => {
    if (label === "Back to home") router.push(homeHref);
    else if (label === `Hand in to ${lms}`) {
      if (connected) void handInDraft();
      else router.push(CONNECT_HREF);
    }
    else void send(label);
  };

  /* --- render --- */
  const sources: SourceFile[] = files.map((f) => ({
    id: f.id,
    name: f.name,
    mime: f.mime ?? undefined,
    course: f.course,
    readable: f.readable,
  }));

  const draftCard = (d: { title: string; markdown?: string }) => (
    <DraftCard
      title={d.title}
      markdown={d.markdown}
      onHandIn={() => (connected ? void handInDraft() : router.push(CONNECT_HREF))}
      className="mt-[-6px]"
    />
  );

  // No Moodle connection (M3-57): where the hand-in would be, the way to connect.
  const connectPart = (
    <section aria-label="Hand in" className="grid gap-4">
      <Button block size="lg" href={CONNECT_HREF} data-testid="handin-connect">
        Connect {lms} to hand in
      </Button>
    </section>
  );

  const ownFilePart = handed ? null : !connected ? connectPart : !acceptsFiles ? null : (
      <section aria-label="Hand in" className="grid gap-4">
        <FilePick
          lms={lms}
          lmsUrl={lmsUrl}
          maxBytes={maxBytes ?? undefined}
          maxFiles={maxFiles ?? 1}
          disabled={preparing !== null}
          onChange={(f) => {
            setPicked(f);
            setFileProblem(null);
            code.current = null;
          }}
        />
        <Button
          block
          size="lg"
          disabled={!picked}
          loading={preparing === "file"}
          onClick={() => void handInFile()}
          data-testid="handin-open"
        >
          Hand in
        </Button>
        <div aria-live="polite">
          {fileProblem ? (
            <p role="alert" className="text-[14px] text-ink [overflow-wrap:anywhere]" data-testid="handin-problem">
              {fileProblem.text}{" "}
              {fileProblem.link ? (
                <a
                  href={fileProblem.link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium underline underline-offset-2"
                >
                  {fileProblem.link.label}
                </a>
              ) : null}
            </p>
          ) : null}
        </div>
      </section>
    );

  const policyCard = (
    <AiPolicyCard courseName={courseName} policy={aiAssignments} setPolicy={setPolicy} />
  );

  const storedReceipt = stored.some((m) => m.parts.some((p) => p.type === "receipt"));
  const receipt = handed && !(storedReceipt && !doneAt) ? <ReceiptLine text={receiptText(lms, handed, doneAt ?? now)} /> : null;

  return (
    <div ref={root} className="flex h-full min-h-0" data-testid="workspace">
      <style href="ready-work-transition" precedence="default">
        {WORK_TRANSITION_CSS}
      </style>
      <SourcesColumn files={sources} lmsName={lms} />
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <StickyHeader
          padTop="10px"
          className="flex flex-none items-center gap-1 border-b border-line pr-[var(--pad)] pb-2.5 pl-[max(6px,calc(var(--pad)-14px))] min-[700px]:pl-4"
        >
          <Button
            variant="icon"
            href={homeHref}
            aria-label="Back to home"
            onClick={handed ? undefined : (e) => closeWork(e, mode, root.current)}
          >
            <BackIcon />
          </Button>
          <div className="min-w-0">
            <h1 className="font-display text-[18px] leading-[1.25] font-semibold [overflow-wrap:anywhere]" tabIndex={-1}>
              {title}
            </h1>
            <p
              className={
                "mono mt-0.5 transition-colors duration-base ease-out " + (handed ? "text-ink-2" : "text-due")
              }
              data-testid="work-due"
            >
              {dueText(dueAt, handed, now)}
            </p>
          </div>
        </StickyHeader>
        <SourceChips files={sources} lmsName={lms} className="flex-none" />

        {chatOn ? (
          <>
            <MessageList
              ref={list}
              aria-label="Conversation"
              className="min-[700px]:[&>div]:px-[max(48px,calc((100%-720px)/2))] min-[700px]:[&>div]:py-8"
            >
              {brief ? <Brief brief={brief} lmsName={lms} sourceUrl={lmsUrl} /> : null}
              {policyCard}
              {stored.length === 0 ? (
                <AssistantMessage
                  text={firstMessage(brief !== null, files.length, help === "explain")}
                  animate={false}
                />
              ) : null}
              {stored.map((m, i) => (
                <StoredMessage
                  key={m.id}
                  message={m}
                  draft={i === lastStoredDraft && !liveDraft && draft ? draftCard(draft) : null}
                  lms={lms}
                  now={now}
                />
              ))}
              {live.map((m, i) => {
                if (m.role === "user") return <UserMessage key={m.id} text={m.text} />;
                const streaming = i === live.length - 1 && status === "streaming";
                const text = m.text.trim();
                const card =
                  liveDraft?.index === i
                    ? draftCard(
                        liveDraft.draft.state === "saved"
                          ? { title: liveDraft.draft.title, markdown: liveDraft.draft.markdown }
                          : { title: liveDraft.draft.title },
                      )
                    : null;
                return (
                  <div key={m.id} className="flex flex-col gap-5">
                    {text || streaming ? <LiveAssistant text={text} complete={!streaming} /> : null}
                    {card}
                  </div>
                );
              })}
              {status === "submitted" && live[live.length - 1]?.role === "user" ? <TypingDots /> : null}
              {note ? <QuietLine problem={note} /> : null}
              {ownFile && !handed ? ownFilePart : null}
              {receipt}
            </MessageList>

            <div
              ref={dock}
              className={`flex-none border-t border-line bg-surface px-[var(--pad)] pt-1 pb-[max(12px,env(safe-area-inset-bottom,0px))] min-[700px]:pt-1.5 min-[700px]:pb-4 ${WIDE_PAD}`}
            >
              <Suggestion
                label={suggestion}
                busy={replying || preparing !== null}
                onSend={onSuggestion}
                lastInput={lastInput}
              />
              <Composer busy={replying} onSend={(text) => void send(text)} onInput={() => setLastInput((n) => n + 1)} />
              {!handed && !connected ? (
                <p className="mt-2 text-center text-[13px]">
                  <a
                    href={CONNECT_HREF}
                    className="text-ink-3 underline decoration-line underline-offset-2 hover:text-ink-2"
                    data-testid="handin-connect"
                  >
                    Connect {lms} to hand in
                  </a>
                </p>
              ) : !handed && acceptsFiles && !ownFile ? (
                <p className="mt-2 text-center text-[13px]">
                  <button
                    type="button"
                    className="text-ink-3 underline decoration-line underline-offset-2 hover:text-ink-2"
                    onClick={() => {
                      setOwnFile(true);
                      list.current?.scrollToEnd();
                    }}
                  >
                    Hand in my own file instead
                  </button>
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
            <div className="mx-auto grid max-w-[720px] gap-8 px-[var(--pad)] pt-6 pb-12">
              {policyCard}
              {brief ? <Brief brief={brief} lmsName={lms} sourceUrl={lmsUrl} /> : null}
              {receipt}
              {handed ? null : acceptsFiles || !connected ? (
                ownFilePart
              ) : (
                <p className="text-[15px] text-ink-2">
                  This assignment does not take files here.{" "}
                  <a
                    href={lmsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-ink underline underline-offset-2"
                  >
                    Hand it in on {lms}.
                  </a>
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {review ? (
        <HandinSheet
          key={sheetKey}
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          review={review}
          onSubmit={submit}
          lmsName={lms}
          backHref={homeHref}
          onHandedIn={(r) => setDoneAt(new Date(r.submittedAt))}
        />
      ) : null}
    </div>
  );
}

function StoredMessage({
  message,
  draft,
  lms,
  now,
}: {
  message: WorkspaceMessage;
  draft: ReactNode;
  lms: string;
  now: Date;
}) {
  const text = message.parts
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("\n\n")
    .trim();
  const sources = useMemo(
    () => message.parts.flatMap((p) => (p.type === "source" ? [p.label] : [])),
    [message.parts],
  );
  const receipts = message.parts.flatMap((p) => (p.type === "receipt" ? [p.at] : []));
  if (message.role === "user") return text ? <UserMessage text={text} animate={false} /> : null;
  return (
    <div className="flex flex-col gap-5">
      {text ? <AssistantMessage text={text} sources={sources} animate={false} /> : null}
      {draft}
      {receipts.map((at) => {
        const when = new Date(at);
        return Number.isNaN(when.getTime()) ? null : <ReceiptLine key={at} text={receiptText(lms, when, now)} />;
      })}
    </div>
  );
}

function formOf(file: File): FormData {
  const form = new FormData();
  form.append("file", file, file.name);
  return form;
}

/** The file name from a `content-disposition` header (RFC 6266 / 5987). */
function fileNameOf(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // Fall through to the plain name.
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain ? plain[1] : null;
}
