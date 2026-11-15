"use client";

/**
 * The tutor: a round button above the notes button, and a drawer to ask questions in (M2-28).
 *
 * Who sees it: `Tutor` is mounted once in src/app/(app)/layout.tsx with `enabled` decided on the
 * server (`tutorEnabled(users.settings)`); with `enabled` false it renders nothing at all.
 *
 * Where it sits:
 * - The button: 56 px, round, right edge, one button-height (68 px) above the notepad's pencil
 *   (src/components/notes/notepad.css: right 16 / bottom 76 px on phones, right 24 / bottom 24 px
 *   from 700 px), so the two never touch; the pencil's "Notes" hint grows to the left and so
 *   cannot reach it. On an assignment page it lifts by the same 74 px as the pencil. During a
 *   study session (where the pencil hides) it stays, above the session's screen.
 * - Under 1100 px the drawer is a modal sheet (scrim, the rest inert, Tab wraps, Escape closes).
 * - From 1100 px it is a 380 px side panel with no scrim, so the page stays usable, and the
 *   page area gets room for it (`data-tutor` on <html>, read by the layout's <main>). When the
 *   notepad's own 380 px panel is open on the right, the tutor sits just left of it
 *   (right: 380 px) and the page gets room for both: the two never cover each other.
 *
 * Inside: her messages and the streamed answers, "Save to notes" under each answer (a note
 * attached to the page she is on, through the notepad's own `saveNotepad` action), the text
 * box, "Send", "New chat" and "Copy for Claude" (a ready-made study prompt plus the part of the
 * course she is on, put on her clipboard; nothing is sent anywhere).
 *
 * When every AI service is busy the drawer says `TUTOR_RESTING` and puts her text back in the
 * box. Nothing about limits is shown: there is no daily cap.
 *
 * Where she is, for the server (`whereFromPage`): a lecture page and the section nearest the
 * top of the screen; an exam page; a study session and the card on screen, and whether she has
 * answered or revealed it (the grade buttons or the feedback strip are showing); an assignment
 * page; anywhere else.
 *
 * `TutorView` is the pure view (plain props, no fetching) for tests and /dev/tutor; `Tutor`
 * wires the path, the request and the actions.
 */
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { saveNotepad } from "@/app/(app)/notes/actions";
import type { NotepadSaveResult } from "@/app/(app)/notes/actions";
import { GRADE_GROUP_LABEL } from "@/components/session/grade-buttons";
import { Button } from "@/components/ui/button";
import { inertOthers } from "@/lib/a11y/inert";
import type { TutorWhere } from "@/server/tutor/context";

/** Same words as TUTOR_RESTING in src/server/tutor/context.ts (tested equal). */
export const RESTING_LINE = "The tutor is resting. Try again in a minute.";
export const STOPPED_LINE = "The answer stopped early. Try again.";
export const SLOW_LINE = "That is a lot of questions in one minute. Wait a moment, then ask again.";
export const PROBLEM_LINE = "Something went wrong, so nothing was sent. Try again.";
export const EMPTY_LINE = "Ask anything you are studying. I explain it from the start, one idea at a time.";
export const COPIED_LINE = "Copied. Paste it into your own Claude chat.";
export const MESSAGE_MAX = 4000;
const HISTORY_SENT = 19;
export const WIDE_QUERY = "(min-width: 1100px)";

export type TutorTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Answers only: "Save to notes" state. */
  saved?: "saving" | "saved" | "failed";
};

