/**
 * "Ask about this card" (M2-28 follow-up): how a study session talks to the notes panel
 * (src/components/notes/notepad.tsx) without importing it (the panel pulls in Server Actions).
 *
 * - `askAboutCard` opens the panel over the session on a new note whose quote is the card, in
 *   plain text (`cardPassage`: its question and the answer she has just been shown), with the
 *   tutor's chat anchored to the card (the server keys a chat without a note by the card on
 *   screen, `anchor_kind` 'card'). The session offers it only for an account with the tutor
 *   switched on, and only once the card is answered or revealed (grade buttons or feedback
 *   strip on screen); the panel ignores it without the switch or outside a session.
 * - `cardMovedOn` closes that panel: the next card (or the end of the session) never shows in a
 *   panel opened for the card before, so nothing of a card reaches the tutor before she answers it.
 * - `notepadOver` is true while the panel is open over the session: the session's keys and its
 *   Escape stand down, so typing in the note or the chat never grades, continues or stops.
 */
import { clozeBlanks, type MatchPair, type McqOption } from "@/lib/study/card-schema";
import type { CardType } from "@/lib/study/bite";

/** The notes panel's open event (notepad.tsx listens for it; `openNotepad` sends the same). */
export const NOTEPAD_OPEN_EVENT = "ready:notepad";
/** The card the panel was opened for has left the screen. */
export const NOTEPAD_CARD_GONE_EVENT = "ready:notepad-card-gone";
/** The panel's layer on <body>, marked `data-open` while the panel is open. */
export const NOTEPAD_OVER_SELECTOR = "[data-notepad-layer][data-open]";
/** A note's quote is stored up to 4,000 characters (src/app/(app)/notes/actions.ts). */
export const PASSAGE_MAX = 4000;
export const ASK_CARD_TEXT = "Ask about this card";

/** The detail `askAboutCard` sends with the open event. */
export type CardAsk = { quote: string; card: { id: string } };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The card as plain text, as she sees it once answered: the question, then the answer shown. */
export function cardPassage(type: CardType, body: unknown): string {
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const q = str(b.q);
  let out: string;
  switch (type) {
    case "basic":
      out = `${q}\n\nAnswer: ${str(b.a)}`;
      break;
    case "cloze": {
      const blanked = q.replace(/\{\{([^}]*)\}\}/g, "____");
      const filled = q.replace(/\{\{([^}]*)\}\}/g, "$1");
      out = clozeBlanks(q).length ? `${blanked}\n\nAnswer: ${filled}` : filled;
      break;
    }
    case "mcq": {
      const opts = Array.isArray(b.opts) ? (b.opts as McqOption[]) : [];
      const right = opts.filter((o) => Array.isArray(o) && o[1] === true).map((o) => str(o[0]));
      out = `${q}\n\nAnswer: ${right.join("; ")}`;
      break;
    }
    case "match": {
      const pairs = Array.isArray(b.pairs) ? (b.pairs as MatchPair[]) : [];
      const lines = pairs.filter(Array.isArray).map((p) => `${str(p[0])}: ${str(p[1])}`);
      out = [q, lines.join("\n")].filter(Boolean).join("\n\n");
      break;
    }
    case "explain":
      out = `${q}\n\nModel answer: ${str(b.model)}`;
      break;
    default:
      out = q;
  }
  return out.trim().slice(0, PASSAGE_MAX);
}

/** Opens the notes panel over the session about this card (only after she answered it). */
export function askAboutCard(cardId: string, quote: string): void {
  const detail: CardAsk = { quote, card: { id: cardId } };
  window.dispatchEvent(new CustomEvent(NOTEPAD_OPEN_EVENT, { detail }));
}

/** The card on screen changed or the session ended: a panel opened for a card closes. */
export function cardMovedOn(): void {
  window.dispatchEvent(new CustomEvent(NOTEPAD_CARD_GONE_EVENT));
}

/** The notes panel is open over the session. */
export function notepadOver(): boolean {
  return typeof document !== "undefined" && document.querySelector(NOTEPAD_OVER_SELECTOR) !== null;
}
