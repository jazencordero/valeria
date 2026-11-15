/**
 * A note's lines as draft recall cards (ticket M9-17). Pure.
 * Source: prototype merged.html JS 5815-5837 (draftCards).
 *
 * `toCards(body)`:
 * - each line loses a leading list mark ("- ", "• ", "* ", after any
 *   indent) and is trimmed; empty lines are dropped; at most 3 lines are
 *   kept (`MAX_CARDS`), the first three.
 * - "front: back" splits on the first colon, when the colon is not the
 *   first character;
 * - otherwise "front - back" splits on the first " - " (space, hyphen,
 *   space), when it is not at the start;
 * - otherwise the front is "Explain: <line>" and the back is the line.
 * Front and back are trimmed. A split can leave the back empty ("Heading:");
 * she can type one in the drafts view.
 *
 * `usableCards(rows)`: what "Add N cards" stores, the rows she edited with
 * both sides trimmed and every row whose front or back is empty skipped (a
 * recall card needs a question and an answer). The button's N is this
 * count, so it never promises a card that is not stored.
 *
 * Split by rule, not by AI (the ticket's cut).
 */

export type DraftCard = { front: string; back: string };

export const MAX_CARDS = 3;

const LIST_MARK = /^\s*[-•*]\s+/;

/** The note's lines that become cards: list marks off, trimmed, no empty ones, at most 3. */
export function noteLines(body: string): string[] {
  return body
    .split("\n")
    .map((s) => s.replace(LIST_MARK, "").trim())
    .filter(Boolean)
    .slice(0, MAX_CARDS);
}

/** One line as a card, by the three rules above. */
export function splitLine(line: string): DraftCard {
  const ci = line.indexOf(":");
  if (ci > 0) return { front: line.slice(0, ci).trim(), back: line.slice(ci + 1).trim() };
  const di = line.indexOf(" - ");
  if (di > 0) return { front: line.slice(0, di).trim(), back: line.slice(di + 3).trim() };
  return { front: `Explain: ${line}`, back: line };
}

export function toCards(body: string): DraftCard[] {
  return noteLines(body).map(splitLine);
}

/** Rows to store: trimmed, without any whose front or back is empty, at most 3. */
export function usableCards(rows: readonly DraftCard[]): DraftCard[] {
  return rows
    .map((r) => ({ front: r.front.trim(), back: r.back.trim() }))
    .filter((r) => r.front !== "" && r.back !== "")
    .slice(0, MAX_CARDS);
}

/** "Add 1 card", "Add 3 cards". */
export function addLabel(n: number): string {
  return `Add ${n} ${n === 1 ? "card" : "cards"}`;
}