export type TutorViewProps = {
  open: boolean;
  /** From 1100 px: a side panel, not a modal sheet. */
  wide: boolean;
  /** The notepad's side panel is open on the right. */
  besideNotes?: boolean;
  /** On an assignment page: lift the button like the pencil. */
  lift?: boolean;
  /** In a study session: stay above the session's screen. */
  inSession?: boolean;
  turns: TutorTurn[];
  /** An answer is on its way. */
  busy: boolean;
  draft: string;
  /** One quiet line under the box (busy, an error, "Copied ..."). */
  status: string | null;
  onOpen: () => void;
  onClose: () => void;
  onDraft: (text: string) => void;
  onSend: () => void;
  onNewChat: () => void;
  onCopy: () => void;
  onSave: (turnId: string) => void;
  /** /dev/tutor: draw the drawer in place, not fixed to the screen. */
  inline?: boolean;
};

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function TutorIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="size-[26px] fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.7]">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" />
      <path d="M9.8 8.2a2.2 2.2 0 1 1 3 2.06c-.5.2-.8.62-.8 1.14v.3" />
      <path d="M12 14.2h.01" />
    </svg>
  );
}

export function TutorView(props: TutorViewProps) {
  const { open, wide, besideNotes, lift, inSession, turns, busy, draft, status, inline } = props;
  const headingId = useId();
  const boxId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const modal = open && !wide && !inline;
  const wasOpen = useRef(open);

  // Focus: into the box on open, back to the button on close.
  useEffect(() => {
    if (open && !wasOpen.current) boxRef.current?.focus();
    if (!open && wasOpen.current) fabRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // The sheet is modal: everything else is inert while it is up.
  useEffect(() => {
    const layer = layerRef.current;
    if (!modal || !layer) return;
    return inertOthers(layer);
  }, [modal]);

  // Keep the newest words in view.
  useEffect(() => {
    const log = logRef.current;
    if (log && typeof log.scrollTo === "function") log.scrollTo({ top: log.scrollHeight });
  }, [turns]);

  const onPanelKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
      return;
    }
    if (!modal || e.key !== "Tab") return;
    const list = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onBoxKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!busy && draft.trim()) props.onSend();
    }
  };

  const z = inSession ? { fab: "z-[61]", scrim: "z-[62]", panel: "z-[63]" } : { fab: "z-40", scrim: "z-[53]", panel: "z-[54]" };

  const fab =
    open || inline ? null : (
      <button
        ref={fabRef}
        type="button"
        aria-label="Tutor, ask a question"
        aria-expanded={false}
        aria-haspopup="dialog"
        data-testid="tutor-button"
        onClick={props.onOpen}
        className={
          `fixed ${z.fab} inline-flex size-14 cursor-pointer items-center justify-center rounded-full border-0 ` +
          "bg-[var(--btn)] text-[var(--btn-ink)] shadow-[0_3px_0_var(--btn-ledge),var(--shadow-lift)] " +
          "right-[max(16px,env(safe-area-inset-right,0px))] bottom-[calc(144px+env(safe-area-inset-bottom,0px))] " +
          "min-[700px]:right-6 min-[700px]:bottom-[92px] " +
          "transition-[translate] duration-200 motion-reduce:transition-none " +
          "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--accent)] " +
          (lift ? "-translate-y-[74px]" : "")
        }
      >
        <TutorIcon />
      </button>
    );

  const place = inline
    ? "relative h-[640px] w-full max-w-[380px] rounded-[20px] border border-line"
    : wide
      ? `fixed top-0 bottom-0 w-[380px] border-l border-line ${besideNotes ? "right-[380px]" : "right-0"}`
      : "fixed inset-x-0 bottom-0 h-[85dvh] rounded-t-[26px]";

  const lastAnswer = [...turns].reverse().find((t) => t.role === "assistant");

  const panel = open ? (
    <section
      ref={panelRef}
      id="tutor"
      role="dialog"
      aria-modal={modal ? true : undefined}
      aria-labelledby={headingId}
      data-testid="tutor"
      data-layout={inline ? "inline" : wide ? "side" : "bottom"}
      onKeyDown={onPanelKey}
      className={`${place} ${inline ? "" : z.panel} flex flex-col bg-surface px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom,0px))] text-ink shadow-[var(--shadow-sheet,var(--shadow-lift))]`}
    >
      {!wide && !inline ? <div className="mx-auto mb-3 h-1 w-9 flex-none rounded-full bg-line" aria-hidden="true" /> : null}
      <div className="flex flex-none items-center gap-2">
        <h2 id={headingId} className="type-h22 m-0">
          Tutor
        </h2>
        <span className="ml-auto" />
        <Button variant="secondary" size="sm" onClick={props.onNewChat} disabled={busy || turns.length === 0} data-testid="tutor-new">
          New chat
        </Button>
        <Button variant="icon" aria-label="Close tutor" onClick={props.onClose} className="-mr-2">
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
          </svg>
        </Button>
      </div>

      <div
        ref={logRef}
        role="log"
        aria-label="Conversation"
        aria-busy={busy}
        className="-mx-5 mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-2"
        data-testid="tutor-log"
      >
        {turns.length === 0 ? (
          <p className="mt-6 text-[15px] text-ink-2" data-testid="tutor-empty">
            {EMPTY_LINE}
          </p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {turns.map((turn) =>
              turn.role === "user" ? (
                <li key={turn.id} className="ml-8 self-end rounded-[18px] rounded-br-[6px] bg-paper px-3.5 py-2.5 text-[15px] whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="tutor-mine">
                  <span className="sr-only">You: </span>
                  {turn.text}
                </li>
              ) : (
                <li key={turn.id} className="mr-4 text-[15px] leading-[1.55]" data-testid="tutor-answer">
                  <span className="sr-only">Tutor: </span>
                  <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{turn.text}</span>
                  {busy && turn === lastAnswer ? (
                    <span className="ml-1 inline-block h-[1em] w-[2px] animate-pulse bg-ink-3 align-[-2px] motion-reduce:animate-none" aria-hidden="true" />
                  ) : null}
                  {!(busy && turn === lastAnswer) && turn.text ? (
                    <div className="mt-1.5">
                      <button
                        type="button"
                        className="inline-flex min-h-[44px] cursor-pointer items-center border-0 bg-transparent p-0 text-[13px] text-ink-2 underline decoration-line decoration-2 underline-offset-4 hover:text-ink disabled:cursor-default disabled:no-underline"
                        onClick={() => props.onSave(turn.id)}
                        disabled={turn.saved === "saving" || turn.saved === "saved"}
                        data-testid="tutor-save"
                      >
                        {turn.saved === "saved" ? "Saved to notes" : turn.saved === "saving" ? "Saving…" : turn.saved === "failed" ? "Not saved. Try again" : "Save to notes"}
                      </button>
                    </div>
                  ) : null}
                </li>
              ),
            )}
          </ol>
        )}
      </div>

      <form
        className="flex-none border-t border-line pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && draft.trim()) props.onSend();
        }}
      >
        <label htmlFor={boxId} className="sr-only">
          Your question
        </label>
        <textarea
          ref={boxRef}
          id={boxId}
          value={draft}
          maxLength={MESSAGE_MAX}
          rows={3}
          placeholder="Ask a question"
          onChange={(e) => props.onDraft(e.target.value)}
          onKeyDown={onBoxKey}
          data-testid="tutor-box"
          className="block w-full resize-none rounded-[14px] border border-line bg-paper px-3.5 py-2.5 text-[16px] text-ink placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        />
        <p className="m-0 min-h-[20px] pt-1.5 text-[13px] text-ink-2" aria-live="polite" data-testid="tutor-status">
          {status ?? ""}
        </p>
        <div className="mt-1 grid grid-cols-2 gap-2">
          <Button type="button" variant="secondary" onClick={props.onCopy} data-testid="tutor-copy">
            Copy for Claude
          </Button>
          <Button type="submit" disabled={busy || !draft.trim()} data-testid="tutor-send">
            {busy ? "Answering…" : "Send"}
          </Button>
        </div>
      </form>
    </section>
  ) : null;

  return (
    <div ref={layerRef} data-tutor-layer="">
      {fab}
      {modal ? (
        <div aria-hidden="true" className={`fixed inset-0 ${z.scrim} bg-[var(--scrim)]`} onClick={props.onClose} data-testid="tutor-scrim" />
      ) : null}
      {panel}
    </div>
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

/** Where she is, from the address and (lecture section, study card) the page on screen. */
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
// The request

type Chunk = { type?: unknown; [key: string]: unknown };

/** The drawer's line for a refused request. */
export function problemFor(status: number, body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error;
  if (status === 503 || error === "tutor_resting" || error === "ai_busy") return RESTING_LINE;
  if (error === "slow_down") return SLOW_LINE;
  if (error === "not_signed_in") return "You are signed out. Open Ready again, then ask.";
  return PROBLEM_LINE;
}

/** Posts one message and reads the streamed answer; `onText` gets the answer so far. */
export async function askTutor(
  body: { text: string; where: TutorWhere; history: { role: "user" | "assistant"; text: string }[] },
  onText: (text: string) => void,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; line: string }> {
  let res: Response;
  try {
    res = await fetcher("/api/ai/tutor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, line: PROBLEM_LINE };
  }
  if (!res.ok || !res.body) {
    const parsed: unknown = await res.json().catch(() => null);
    return { ok: false, line: problemFor(res.status, parsed) };
  }
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
          if (chunk.type === "text-start") {
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
  if (failed || !text.trim()) return { ok: false, line: STOPPED_LINE };
  return { ok: true };
}

/** A note's title from her question: "Tutor: " and its first line, cut to 80 characters. */
export function noteTitle(question: string | undefined): string {
  const first = (question ?? "").trim().split("\n", 1)[0] ?? "";
  const title = `Tutor: ${first}`.trim();
  return title.length > 80 ? `${title.slice(0, 79)}…` : title === "Tutor:" ? "Tutor" : title;
}

export type TutorActions = {
  ask: typeof askTutor;
  copyText: (body: { text: string; where: TutorWhere }) => Promise<{ text: string; note: string | null } | null>;
  saveNote: (input: { path: string; title: string; body: string; quote: null; highlighted: false }) => Promise<NotepadSaveResult>;
  writeClipboard: (text: string) => Promise<void>;
};

async function defaultCopyText(body: { text: string; where: TutorWhere }) {
  try {
    const res = await fetch("/api/ai/tutor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "copy", ...body }) });
    if (!res.ok) return null;
    return (await res.json()) as { text: string; note: string | null };
  } catch {
    return null;
  }
}

const DEFAULT_ACTIONS: TutorActions = {
  ask: askTutor,
  copyText: defaultCopyText,
  saveNote: (input) => saveNotepad(input),
  writeClipboard: (text) => navigator.clipboard.writeText(text),
};

// ---------------------------------------------------------------------------
// Wired

function subscribeWide(change: () => void) {
  const mq = window.matchMedia?.(WIDE_QUERY);
  mq?.addEventListener("change", change);
  return () => mq?.removeEventListener("change", change);
}
const getWide = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(WIDE_QUERY).matches : false);

/** True while the notepad's panel (`#notepad`) is in the page. */
function useNotesOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const check = () => setOpen(document.getElementById("notepad") !== null);
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return open;
}

const noSubscribe = () => () => {};

let turnSeq = 0;
const nextId = () => `t${++turnSeq}`;

export function Tutor({ enabled, actions = DEFAULT_ACTIONS }: { enabled: boolean; actions?: TutorActions }) {
  const pathname = usePathname() ?? "/";
  const wide = useSyncExternalStore(subscribeWide, getWide, () => false);
  const notesOpen = useNotesOpen();
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [host] = useState(() => (typeof document === "undefined" ? null : document.createElement("div")));
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<TutorTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const inSession = pathname.startsWith("/study/");
  const lift = /^\/assignments\/[^/]+/.test(pathname);

  // Its own layer at the end of <body>. A study session marks everything behind it inert; the
  // tutor works in a session, so its layer takes that mark off itself.
  useEffect(() => {
    const el = host;
    if (!enabled || !el) return;
    el.setAttribute("data-tutor-host", "");
    document.body.appendChild(el);
    const observer = new MutationObserver(() => {
      if (el.inert && window.location.pathname.startsWith("/study/")) {
        el.inert = false;
        el.removeAttribute("aria-hidden");
      }
    });
    observer.observe(el, { attributes: true, attributeFilter: ["inert", "aria-hidden"] });
    return () => {
      observer.disconnect();
      el.remove();
    };
  }, [enabled, host]);

  // Room for the side panel on wide screens (the layout's <main> reads this).
  useEffect(() => {
    const root = document.documentElement;
    if (open && wide) root.dataset.tutor = notesOpen ? "beside-notes" : "open";
    else delete root.dataset.tutor;
    return () => {
      delete root.dataset.tutor;
    };
  }, [open, wide, notesOpen]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const history = turns.filter((t) => t.text.trim()).slice(-HISTORY_SENT).map((t) => ({ role: t.role, text: t.text }));
    const mine: TutorTurn = { id: nextId(), role: "user", text };
    const answer: TutorTurn = { id: nextId(), role: "assistant", text: "" };
    setTurns((list) => [...list, mine, answer]);
    setDraft("");
    setStatus(null);
    setBusy(true);
    const where = whereFromPage(window.location.pathname, document);
    const out = await actions.ask({ text, where, history }, (so) => {
      setTurns((list) => list.map((t) => (t.id === answer.id ? { ...t, text: so } : t)));
    });
    setBusy(false);
    if (!out.ok) {
      // Half an answer is never kept: her text goes back in the box.
      setTurns((list) => list.filter((t) => t.id !== mine.id && t.id !== answer.id));
      setDraft((now) => (now.trim() ? now : text));
      setStatus(out.line);
    }
  }, [actions, busy, draft, turns]);

  const copy = useCallback(async () => {
    const where = whereFromPage(window.location.pathname, document);
    const out = await actions.copyText({ text: draft, where });
    if (!out) {
      setStatus(PROBLEM_LINE);
      return;
    }
    try {
      await actions.writeClipboard(out.text);
      setStatus(out.note ? `${COPIED_LINE} ${out.note}` : COPIED_LINE);
    } catch {
      setStatus("Copying was blocked by the browser. Try again.");
    }
  }, [actions, draft]);

  const save = useCallback(
    async (turnId: string) => {
      const index = turns.findIndex((t) => t.id === turnId);
      const turn = turns[index];
      if (!turn || !turn.text.trim()) return;
      const question = turns
        .slice(0, index)
        .reverse()
        .find((t) => t.role === "user")?.text;
      const mark = (saved: TutorTurn["saved"]) => setTurns((list) => list.map((t) => (t.id === turnId ? { ...t, saved } : t)));
      mark("saving");
      try {
        const out = await actions.saveNote({ path: window.location.pathname, title: noteTitle(question), body: turn.text, quote: null, highlighted: false });
        mark(out.ok && out.id ? "saved" : "failed");
      } catch {
        mark("failed");
      }
    },
    [actions, turns],
  );

  if (!enabled || !host || !mounted) return null;
  return createPortal(
    <TutorView
      open={open}
      wide={wide}
      besideNotes={wide && notesOpen}
      lift={lift}
      inSession={inSession}
      turns={turns}
      busy={busy}
      draft={draft}
      status={status}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      onDraft={(text) => {
        setDraft(text);
        if (status) setStatus(null);
      }}
      onSend={() => void send()}
      onNewChat={() => {
        setTurns([]);
        setStatus(null);
      }}
      onCopy={() => void copy()}
      onSave={(id) => void save(id)}
    />,
    host,
  );
}
