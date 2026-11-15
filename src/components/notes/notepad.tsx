"use client";

/**
 * Notepad: the floating pencil button and the drawer (ticket M9-13).
 * Source: prototype merged.html HTML 2037-2052, CSS 1106-1144, JS 5723-5813.
 *
 * The button: 56 px, round, bottom right of the app, above the tab bar on
 * phones. Hidden during a study session (any path under `/study/`, where
 * M3-43's session covers the screen), while the drawer is open, and on phones
 * while the on-screen keyboard is up (the visual viewport is more than 150 px
 * shorter than the window). On an assignment page it sits 74 px higher so it
 * clears the chat composer. From 700 px, the first time Home appears it shows
 * the word "Notes" and folds to the icon after 4.5 s or on first use
 * (remembered in localStorage['ready-notes-hint']).
 *
 * The drawer: under 700 px a modal bottom sheet at 85% height (scrim, the
 * rest of the page inert, Tab wraps inside); from 700 px a 380 px panel on
 * the right with no scrim, so the page stays usable. Inside: the chip saying
 * what the note is attached to, "Saved", close; title; the quote when there
 * is one; the ruled body that grows; "• List" (starts the line with "- ") and
 * "Highlight" (butter marker behind the title); "Turn into cards" and "Done".
 *
 * "Turn into cards" (M9-17) drafts up to three recall cards from the body
 * (`toCards`) under the tools, editable (`DraftCards`). "Add N cards" first
 * waits for the note to be stored (`NoteSaver.settled`), then calls
 * `addCardsFromNote`; when something was stored the toast says "Added to
 * <course>. First review today." and the drafts fold away (or stay with the
 * line saying how many she already had). A course with no exam keeps the
 * drafts and shows the no-exam line with a link to add one. A General note
 * (chip "General") asks which exam first (`noteCardExams`). The Notes tab's
 * card menu opens a note with the drafts already showing
 * (`openNotepad({ note, cards: true })`).
 *
 * Keys: N opens a new note when she is not typing in a field and no modal is
 * open; Escape closes. A new note attaches to the page it was started on
 * (`attachFromPath`, resolved by the server action).
 *
 * Saving (`NoteSaver` below): 600 ms after the last keystroke one save goes
 * out; saves never overlap (a change made while one is in flight goes in the
 * next). "Saved" shows when the save for her latest words comes back. A
 * failed save shows "Not saved yet" and retries (2 s, doubling to 30 s). An
 * empty note is never stored, and a stored note emptied before closing is
 * deleted by the same save. Closing sends what is left at once.
 *
 * Other screens can open it with a quote (M9-16) through `openNotepad`, or
 * on a note she already wrote (`openNotepad({ note })`, the Notes tab, M9-14).
 * Every stored save is announced as `NOTE_SAVED_EVENT` on window, so the
 * Notes tab can pop a new card in and keep an edited one up to date.
 *
 * The tutor (M2-28): for an account with the tutor switched on (`tutor`,
 * decided on the server in src/app/(app)/layout.tsx from
 * `tutorEnabled(users.settings)`), the panel holds the note on top and the
 * tutor's chat under it (src/components/tutor/tutor-chat.tsx), with a handle
 * between them (a separator: drag it, or arrow keys up and down) to give
 * either part more room. From 700 px the panel's left edge is a second handle
 * (drag, or arrow keys left and right) that sets the panel's width, from
 * 360 px up to 70% of the window, remembered on this device
 * (localStorage['ready-notes-width']). On a phone the sheet keeps both parts
 * and the split handle; there is no width handle. The chat is about the
 * note's quote when it has one (a highlight, M9-16), otherwise about where she
 * is (the path). "Save to note" appends the answer to the body through the
 * same edit and save path as her typing, so the editor never overwrites it.
 * A new note's chat is keyed as tutor-chat.tsx explains (by place until the
 * note holds words, then by the note's id, fixed at the first question).
 * Without the switch none of this renders: the panel is exactly as above.
 *
 * Over a study session (M2-28 follow-up): with the switch on, the session offers "Ask about
 * this card" once a card is answered or revealed (src/components/session/ask-card.ts). That
 * opens the panel on a new note whose quote is the card in plain text, and the chat is the
 * card's (keyed by the place, never by the note; the quote is not sent to the tutor, which reads
 * the card itself from `where`, after she answered it, and only where her course allows it).
 * Only this kind of open works during a session, and only with the switch; any other stays shut
 * as before. The session marks everything but itself inert, so while this panel is open its
 * layer on <body> takes the inert mark off itself and sits above the session; the layer is
 * `data-open` meanwhile, so the session's keys and its Escape stand down (Escape closes the
 * panel only). When the card leaves the screen (next card, the end, leaving the session) the
 * panel closes, so a later card never shows in it before she has answered that one.
 *
 * `Notepad` wires the path and the real actions; `NotepadView` takes both as
 * props so tests can drive it.
 */
