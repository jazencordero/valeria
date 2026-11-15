/**
 * Build a bite: the short study session behind "Start studying".
 *
 * Pure: no clock, no storage. The caller passes the deck, the card memory,
 * the concepts, the exam date and `now`. Rules are ticket M3-08 plus the
 * prototype's startSession (main-flow.html, lines 3079 to 3103).
 *
 * A bite has up to three sections, in this order (empty ones are left out):
 * - warm: 2 to 4 due reviews, most overdue first. A review is a card graded
 *   at least once whose due date (exam-aimed, `aimedDue`; the stored `dueAt`
 *   when the exam has started) is at or before `now`. Ties go to deck order.
 * - learn: 3 to 5 cards. Concepts are taken in focus order (`focusConcept`
 *   over the rest, so largest `weight * (1 - mastery)` first, ties by
 *   `order`). Within a concept she gets the cards at the lowest rung she has
 *   not passed (rungOf(mastery) + 1, capped at 5) and above, lowest rung
 *   first, cards she can study now (new or due) before ones scheduled later,
 *   then deck order. When every concept is used up and the bite is still
 *   short, remaining cards below those rungs fill in, in the same order.
 *
 *   Study order (M3-52), only for a deck where some card is marked `core` or
 *   `first` (a hand-made, seeded deck): new concepts open one at a time in
 *   study order; once started, a concept competes by focus score. A concept
 *   is started when one of its active cards (by `conceptId`) has been graded.
 *   Each pick is `focusConcept` over the started concepts left plus only the
 *   unstarted one with the lowest `order`; the other unstarted concepts wait
 *   their turn. So a fresh deck goes in `order`, and the next new concept
 *   opens as soon as it outscores the started ones (it scores its full
 *   weight, mastery 0). Within a concept the sort gains two keys in front:
 *   a never-graded `first` card comes first (it opens the concept), then
 *   `core` cards before the rest, then the order above. A deck with no core
 *   or first card is built exactly as before: the first-card and core keys
 *   are all equal there and the concept order is plain focus order.
 * - boss: 1 boss card whose concepts overlap today's concepts (the warm cards
 *   and the first three learn cards, which are always kept). Most overlap
 *   wins, then deck order. None when no boss card overlaps.
 *
 * Size: learn is sized so the total reaches 8 when it can
 * (`clamp(8 - warm - boss, 3, 5)`), so a full bite is 8 to 10 cards, inside
 * the ticket's 8 to 12. The section limits win over the total: with fewer
 * than two due reviews or a small deck a bite can be shorter than 8. A card
 * is never in a bite twice. Boss and inactive (suspended) cards never go in
 * warm or learn.
 *
 * `null` when today's plan is done (2 bites a day for an exam, 1 for a quiz)
 * or when the deck has nothing to put in a bite.
 *
 * `minutes = max(2, round(n * 0.6))`; `gainEstimate = max(2, round(n * 0.85))`
 * is the prototype's display formula, shown as "about".
 */

import { aimedDue, type Time } from "./exam-aim";
import { conceptMastery, focusConcept, rungOf } from "./ladder";
import { newCard, type MemoryState } from "./memory";

/** Card types, as in the prototype's TYPE_NAMES. */
export type CardType = "basic" | "cloze" | "explain" | "mcq" | "match";

export const TYPE_NAMES: Record<CardType, string> = {
  basic: "Recall cards",
  cloze: "Fill the gap",
  explain: "Explain it",
  mcq: "Quiz me",
  match: "Match pairs",
};

export type BiteCard = {
  id: string;
  /** The concept the card belongs to (counts toward that concept's mastery). */
  conceptId: string;
  /**
   * Every concept the card touches, for boss cards that mix concepts
   * (prototype cardConcepts). Defaults to `[conceptId]`.
   */
  conceptIds?: readonly string[];
  /** The rung this card trains, 1..5. */
  rung: 1 | 2 | 3 | 4 | 5;
  type: CardType;
  boss: boolean;
  /** False for a card she suspended or removed. */
  active: boolean;
  /** Essential: comes before the concept's other cards in learn. Default false. */
  core?: boolean;
  /** Opens its concept: shown first while never graded. Default false. */
  first?: boolean;
};

