/**
 * Core-first pace: how many new cards an exam's plan serves each day.
 *
 * For an exam (not a quiz) whose deck has core marks. Pure: no clock, no
 * storage; days are Helsinki calendar days (`daysBetween`).
 *
 * Rules:
 * - Cut-off: three days before the exam day (`CUTOFF_DAYS`). New cards are
 *   served up to and including the cut-off day. After it, on the day before
 *   the exam and on exam day there are no new cards at all: reviews only.
 * - Today's budget of new cards: the core cards she had not seen at the start
 *   of today, divided by the days left to the cut-off (today included),
 *   rounded up, never fewer than 7 (`MIN_NEW_PER_DAY`). Counting from the
 *   start of today keeps the budget the same all day.
 * - More than 60 new cards a day (`MAX_NEW_PER_DAY`) is not a plan anyone
 *   keeps: the budget stops at 60 and the plan is called impossible, so the
 *   screen says so instead of promising.
 * - Order of new cards (`newQueue`): every core card before any other card.
 *   Inside each group: concepts in study order, a concept's `first` card
 *   first, its boss cards last, then lower rung, then deck order.
 * - A bite brings up to 5 new cards (`NEW_PER_BITE`), so the bites that keep
 *   her on plan today are the new cards left today divided by 5, rounded up.
 * - Boss cards count like any other card: a core boss card is a core card,
 *   it has its place in the queue and it spends the budget.
 * - Her own pace (`secondsPerCard`): the median time she takes for a card,
 *   from the newest 200 grades in her review log for this exam (`PACE_LOG`),
 *   each timed from the card appearing to its grade. The median, not the
 *   mean: one card left open while she fetched a coffee does not move it. It
 *   is used once she has graded 20 different cards (`PACE_MIN_CARDS`); until
 *   then the app's estimate stands (`biteMinutes`, 36 seconds a card).
 */
import { daysBetween } from "../dates";
import type { BiteCard, Deck } from "./bite";

/** New cards stop this many days before the exam day; that day is the last with new cards. */
export const CUTOFF_DAYS = 3;
/** Today's budget is never below this. */
export const MIN_NEW_PER_DAY = 7;
/** A budget above this is not plausible: the plan is called impossible and held here. */
export const MAX_NEW_PER_DAY = 60;
/** New cards one bite brings. */
export const NEW_PER_BITE = 5;

/** Her own pace is used once she has graded this many different cards. */
export const PACE_MIN_CARDS = 20;
/** Her own pace is read from this many of her newest grades. */
export const PACE_LOG = 200;

const ms = (t: number | Date) => (typeof t === "number" ? t : t.getTime());

/**
 * Seconds she takes for a card: the median over the grades given (see the
 * header), or null while fewer than 20 different cards have a timed grade.
 */
export function secondsPerCard(log: readonly { cardId: string; ms: number | null }[]): number | null {
  const timed = log.filter((r) => typeof r.ms === "number" && r.ms > 0);
  if (new Set(timed.map((r) => r.cardId)).size < PACE_MIN_CARDS) return null;
  const sorted = timed.map((r) => r.ms as number).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return median / 1000;
}

export type Pace = {
  /** Helsinki calendar days to the exam; 0 is exam day. */
  daysToExam: number;
  /** Days left to the cut-off, today included; 0 once it has passed. */
  daysToCutoff: number;
  /** New cards may be served today. */
  open: boolean;
  /** Active core cards (boss cards included). */
  coreTotal: number;
  /** Of those, never graded. */
  coreUnseen: number;
  /** New cards today's plan serves; 0 when closed. */
  budget: number;
  /** New cards she has met today. */
  newToday: number;
  /** New cards the plan still serves today. */
  left: number;
  /** Bites that use up `left`. */
  bites: number;
  /** The days left cannot hold the core cards at a plausible pace. */
  impossible: boolean;
};

/** Days left to the cut-off, today included; 0 after it. */
export function daysToCutoff(daysToExam: number): number {
  return Math.max(0, daysToExam - CUTOFF_DAYS + 1);
}

/**
 * Today's budget of new cards for `unseenCore` core cards unseen at the start
 * of today. Closed (budget 0) after the cut-off.
 */
export function newBudget(unseenCore: number, daysToExam: number): { budget: number; impossible: boolean } {
  const days = daysToCutoff(daysToExam);
  if (days === 0) return { budget: 0, impossible: false };
  const raw = Math.ceil(Math.max(0, unseenCore) / days);
  return { budget: Math.min(MAX_NEW_PER_DAY, Math.max(MIN_NEW_PER_DAY, raw)), impossible: raw > MAX_NEW_PER_DAY };
}