import { AnimatePresence, motion } from "motion/react";
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { notepadContext, saveNotepad } from "@/app/(app)/notes/actions";
import type { NotepadContextResult, NotepadSaveResult } from "@/app/(app)/notes/actions";
import { addCardsFromNote, noteCardExams } from "@/app/(app)/notes/card-actions";
import type { AddCardsResult, ExamChoice, ExamChoicesResult } from "@/app/(app)/notes/card-actions";
import { DraftCards, type DraftMessage } from "@/components/notes/draft-cards";
import { TutorChat, whereFromPage, type TutorApi, type TutorPreview } from "@/components/tutor/tutor-chat";
import { NOTEPAD_CARD_GONE_EVENT, NOTEPAD_OPEN_EVENT, type CardAsk } from "@/components/session/ask-card";
import { Button } from "@/components/ui/button";
import { showToast } from "@/components/ui/toast";
import { inertOthers } from "@/lib/a11y/inert";
import { attachFromPath, GENERAL } from "@/lib/notes/attach";
import { toCards, usableCards, type DraftCard } from "@/lib/notes/to-cards";
import { ease } from "@/lib/motion/tokens";
import { fade } from "@/lib/motion/transitions";
import { useMotionMode } from "@/lib/motion/use-calm";
import "./notepad.css";

export type NotepadActions = {
  save: (input: SaveInput) => Promise<NotepadSaveResult>;
  context: (path: string) => Promise<NotepadContextResult>;
  addCards: (noteId: string, cards: DraftCard[], examId?: string) => Promise<AddCardsResult>;
  exams: () => Promise<ExamChoicesResult>;
};

/** The drafts view: the rows, the General note's exam choice, the last answer. */
type CardsView = {
  rows: DraftCard[];
  /** Left out for a note with a course; null while her exams load. */
  exams?: ExamChoice[] | null;
  examId: string;
  busy: boolean;
  message: DraftMessage | null;
};

type SaveInput = {
  id?: string;
  path?: string;
  title: string;
  body: string;
  quote: string | null;
  highlighted: boolean;
};

type Draft = { title: string; body: string; quote: string | null; highlighted: boolean };

type SaveState = "idle" | "saved" | "failed";

export const SAVE_PAUSE_MS = 600;
export const HINT_MS = 4500;
const RETRY_FIRST_MS = 2000;
const RETRY_MAX_MS = 30_000;
/** Tries left for a note whose drawer is closed before it gives up. */
const RETRIES_AFTER_CLOSE = 6;
const WIDE_QUERY = "(min-width: 700px)";
const HINT_KEY = "ready-notes-hint";
const OPEN_EVENT = NOTEPAD_OPEN_EVENT;
/** Fired on window after each save that stored a note; detail is `NoteSavedDetail`. */
export const NOTE_SAVED_EVENT = "ready:note-saved";

/** A stored note to open again (M9-14). `label` is its attachment chip text. */
export type OpenNote = {
  id: string;
  title: string;
  body: string;
  quote: string | null;
  highlighted: boolean;
  label: string;
};

/** `created` is true for the save that first stored the note. */
export type NoteSavedDetail = Draft & { id: string; created: boolean };
/** Visual viewport this much shorter than the window means the keyboard is up. */
const KEYBOARD_PX = 150;

/** With the tutor: the panel's width on wide screens (px), and the note's share of the height (%). */
export const WIDTH_MIN = 360;
export const WIDTH_DEFAULT = 420;
const WIDTH_MAX_SHARE = 0.7;
const WIDTH_STEP = 24;
export const WIDTH_KEY = "ready-notes-width";
export const SPLIT_MIN = 20;
export const SPLIT_MAX = 80;
const SPLIT_DEFAULT = 45;
const SPLIT_STEP = 5;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const widthMax = (viewport: number) => Math.max(WIDTH_MIN, Math.floor(viewport * WIDTH_MAX_SHARE));

function storedWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(n) && n >= WIDTH_MIN ? Math.round(n) : WIDTH_DEFAULT;
  } catch {
    return WIDTH_DEFAULT;
  }
}

function rememberWidth(px: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(px)));
  } catch {
    // Private window: the width is not remembered.
  }
}

function subscribeViewport(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function useViewportWidth(): number {
  return useSyncExternalStore(
    subscribeViewport,
    () => window.innerWidth,
    () => 1200,
  );
}

function isEmpty(d: Draft): boolean {
  return d.title.trim() === "" && d.body.trim() === "";
}

/**
 * One note's saves, in order. Lives outside React state so a save still
 * lands after the drawer has closed.
 */
class NoteSaver {
  private id: string | null = null;
  private latest: Draft;
  private dirty = false;
  private inflight = false;
  private pause: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retryMs = RETRY_FIRST_MS;
  private onState: ((s: SaveState) => void) | null;
  private triesLeft = Infinity;
  private waiters: ((id: string | null) => void)[] = [];

  constructor(
    private readonly path: string,
    draft: Draft,
    private readonly save: NotepadActions["save"],
    onState: (s: SaveState) => void,
    id: string | null = null,
  ) {
    this.id = id;
    this.latest = draft;
    this.onState = onState;
  }

  /** She typed: wait for the pause. */
  change(draft: Draft): void {
    this.latest = draft;
    this.dirty = true;
    clearTimeout(this.pause);
    this.pause = setTimeout(() => this.flush(), SAVE_PAUSE_MS);
  }

  /** Send now (the pause ended, a retry, or the drawer closed). */
  flush(): void {
    clearTimeout(this.pause);
    clearTimeout(this.retry);
    if (this.inflight || !this.dirty) return;
    if (this.id === null && isEmpty(this.latest)) {
      // Nothing stored and nothing to store: an empty note is discarded.
      this.dirty = false;
      return;
    }
    const sent = this.latest;
    this.dirty = false;
    this.inflight = true;
    const input: SaveInput =
      this.id === null ? { path: this.path, ...sent } : { id: this.id, ...sent };
    this.save(input)
      .then((r) => {
        this.inflight = false;
        if (r.ok) {
          const created = this.id === null;
          this.id = r.id;
          if (r.id !== null) {
            const detail: NoteSavedDetail = { ...sent, id: r.id, created };
            window.dispatchEvent(new CustomEvent(NOTE_SAVED_EVENT, { detail }));
          }
          this.retryMs = RETRY_FIRST_MS;
          if (this.dirty) this.flush();
          else this.onState?.("saved");
          this.wake();
          return;
        }
        if (r.reason === "not_found") this.id = null; // deleted elsewhere: store it again
        this.failed(sent, r.reason !== "invalid");
        this.wake();
      })
      .catch(() => {
        this.inflight = false;
        this.failed(sent, true);
        this.wake();
      });
  }

  /**
   * Send what is left and wait for it: the stored id once her latest words
   * are stored, or null when they could not be (a failed save, or nothing
   * to store).
   */
  settled(): Promise<string | null> {
    this.flush();
    if (!this.inflight) return Promise.resolve(this.dirty ? null : this.id);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private wake(): void {
    if (this.inflight) return;
    const id = this.dirty ? null : this.id;
    for (const w of this.waiters.splice(0)) w(id);
  }

  /** Drawer closed: send what is left; no more marks. */
  close(): void {
    this.onState = null;
    this.triesLeft = RETRIES_AFTER_CLOSE;
    this.flush();
  }

  private failed(sent: Draft, again: boolean): void {
    if (!this.dirty) {
      this.latest = sent;
      this.dirty = true;
    }
    this.onState?.("failed");
    if (!again || this.triesLeft <= 0) return;
    this.triesLeft -= 1;
    this.retry = setTimeout(() => this.flush(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }
}

/**
 * Opens the notepad on a new note, from anywhere (M9-16 passes the selected
 * text), or on a stored note when `note` is given (M9-14); `cards` opens it
 * with the draft cards showing (M9-17).
 */
export function openNotepad(detail: { quote?: string; note?: OpenNote; cards?: boolean } = {}): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }));
}