export type BiteConcept = {
  id: string;
  /** How much it counts on the exam. */
  weight: number;
  /** Position in the course; breaks focus ties. */
  order: number;
};

export type ExamKind = "exam" | "quiz";

/** What every session builder reads. `cards` is in deck order. */
export type Deck = {
  cards: readonly BiteCard[];
  /** Memory per card id. A card with no entry is new (never graded, due now). */
  states: Readonly<Record<string, MemoryState>>;
  concepts: readonly BiteConcept[];
  examAt: Time;
  now: Time;
};

export type BiteInput = Deck & {
  kind: ExamKind;
  bitesDoneToday: number;
};

export type SectionKind = "warm" | "learn" | "boss";
export type Section = [SectionKind, string[]];

export type Bite = {
  sections: Section[];
  minutes: number;
  gainEstimate: number;
};

export const BITES_PER_DAY: Record<ExamKind, number> = { exam: 2, quiz: 1 };

export const WARM_MIN = 2;
export const WARM_MAX = 4;
export const LEARN_MIN = 3;
export const LEARN_MAX = 5;
export const BITE_MIN = 8;
export const BITE_MAX = 12;

export const biteMinutes = (n: number) => Math.max(2, Math.round(n * 0.6));
export const biteGain = (n: number) => Math.max(2, Math.round(n * 0.85));

const ms = (t: Time) => (typeof t === "number" ? t : t.getTime());
const conceptsOf = (c: BiteCard) => c.conceptIds ?? [c.conceptId];

function stateOf(deck: Deck, id: string): MemoryState {
  return deck.states[id] ?? newCard(new Date(ms(deck.now)));
}

/** When the card is due: exam-aimed, or the stored date once the exam has started. */
function dueOf(deck: Deck, id: string): number {
  const s = stateOf(deck, id);
  return aimedDue(s, deck.examAt, deck.now) ?? s.dueAt;
}

const isDue = (deck: Deck, id: string) => dueOf(deck, id) <= ms(deck.now);

function session(sections: Section[]): Bite | null {
  const kept = sections.filter(([, ids]) => ids.length > 0);
  const n = kept.reduce((sum, [, ids]) => sum + ids.length, 0);
  if (n === 0) return null;
  return { sections: kept, minutes: biteMinutes(n), gainEstimate: biteGain(n) };
}

/** A seeded deck: some card says it is core or opens its concept. */
const usesStudyOrder = (deck: Deck) => deck.cards.some((c) => c.core === true || c.first === true);

const isGraded = (deck: Deck, id: string) => (deck.states[id]?.lastReviewAt ?? null) !== null;

/**
 * Concepts in focus order: repeatedly the focus concept of those left. With
 * `studyOrder`, unstarted concepts only compete one at a time, lowest
 * `order` first (see the header).
 */
function conceptsInFocusOrder(deck: Deck, studyOrder: boolean) {
  const examAt = new Date(ms(deck.examAt));
  const left = [...deck.concepts]
    .sort((a, b) => a.order - b.order)
    .map((c) => {
      const cards = deck.cards
        .filter((k) => k.conceptId === c.id)
        .map((k) => ({ state: stateOf(deck, k.id), active: k.active }));
      const mastery = conceptMastery(cards, examAt);
      const started = deck.cards.some((k) => k.conceptId === c.id && k.active && isGraded(deck, k.id));
      return { ...c, mastery, started, target: Math.min(5, rungOf(mastery) + 1) };
    });
  const out: typeof left = [];
  while (left.length > 0) {
    // `left` is in `order`, so the first unstarted one is the next to open.
    const nextNew = left.find((c) => !c.started);
    const pool = studyOrder ? left.filter((c) => c.started || c === nextNew) : left;
    const next = focusConcept(pool)!;
    out.push(next);
    left.splice(left.indexOf(next), 1);
  }
  return out;
}

