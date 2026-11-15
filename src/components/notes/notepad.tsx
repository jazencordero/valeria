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
 * "Highlight" (butter marker behind the title); "Turn into cards" (disabled
 * until M9-17 builds it) and "Done".
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
} from "react";
import { createPortal } from "react-dom";
import { notepadContext, saveNotepad } from "@/app/(app)/notes/actions";
import type { NotepadContextResult, NotepadSaveResult } from "@/app/(app)/notes/actions";
import { Button } from "@/components/ui/button";
import { inertOthers } from "@/lib/a11y/inert";
import { attachFromPath, GENERAL } from "@/lib/notes/attach";
import { ease } from "@/lib/motion/tokens";
import { fade } from "@/lib/motion/transitions";
import { useMotionMode } from "@/lib/motion/use-calm";
import "./notepad.css";

export type NotepadActions = {
  save: (input: SaveInput) => Promise<NotepadSaveResult>;
  context: (path: string) => Promise<NotepadContextResult>;
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
const OPEN_EVENT = "ready:notepad";
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
          return;
        }
        if (r.reason === "not_found") this.id = null; // deleted elsewhere: store it again
        this.failed(sent, r.reason !== "invalid");
      })
      .catch(() => {
        this.inflight = false;
        this.failed(sent, true);
      });
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
 * text), or on a stored note when `note` is given (M9-14).
 */
export function openNotepad(detail: { quote?: string; note?: OpenNote } = {}): void {
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
};

export function Notepad() {
  const pathname = usePathname();
  return <NotepadView pathname={pathname} actions={REAL_ACTIONS} />;
}

const REAL_ACTIONS: NotepadActions = { save: saveNotepad, context: notepadContext };

export function NotepadView({ pathname, actions }: NotepadViewProps) {
  const mounted = useMounted();
  const wide = useWide();
  const keyboardUp = useKeyboardUp();
  const mode = useMotionMode();

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [label, setLabel] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [hint, setHint] = useState(false);
  /** Bumped per note, so a late chip answer for an old note is ignored. */
  const noteSeq = useRef(0);

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

  const startNote = useCallback(
    (quote: string | null, stored?: OpenNote) => {
      saver.current?.close();
      const seq = ++noteSeq.current;
      const fresh: Draft = stored
        ? { title: stored.title, body: stored.body, quote: stored.quote, highlighted: stored.highlighted }
        : { ...EMPTY, quote };
      setDraft(fresh);
      setSaveState("idle");
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
      // Title first; the body when the note starts with a quote.
      requestAnimationFrame(() => {
        const target = quote ? bodyRef.current : titleRef.current;
        target?.focus({ preventScroll: true });
      });
    },
    [actions, open, path],
  );

  const close = useCallback(() => {
    if (!open) return;
    saver.current?.close();
    saver.current = null;
    noteSeq.current += 1;
    setOpen(false);
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
      const detail = (e as CustomEvent<{ quote?: string; note?: OpenNote }>).detail;
      if (detail?.note) {
        startNote(null, detail.note);
        return;
      }
      const quote = detail?.quote?.trim();
      startNote(quote ? quote : null);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [startNote]);

  // Phones: the sheet is modal, so the rest of the app is inert.
  const modal = open && !wide;
  useEffect(() => {
    const layer = layerRef.current;
    if (!modal || !layer) return;
    return inertOthers(layer);
  }, [modal, mounted]);

  // Leaving for a study session closes the drawer (the session covers the screen).
  useEffect(() => {
    if (inSession && open) {
      const t = setTimeout(close, 0);
      return () => clearTimeout(t);
    }
  }, [inSession, open, close]);

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
      aria-label="Notepad"
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

  const drawer = (
    <div ref={layerRef} data-notepad-layer="">
      <AnimatePresence>
        {open && !wide ? (
          <motion.div
            key="scrim"
            {...scrimAnim}
            aria-hidden="true"
            className="np-scrim"
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
            className="np"
            onKeyDown={onPanelKey}
          >
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
            <div className="np-scroll">
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
            </div>
            <div className="np-actions">
              {/* M9-17 builds "Turn into cards"; until then it is shown but off. */}
              <Button variant="secondary" disabled>
                Turn into cards
              </Button>
              <Button variant="primary" onClick={close}>
                Done
              </Button>
            </div>
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