function subscribeWide(onChange: () => void) {
  const media = window.matchMedia(WIDE_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}

function subscribeKeyboard(onChange: () => void) {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  vv.addEventListener("resize", onChange);
  window.addEventListener("resize", onChange);
  return () => {
    vv.removeEventListener("resize", onChange);
    window.removeEventListener("resize", onChange);
  };
}

function useKeyboardUp(): boolean {
  return useSyncExternalStore(
    subscribeKeyboard,
    () => {
      const vv = window.visualViewport;
      return vv ? window.innerHeight - vv.height > KEYBOARD_PX : false;
    },
    () => false,
  );
}

const noopSubscribe = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

function hintSeen(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return true;
  }
}

function rememberHint(): void {
  try {
    localStorage.setItem(HINT_KEY, "1");
  } catch {
    // Private window: the hint may show again next time.
  }
}

/** Focus is in a field she types in. */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(type);
}

const FOCUSABLE =
  "a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 19l1.2-4.2 9.6-9.6a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8l-9.6 9.6z" />
      <path d="M14.5 6.5l3 3" />
      <path d="M5 19l4.2-1.2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

const EMPTY: Draft = { title: "", body: "", quote: null, highlighted: false };

export type NotepadViewProps = {
  pathname: string | null;
  actions: NotepadActions;
  /** The tutor is switched on for her account (M2-28): the chat sits under the note. */
  tutor?: boolean;
  /** Tests and /dev/tutor: the tutor's requests and clipboard. */
  tutorApi?: TutorApi;
  /** /dev/tutor: the chat already in a state. */
  tutorPreview?: TutorPreview;
};

export function Notepad({ tutor = false }: { tutor?: boolean }) {
  const pathname = usePathname();
  return <NotepadView pathname={pathname} actions={REAL_ACTIONS} tutor={tutor} />;
}

const REAL_ACTIONS: NotepadActions = {
  save: saveNotepad,
  context: notepadContext,
  addCards: addCardsFromNote,
  exams: noteCardExams,
};

/** What the drawer says after "Add N cards", when it stays open. */
function skippedText(skipped: number, added: number): string {
  if (added === 0) return skipped === 1 ? "You already have this card." : "You already have these cards.";
  return skipped === 1
    ? "1 was already one of your cards, so it was left out."
    : `${skipped} were already your cards, so they were left out.`;
}

const ADD_FAILED = "Could not add these yet. Try again.";