export function buildBite(input: BiteInput): Bite | null {
  if (input.bitesDoneToday >= BITES_PER_DAY[input.kind]) return null;
  const deck: Deck = input;
  const now = ms(deck.now);
  const index = new Map(deck.cards.map((c, i) => [c.id, i]));
  const studyable = deck.cards.filter((c) => c.active && !c.boss);

  // Warm: due reviews, most overdue first.
  const warm = studyable
    .filter((c) => stateOf(deck, c.id).lastReviewAt !== null)
    .map((c) => ({ c, due: dueOf(deck, c.id) }))
    .filter((x) => x.due <= now)
    .sort((a, b) => a.due - b.due || index.get(a.c.id)! - index.get(b.c.id)!)
    .slice(0, WARM_MAX)
    .map((x) => x.c);
  const used = new Set(warm.map((c) => c.id));

  // Learn candidates, up to LEARN_MAX, in the order described above.
  const opens = (c: BiteCard) => Number(c.first === true && !isGraded(deck, c.id));
  const byRungThenNow = (a: BiteCard, b: BiteCard) =>
    opens(b) - opens(a) ||
    Number(b.core === true) - Number(a.core === true) ||
    a.rung - b.rung ||
    Number(isDue(deck, b.id)) - Number(isDue(deck, a.id)) ||
    index.get(a.id)! - index.get(b.id)!;
  const order = conceptsInFocusOrder(deck, usesStudyOrder(deck));
  const learn: BiteCard[] = [];
  const take = (pick: (c: BiteCard, target: number) => boolean) => {
    for (const concept of order) {
      if (learn.length >= LEARN_MAX) return;
      const cards = studyable
        .filter((c) => c.conceptId === concept.id && !used.has(c.id))
        .filter((c) => pick(c, concept.target))
        .sort(byRungThenNow);
      for (const c of cards.slice(0, LEARN_MAX - learn.length)) {
        learn.push(c);
        used.add(c.id);
      }
    }
  };
  take((c, target) => c.rung >= target);
  take(() => true);

  // Boss: overlaps today's concepts most.
  const today = new Set(
    [...warm, ...learn.slice(0, LEARN_MIN)].flatMap((c) => [...conceptsOf(c)]),
  );
  let boss: BiteCard | null = null;
  let bestOverlap = 0;
  for (const c of deck.cards) {
    if (!c.active || !c.boss) continue;
    const overlap = new Set(conceptsOf(c).filter((id) => today.has(id))).size;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      boss = c;
    }
  }

  const learnN = Math.min(
    LEARN_MAX,
    Math.max(LEARN_MIN, BITE_MIN - warm.length - (boss ? 1 : 0)),
  );
  return session([
    ["warm", warm.map((c) => c.id)],
    ["learn", learn.slice(0, learnN).map((c) => c.id)],
    ["boss", boss ? [boss.id] : []],
  ]);
}

/**
 * A tile session: the first 3 active, non-boss cards of one type, in deck
 * order, all in learn. Null when the deck has none ("No … for this one yet.").
 */
export function tileSession(deck: Deck, type: CardType): Bite | null {
  const ids = deck.cards
    .filter((c) => c.active && !c.boss && c.type === type)
    .slice(0, 3)
    .map((c) => c.id);
  return session([["learn", ids]]);
}

/**
 * A concept session: the first 4 active cards touching the concept, in deck
 * order. Boss cards go in boss, the rest in learn (learn shown first).
 */
export function conceptSession(deck: Deck, conceptId: string): Bite | null {
  const cards = deck.cards
    .filter((c) => c.active && conceptsOf(c).includes(conceptId))
    .slice(0, 4);
  return session([
    ["learn", cards.filter((c) => !c.boss).map((c) => c.id)],
    ["boss", cards.filter((c) => c.boss).map((c) => c.id)],
  ]);
}

/**
 * An extra session (after the plan is done, or on request): the first 5
 * active, non-boss cards available now (new or due), in deck order, all in
 * warm. When none is available, the first 4 active non-boss cards instead.
 */
export function extraSession(deck: Deck): Bite | null {
  const pool = deck.cards.filter((c) => c.active && !c.boss);
  let ids = pool
    .filter((c) => isDue(deck, c.id))
    .slice(0, 5)
    .map((c) => c.id);
  if (ids.length === 0) ids = pool.slice(0, 4).map((c) => c.id);
  return session([["warm", ids]]);
}