/** An exam whose deck has core marks is paced; a quiz or an unmarked deck is not. */
export function isPaced(deck: Deck): boolean {
  return deck.kind === "exam" && (deck.coreMarked ?? deck.cards.some((c) => c.core === true));
}

const isGraded = (deck: Deck, id: string) => (deck.states[id]?.lastReviewAt ?? null) !== null;

/** Today's pace, or null for a deck that is not paced. */
export function paceOf(deck: Deck): Pace | null {
  if (!isPaced(deck)) return null;
  const pool = deck.cards.filter((c) => c.active);
  const core = pool.filter((c) => c.core === true);
  const metToday = new Set(deck.newToday ?? []);
  const unseen = pool.filter((c) => !isGraded(deck, c.id)).length;
  const coreUnseen = core.filter((c) => !isGraded(deck, c.id)).length;
  const coreToday = core.filter((c) => metToday.has(c.id)).length;
  const newToday = pool.filter((c) => metToday.has(c.id)).length;

  const daysToExam = daysBetween(new Date(ms(deck.now)), new Date(ms(deck.examAt)));
  const open = daysToCutoff(daysToExam) > 0 && ms(deck.now) < ms(deck.examAt);
  const { budget, impossible } = open ? newBudget(coreUnseen + coreToday, daysToExam) : { budget: 0, impossible: false };
  const left = Math.min(unseen, Math.max(0, budget - newToday));
  return {
    daysToExam,
    daysToCutoff: daysToCutoff(daysToExam),
    open,
    coreTotal: core.length,
    coreUnseen,
    budget,
    newToday,
    left,
    bites: Math.ceil(left / NEW_PER_BITE),
    impossible,
  };
}

// The plan's order of a deck's cards depends only on the cards and the concepts, so it is
// worked out once per card list (a simulation asks for the queue bite after bite).
const planOrders = new WeakMap<readonly BiteCard[], { concepts: Deck["concepts"]; cards: BiteCard[] }>();

function planOrder(deck: Deck): BiteCard[] {
  const known = planOrders.get(deck.cards);
  if (known && known.concepts === deck.concepts) return known.cards;
  const index = new Map(deck.cards.map((c, i) => [c.id, i]));
  const order = new Map(deck.concepts.map((c) => [c.id, c.order]));
  const place = (c: BiteCard) => order.get(c.conceptId) ?? Number.MAX_SAFE_INTEGER;
  const cards = [...deck.cards].sort(
    (a, b) =>
      Number(b.core === true) - Number(a.core === true) ||
      place(a) - place(b) ||
      Number(b.first === true) - Number(a.first === true) ||
      Number(a.boss) - Number(b.boss) ||
      a.rung - b.rung ||
      index.get(a.id)! - index.get(b.id)!,
  );
  planOrders.set(deck.cards, { concepts: deck.concepts, cards });
  return cards;
}

const planPlaces = new WeakMap<readonly BiteCard[], Map<string, number>>();

/**
 * Each card's place in the order the plan introduces the cards. For graded
 * cards that is "earliest learned first": the plan served them in this order.
 */
export function planPlace(deck: Deck): Map<string, number> {
  const order = planOrder(deck);
  let places = planPlaces.get(order);
  if (!places) planPlaces.set(order, (places = new Map(order.map((c, i) => [c.id, i]))));
  return places;
}

/** The never-graded, active cards in the order the plan introduces them. */
export function newQueue(deck: Deck): BiteCard[] {
  return planOrder(deck).filter((c) => c.active && !isGraded(deck, c.id));
}

/** The deck without its never-graded cards: what a reviews-only day draws from. */
export function reviewsOnly<D extends Deck>(deck: D): D {
  return { ...deck, cards: deck.cards.filter((c) => isGraded(deck, c.id)) };
}

/**
 * "3 bites today keeps you on track for Monday": how many bites today's plan
 * still needs. `day` is the exam's day as a sentence names it (`byDay`);
 * `more` once a bite is done today. Null when no new cards are left today, or
 * when the plan is impossible (that has its own sentence).
 */
export function onTrackLine(pace: Pick<Pace, "open" | "bites" | "impossible">, day: string, more = false): string | null {
  if (!pace.open || pace.bites === 0 || pace.impossible) return null;
  return `${pace.bites} ${more ? "more " : ""}bite${pace.bites === 1 ? "" : "s"} today keeps you on track for ${day}`;
}

/** Said once, on the exam page, when the days left cannot hold the core cards. */
export function impossibleLine(pace: Pick<Pace, "open" | "budget" | "impossible">): string | null {
  if (!pace.open || !pace.impossible) return null;
  return `There are more cards than days: core cards first, about ${pace.budget} a day`;
}