export function NotepadView({ pathname, actions, tutor = false, tutorApi, tutorPreview }: NotepadViewProps) {
  const mounted = useMounted();
  const wide = useWide();
  const keyboardUp = useKeyboardUp();
  const mode = useMotionMode();
  const viewport = useViewportWidth();

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [label, setLabel] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [hint, setHint] = useState(false);
  const [cards, setCards] = useState<CardsView | null>(null);
  /** Bumped per drafts view, so a late answer for an old one is ignored. */
  const cardsSeq = useRef(0);
  const firstFrontRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Bumped per note, so a late chip answer for an old note is ignored. */
  const noteSeq = useRef(0);
  /** The tutor's chat: one per note opened (`seq` remounts it), and the note's stored id then. */
  const [chat, setChat] = useState<{ seq: number; noteId: string | null }>({ seq: 0, noteId: null });
  const [split, setSplit] = useState(SPLIT_DEFAULT);
  const [width, setWidth] = useState(storedWidth);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<Draft>(EMPTY);
  /** Open over a study session about this card ("Ask about this card"), and the path then. */
  const [cardAnchor, setCardAnchor] = useState<{ id: string; path: string } | null>(null);

  const saver = useRef<NoteSaver | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const fabRef = useRef<HTMLButtonElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const path = pathname ?? "/";
  const inSession = path === "/study" || path.startsWith("/study/");
  const onAssignment = attachFromPath(path).kind === "assignment";

  // The "Notes" word on the button: wide screens, first time on Home.
  useEffect(() => {
    if (!wide || path !== "/home" || hintSeen()) return;
    rememberHint();
    const show = setTimeout(() => setHint(true), 0);
    const fold = setTimeout(() => setHint(false), HINT_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(fold);
    };
  }, [wide, path]);

  /** Her exams for a General note's "Which exam?"; one exam is picked for her. */
  const loadExams = useCallback(
    (seq: number) => {
      const done = (r: ExamChoicesResult | null) => {
        if (cardsSeq.current !== seq) return;
        setCards((c) => {
          if (!c) return c;
          if (!r?.ok) return { ...c, message: { kind: "text", text: "Could not load your exams yet. Try again." } };
          return { ...c, exams: r.exams, examId: c.examId || (r.exams.length === 1 ? r.exams[0].id : "") };
        });
      };
      actions.exams().then(done, () => done(null));
    },
    [actions],
  );

  /** The drafts from the body, replacing any shown. */
  const showDrafts = useCallback(
    (body: string, chip: string | null) => {
      const seq = ++cardsSeq.current;
      const general = chip === GENERAL;
      setCards({ rows: toCards(body), exams: general ? null : undefined, examId: "", busy: false, message: null });
      if (general) loadExams(seq);
      requestAnimationFrame(() => {
        firstFrontRef.current?.focus({ preventScroll: true });
        const sc = scrollRef.current;
        if (sc) setTimeout(() => sc.scrollTo?.({ top: sc.scrollHeight, behavior: mode === "full" ? "smooth" : "auto" }), 80);
      });
    },
    [loadExams, mode],
  );

  const startNote = useCallback(
    (quote: string | null, stored?: OpenNote, withCards = false, cardId?: string) => {
      saver.current?.close();
      cardsSeq.current += 1;
      setCards(null);
      const seq = ++noteSeq.current;
      const fresh: Draft = stored
        ? { title: stored.title, body: stored.body, quote: stored.quote, highlighted: stored.highlighted }
        : { ...EMPTY, quote };
      setDraft(fresh);
      setSaveState("idle");
      setChat({ seq, noteId: stored?.id ?? null });
      setCardAnchor(cardId ? { id: cardId, path } : null);
      const onState = (s: SaveState) => {
        if (noteSeq.current === seq) setSaveState(s);
      };
      if (stored) {
        setLabel(stored.label);
        saver.current = new NoteSaver(path, fresh, actions.save, onState, stored.id);
      } else {
        setLabel(attachFromPath(path).kind === "general" ? GENERAL : null);
        saver.current = new NoteSaver(path, fresh, actions.save, onState);
        actions
          .context(path)
          .then((r) => {
            if (noteSeq.current === seq) setLabel(r.ok ? r.label : GENERAL);
          })
          .catch(() => {
            if (noteSeq.current === seq) setLabel(GENERAL);
          });
      }
      if (!open) {
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      setHint(false);
      setOpen(true);
      if (stored && withCards) {
        // From the Notes tab's "Turn into cards": the drafts focus their first field.
        showDrafts(stored.body, stored.label);
        return;
      }
      // Title first; the body when the note starts with a quote.
      requestAnimationFrame(() => {
        const target = quote ? bodyRef.current : titleRef.current;
        target?.focus({ preventScroll: true });
      });
    },
    [actions, open, path, showDrafts],
  );

  const addCards = async () => {
    if (!cards || cards.busy) return;
    const seq = cardsSeq.current;
    const rows = usableCards(cards.rows);
    const examId = cards.examId || undefined;
    const update = (f: (c: CardsView) => CardsView) => {
      if (cardsSeq.current === seq) setCards((c) => (c ? f(c) : c));
    };
    const fail = () => update((c) => ({ ...c, busy: false, message: { kind: "text", text: ADD_FAILED } }));
    update((c) => ({ ...c, busy: true, message: null }));
    try {
      const id = (await saver.current?.settled()) ?? null;
      if (cardsSeq.current !== seq) return;
      if (!id) return fail();
      const r = await actions.addCards(id, rows, examId);
      if (r.ok) {
        // The toast only when something was really stored.
        if (r.added > 0) showToast(`Added to ${r.course}. First review today.`);
        if (r.skipped === 0) {
          if (cardsSeq.current === seq) {
            cardsSeq.current += 1;
            setCards(null);
          }
          return;
        }
        update((c) => ({ ...c, busy: false, message: { kind: "text", text: skippedText(r.skipped, r.added) } }));
        return;
      }
      if (r.reason === "no_exam") {
        update((c) => ({ ...c, busy: false, message: { kind: "no_exam" } }));
        return;
      }
      if (r.reason === "choose_exam") {
        // The chip had not said General yet (or the chosen exam has passed): ask.
        const asked = cards.exams !== undefined;
        update((c) => ({
          ...c,
          busy: false,
          exams: c.exams === undefined ? null : c.exams,
          examId: "",
          message: asked ? { kind: "text", text: "Pick the exam these are for." } : null,
        }));
        if (!asked) loadExams(seq);
        return;
      }
      fail();
    } catch {
      fail();
    }
  };

  const close = useCallback(() => {
    if (!open) return;
    cardsSeq.current += 1;
    setCards(null);
    saver.current?.close();
    saver.current = null;
    noteSeq.current += 1;
    setOpen(false);
    setCardAnchor(null);
    const back = opener.current;
    opener.current = null;
    requestAnimationFrame(() => {
      if (back && back.isConnected && back.offsetParent !== null && !back.closest("[inert]")) {
        back.focus({ preventScroll: true });
      } else {
        fabRef.current?.focus({ preventScroll: true });
      }
    });
  }, [open]);

  const edit = (next: Draft) => {
    setDraft(next);
    setSaveState("idle");
    saver.current?.change(next);
  };

  // The latest words, for "Save to note" (which appends to them).
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  /** "Save to note": the answer goes at the end of the body, saved like her typing. */
  const appendToBody = (text: string) => {
    const d = draftRef.current;
    const body = d.body.trim() ? `${d.body.replace(/\s+$/, "")}\n\n${text}` : text;
    const next = { ...d, body };
    draftRef.current = next;
    edit(next);
  };

  const resolveNoteId = useCallback(() => saver.current?.settled() ?? Promise.resolve(null), []);
  const tutorWhere = useCallback(() => whereFromPage(path, typeof document === "undefined" ? null : document), [path]);

  // The split handle: drag it, or arrow keys (the note's share of the height).
  const onSplitDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = splitRef.current;
    if (!box || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = box.getBoundingClientRect();
      if (r.height > 0) setSplit(Math.round(clamp(((ev.clientY - r.top) / r.height) * 100, SPLIT_MIN, SPLIT_MAX)));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const onSplitKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const next =
      e.key === "ArrowUp" ? split - SPLIT_STEP
      : e.key === "ArrowDown" ? split + SPLIT_STEP
      : e.key === "Home" ? SPLIT_MIN
      : e.key === "End" ? SPLIT_MAX
      : null;
    if (next === null) return;
    e.preventDefault();
    setSplit(clamp(next, SPLIT_MIN, SPLIT_MAX));
  };

  // The panel's edge (wide screens): drag it, or arrow keys; remembered on this device.
  const maxWidth = widthMax(viewport);
  const panelWidth = clamp(width, WIDTH_MIN, maxWidth);
  const onEdgeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    let last = panelWidth;
    const move = (ev: PointerEvent) => {
      last = Math.round(clamp(window.innerWidth - ev.clientX, WIDTH_MIN, widthMax(window.innerWidth)));
      setWidth(last);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      rememberWidth(last);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const onEdgeKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const next =
      e.key === "ArrowLeft" ? panelWidth + WIDTH_STEP
      : e.key === "ArrowRight" ? panelWidth - WIDTH_STEP
      : e.key === "Home" ? WIDTH_MIN
      : e.key === "End" ? maxWidth
      : null;
    if (next === null) return;
    e.preventDefault();
    const w = clamp(next, WIDTH_MIN, maxWidth);
    setWidth(w);
    rememberWidth(w);
  };

  // N and Escape, for the whole app.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        close();
      }
      return;
    }
    if (e.key !== "n" && e.key !== "N") return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (typingIn(e.target) || typingIn(document.activeElement)) return;
    if (inSession) return;
    // Another modal (a sheet, the hand-in) owns the keys while it is up.
    const modal = document.querySelector('[aria-modal="true"]');
    if (modal && !panelRef.current?.contains(modal)) return;
    e.preventDefault();
    startNote(null);
  });

  useEffect(() => {
    const keydown = (e: KeyboardEvent) => onKey(e);
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ quote?: string; note?: OpenNote; cards?: boolean; card?: CardAsk["card"] }>).detail;
      if (detail?.card) {
        // "Ask about this card": only over a session, only with the tutor switched on.
        const quote = detail.quote?.trim();
        if (!tutor || !inSession || typeof detail.card.id !== "string" || !quote) return;
        startNote(quote, undefined, false, detail.card.id);
        return;
      }
      if (detail?.note) {
        startNote(null, detail.note, detail.cards === true);
        return;
      }
      const quote = detail?.quote?.trim();
      startNote(quote ? quote : null);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [startNote, tutor, inSession]);

  // The card it was opened for left the screen: close, so the next card never shows here.
  useEffect(() => {
    if (!open || !cardAnchor) return;
    const gone = () => close();
    window.addEventListener(NOTEPAD_CARD_GONE_EVENT, gone);
    return () => window.removeEventListener(NOTEPAD_CARD_GONE_EVENT, gone);
  }, [open, cardAnchor, close]);

  // Over the session, which made everything else inert (this layer too): take the mark off.
  // Once closed the layer is empty, and the session's own undo clears it in the end anyway.
  const overSession = open && cardAnchor !== null;
  useEffect(() => {
    const layer = layerRef.current;
    if (!overSession || !layer) return;
    layer.inert = false;
    layer.removeAttribute("aria-hidden");
  }, [overSession, mounted]);

  // Phones: the sheet is modal, so the rest of the app is inert.
  const modal = open && !wide;
  useEffect(() => {
    const layer = layerRef.current;
    if (!modal || !layer) return;
    return inertOthers(layer);
  }, [modal, mounted]);

  // Leaving for a study session closes the drawer (the session covers the screen); a panel
  // opened over the session for a card closes when she leaves that page.
  useEffect(() => {
    if (open && (cardAnchor ? cardAnchor.path !== path : inSession)) {
      const t = setTimeout(close, 0);
      return () => clearTimeout(t);
    }
  }, [inSession, open, close, cardAnchor, path]);

  // The body grows with what she writes.
  useEffect(() => {
    const ta = bodyRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [draft.body, open]);

  const onPanelKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (!modal || e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const list = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
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

  const addListLine = () => {
    const ta = bodyRef.current;
    const v = draft.body;
    let s = ta ? ta.selectionStart : v.length;
    const lineStart = v.lastIndexOf("\n", s - 1) + 1;
    let body = v;
    if (v.slice(lineStart, lineStart + 2) !== "- ") {
      body = v.slice(0, lineStart) + "- " + v.slice(lineStart);
      s += 2;
    }
    edit({ ...draft, body });
    requestAnimationFrame(() => {
      const t = bodyRef.current;
      if (!t) return;
      t.focus();
      t.selectionStart = t.selectionEnd = s;
    });
  };

  const fabHidden = inSession || open || (!wide && keyboardUp);
  const full = mode === "full";
  const instant = mode === "instant";
  const panelAnim = full
    ? {
        initial: wide ? { x: "100%" } : { y: "100%" },
        animate: wide ? { x: 0 } : { y: 0 },
        exit: wide
          ? { x: "100%", transition: { duration: 0.24, ease: ease.inout } }
          : { y: "100%", transition: { duration: 0.24, ease: ease.inout } },
        transition: { type: "spring" as const, bounce: 0, duration: 0.35 },
      }
    : fade(mode);
  const scrimAnim = full
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0, transition: { duration: 0.24, ease: "linear" as const } },
        transition: { duration: 0.2, ease: "linear" as const },
      }
    : fade(mode);
  const savedText = saveState === "saved" ? "Saved" : saveState === "failed" ? "Not saved yet" : "";

  const fab = fabHidden ? null : (
    <button
      ref={fabRef}
      type="button"
      className={`pad-fab${onAssignment ? " high" : ""}${hint ? " hint" : ""}`}
      aria-label="Notes, open the notepad"
      aria-keyshortcuts="N"
      aria-expanded={open}
      aria-controls="notepad"
      data-testid="notepad-button"
      onClick={() => {
        rememberHint();
        startNote(null);
      }}
    >
      <PencilIcon />
      {hint ? (
        <span className="pad-fab-word" aria-hidden="true">
          Notes
        </span>
      ) : null}
    </button>
  );

  const noteParts = (
    <>
      <div className="np-scroll" ref={scrollRef}>
        <div className="np-tw">
          {draft.highlighted ? (
            <span className={`np-mark${full ? " wipe" : ""}`} aria-hidden="true" />
          ) : null}
          <label className="sr-only" htmlFor="np-title">
            Title
          </label>
          <input
            ref={titleRef}
            id="np-title"
            className="np-title"
            type="text"
            placeholder="Title"
            autoComplete="off"
            value={draft.title}
            onChange={(e) => edit({ ...draft, title: e.target.value })}
          />
        </div>
        {draft.quote ? <blockquote className="np-quote">{draft.quote}</blockquote> : null}
        <label className="sr-only" htmlFor="np-body">
          Note
        </label>
        <textarea
          ref={bodyRef}
          id="np-body"
          className="np-body"
          rows={7}
          placeholder="Write the thing you keep forgetting."
          value={draft.body}
          onChange={(e) => edit({ ...draft, body: e.target.value })}
        />
        <div className="np-tools" role="group" aria-label="Format">
          <button type="button" className="np-tool" onClick={addListLine}>
            <span className="np-pill">• List</span>
          </button>
          <button
            type="button"
            className="np-tool"
            aria-pressed={draft.highlighted}
            onClick={() => edit({ ...draft, highlighted: !draft.highlighted })}
          >
            <span className="np-pill">Highlight</span>
          </button>
        </div>
        {cards ? (
          <DraftCards
            rows={cards.rows}
            onRows={(rows) => setCards((c) => (c ? { ...c, rows } : c))}
            exams={cards.exams}
            examId={cards.examId}
            onExam={(examId) => setCards((c) => (c ? { ...c, examId, message: null } : c))}
            busy={cards.busy}
            message={cards.message}
            onAdd={addCards}
            firstRef={firstFrontRef}
          />
        ) : null}
      </div>
      <div className="np-actions">
        <Button variant="secondary" onClick={() => showDrafts(draft.body, label)}>
          Turn into cards
        </Button>
        <Button variant="primary" onClick={close}>
          Done
        </Button>
      </div>
    </>
  );

  const drawer = (
    <div ref={layerRef} data-notepad-layer="" data-open={open ? "" : undefined}>
      <AnimatePresence>
        {open && !wide ? (
          <motion.div
            key="scrim"
            {...scrimAnim}
            aria-hidden="true"
            className={overSession ? "np-scrim over" : "np-scrim"}
            data-testid="notepad-scrim"
            onClick={close}
          />
        ) : null}
        {open ? (
          <motion.section
            key="notepad"
            {...panelAnim}
            ref={panelRef}
            id="notepad"
            role="dialog"
            aria-modal={wide ? undefined : true}
            aria-labelledby="np-h"
            data-layout={wide ? "side" : "bottom"}
            data-testid="notepad"
            className={`${tutor ? "np tutor" : "np"}${overSession ? " over" : ""}`}
            style={tutor && wide ? { width: panelWidth } : undefined}
            onKeyDown={onPanelKey}
          >
            {tutor && wide ? (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize the notes panel"
                aria-valuemin={WIDTH_MIN}
                aria-valuemax={maxWidth}
                aria-valuenow={panelWidth}
                aria-valuetext={`${panelWidth} pixels wide`}
                tabIndex={0}
                className="np-edge"
                data-testid="notepad-edge"
                onPointerDown={onEdgeDown}
                onKeyDown={onEdgeKey}
              />
            ) : null}
            {wide ? null : <div className="np-handle" aria-hidden="true" />}
            <h2 className="sr-only" id="np-h">
              Notepad
            </h2>
            <div className="np-head">
              <span className="np-chip mono" data-testid="notepad-chip">
                {label ?? " "}
              </span>
              <span
                className={`mono np-saved${saveState === "failed" ? " failed" : ""}${instant ? " instant" : ""}`}
                aria-live="polite"
                data-testid="notepad-saved"
                key={savedText}
              >
                {savedText}
              </span>
              <Button variant="icon" aria-label="Close notepad" onClick={close} className="np-close">
                <CloseIcon />
              </Button>
            </div>
            {tutor ? (
              <div className="np-split" ref={splitRef}>
                <div className="np-top" id="np-top" style={{ flexBasis: `calc(${split}% - 12px)` }}>
                  {noteParts}
                </div>
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize the note and the tutor"
                  aria-controls="np-top"
                  aria-valuemin={SPLIT_MIN}
                  aria-valuemax={SPLIT_MAX}
                  aria-valuenow={split}
                  aria-valuetext={`Note ${split}% of the height`}
                  tabIndex={0}
                  className="np-split-handle"
                  data-testid="notepad-split"
                  onPointerDown={onSplitDown}
                  onKeyDown={onSplitKey}
                >
                  <span aria-hidden="true" />
                </div>
                <div className="np-chat">
                  <TutorChat
                    key={chat.seq}
                    noteId={chat.noteId}
                    quote={draft.quote}
                    card={cardAnchor !== null}
                    where={tutorWhere}
                    resolveNoteId={resolveNoteId}
                    onSaveToNote={appendToBody}
                    api={tutorApi}
                    preview={tutorPreview}
                  />
                </div>
              </div>
            ) : (
              noteParts
            )}
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );

  return (
    <>
      {fab}
      {mounted ? createPortal(drawer, document.body) : null}
    </>
  );
}
