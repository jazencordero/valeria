"use client";

/**
 * Session keyboard: one key handler per state.
 * Source: prototype main-flow.html JS 3541-3566 (sessionKey).
 *
 *   useSessionKeys(
 *     { phase, cardType, gradeMode },
 *     { onReveal, onChoose, onGrade, onContinue, onCheck },
 *   );
 *
 * | State                         | Key                 | Does                           |
 * |-------------------------------|---------------------|--------------------------------|
 * | front, basic or cloze         | Space, Enter        | reveal / open the next blank   |
 * | front, mcq                    | 1-4                 | choose option 0-3              |
 * | front, typing in a text field | Cmd/Ctrl + Enter    | check the written answer       |
 * | graded, four buttons          | 1-4                 | grade 1-4                      |
 * | graded, two buttons           | 1 / 2               | grade 1 (Missed) / 3 (Got it)  |
 * | fb (feedback strip)           | Enter, Space        | continue                       |
 *
 * Escape is not handled here: `SessionFrame` owns it (opens and closes the stop
 * confirm, and calls preventDefault). While that confirm is open, or the
 * session is done, every key here is ignored. Typing in a textarea or input
 * never fires anything except Cmd/Ctrl + Enter. Events already
 * defaultPrevented, key repeats, IME composition and any other modifier
 * (Alt, Shift, Cmd or Ctrl on other keys) are ignored. No remapping.
 */
import { useEffect, useRef } from "react";
import type { CardType } from "@/lib/study/bite";
import type { Grade } from "@/lib/study/memory";
import type { GradeMode, SessionPhase } from "@/lib/study/session";

/** The frame's stop confirm (frame.tsx renders it with this role and label). */
export const STOP_CONFIRM_SELECTOR = '[role="group"][aria-label="Stop the session?"]';

/**
 * A focused button that is not the reveal button or a blank keeps Space and
 * Enter for itself. Mark reveal buttons with `data-reveal` and cloze blanks
 * with `data-blank` (or class `blank`).
 */
const REVEAL_TARGET = "[data-reveal],[data-blank],.blank";

export type SessionKeyState = {
  phase: SessionPhase;
  /** The current card's type; undefined when there is none. */
  cardType?: CardType;
  gradeMode: GradeMode;
  /** Extra pause from the caller (for example a sheet over the session). */
  paused?: boolean;
};

export type SessionKeyAction =
  | { type: "reveal" }
  | { type: "choose"; option: number }
  | { type: "grade"; g: Grade }
  | { type: "continue" }
  | { type: "check" };

export type SessionKeyHandlers = {
  onReveal?: () => void;
  /** 0-based option index. */
  onChoose?: (option: number) => void;
  onGrade?: (g: Grade) => void;
  onContinue?: () => void;
  onCheck?: () => void;
};

type KeyLike = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "defaultPrevented" | "repeat" | "isComposing" | "target"
>;

function isTextField(t: EventTarget | null): boolean {
  if (!t || typeof (t as Element).tagName !== "string") return false;
  const el = t as HTMLElement;
  return el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable === true;
}

/** Pure: what a key press means in this state, or null for nothing. */
export function sessionKeyAction(e: KeyLike, s: SessionKeyState): SessionKeyAction | null {
  if (e.defaultPrevented || e.repeat || e.isComposing) return null;
  if (e.key === "Escape") return null; // SessionFrame's.
  if (s.paused || s.phase === "done") return null;

  const cmd = e.metaKey || e.ctrlKey;
  if (isTextField(e.target)) {
    if (e.key === "Enter" && cmd && !e.altKey && !e.shiftKey && s.phase === "front") return { type: "check" };
    return null;
  }
  if (cmd || e.altKey || e.shiftKey) return null;

  const space = e.key === " " || e.key === "Spacebar";
  const enter = e.key === "Enter";

  if (s.phase === "fb") return space || enter ? { type: "continue" } : null;

  if (/^[1-4]$/.test(e.key)) {
    const n = Number(e.key);
    if (s.phase === "graded") {
      if (s.gradeMode === "two") return n === 1 ? { type: "grade", g: 1 } : n === 2 ? { type: "grade", g: 3 } : null;
      return { type: "grade", g: n as Grade };
    }
    if (s.phase === "front" && s.cardType === "mcq") return { type: "choose", option: n - 1 };
    return null;
  }

  if ((space || enter) && s.phase === "front" && (s.cardType === "basic" || s.cardType === "cloze")) {
    const t = e.target as Element | null;
    if (t && t.tagName === "BUTTON" && !t.closest(REVEAL_TARGET)) return null;
    return { type: "reveal" };
  }
  return null;
}

function stopConfirmOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector(STOP_CONFIRM_SELECTOR) !== null;
}

/** Listens on document while mounted; reads the latest state and handlers each press. */
export function useSessionKeys(state: SessionKeyState, handlers: SessionKeyHandlers): void {
  const latest = useRef({ state, handlers });
  useEffect(() => {
    latest.current = { state, handlers };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { state: s, handlers: h } = latest.current;
      const action = sessionKeyAction(e, { ...s, paused: s.paused || stopConfirmOpen() });
      if (!action) return;
      const run = {
        reveal: h.onReveal,
        choose: h.onChoose && action.type === "choose" ? () => h.onChoose!(action.option) : undefined,
        grade: h.onGrade && action.type === "grade" ? () => h.onGrade!(action.g) : undefined,
        continue: h.onContinue,
        check: h.onCheck,
      }[action.type];
      if (!run) return;
      e.preventDefault();
      run();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
