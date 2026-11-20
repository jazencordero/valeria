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
 * Core-first pace (`./pace`), only for an exam whose deck has core marks. A
 * bite is then built from what is due or new, nothing else:
 * - warm: up to 4 due reviews, most overdue first.
 * - learn: the next new cards of the plan (`newQueue`: core cards first), up
 *   to 5, and never more than today's budget has left. With no new card to
 *   serve (the budget is used, or it is past the cut-off) learn holds the
 *   next due reviews instead, up to 4.
 * - boss: the boss cards among those new cards (a boss card has its place in
 *   the plan's order like any other card); with none, one boss card that is
 *   due, the most overdue (more of them when the bite is otherwise short of
 *   8 cards).
 * Past the cut-off (reviews only) "due" means due by the end of today, so the
 * day's reviews come as full bites. Such a day serves its due cards by what
 * each review is worth: the forecast points it adds if she recalls the card
 * now (`reviewWorth` in `./forecast`: the rise of its predicted recall on exam
 * day, weighted as the forecast weights its concept), highest first, in bites
 * and one-go sessions alike. The day ASKS only for the important ones: from
 * the top down until the reviews still waiting are together worth less than
 * one forecast point (`enoughPoints`; two days before the exam half a point,
 * so that day carries more and the day before the exam is the lighter one). After that the rest is optional: it
 * is still served, in the same order, to whoever goes on, and `reviewDay`
 * says how many there are and what they are worth, so the screens can say
 * "The important ones are done." and stop asking. Nothing is hidden and no
 * due date is moved. (This replaces the count share of `reviewShare` in
 * `./exam-aim`, which nothing calls any more: a share by count asked for the
 * earliest learned cards whatever they were worth.)
 * The number of bites done today does not end the day: the next bite is there
 * as long as today's budget has new cards left or something is due. Past the
 * cut-off every session kind is reviews only: tiles, concept practice and
 * extra are built from the cards she has graded. Before the cut-off an extra
 * session is the next 5 new cards of the plan, whatever the budget.
 *
 * One go (`buildLong`), only for a paced deck: today's remaining plan as one
 * longer session. It is the bites the plan still asks of today, one after the
 * other, each built by the paced builder above as if the one before it had
 * just been done (its cards recalled, the clock not moved): so the same
 * cards, in the same order, as the separate bites. Whole bites are added
 * while the session stays within 40 cards (`LONG_MAX`); what does not fit is
 * the next session. A card is never in it twice. While new cards are open it
 * ends when today's budget of new cards is used; on a reviews-only day when
 * the important reviews are (the bite that finishes them is taken whole), or,
 * once only optional reviews are left, when those are. Any other deck gets
 * its ordinary bite.
 *
 * `minutes = max(2, round(n * 0.6))`, the app's estimate (`biteMinutes`);
 * `minutesFor` uses her own measured seconds a card instead once there is one
 * (`secondsPerCard` in `./pace`). `gain` is measured, not estimated: the
 * deck's forecast if each card of the session is recalled, minus the forecast
 * now (`gainOf` in `./forecast`), in forecast points, not rounded.
 */

import { startOfDay } from "../dates";
import { dueNow, type Time } from "./exam-aim";
import { gainOf, reviewWorth } from "./forecast";
import { conceptMastery, focusConcept, rungOf } from "./ladder";
import { grade, newCard, type MemoryState } from "./memory";
import { isPaced, newQueue, paceOf, planPlace, reviewsOnly, type Pace } from "./pace";

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
  /** Exam or quiz. Only an exam can be paced (`./pace`); left out, the deck is never paced. */
  kind?: ExamKind;
  /** Ids of the cards she met for the first time today (Helsinki day), for today's budget. */
  newToday?: readonly string[];
  /**
   * Whether the whole deck has core marks, for a caller that hands over only
   * part of it. Left out, the cards given are looked at.
   */
  coreMarked?: boolean;
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
  /** Forecast points this session is worth if every card is recalled (`gainOf`), not rounded. */
  gain: number;
};

export const BITES_PER_DAY: Record<ExamKind, number> = { exam: 2, quiz: 1 };

export const WARM_MIN = 2;
export const WARM_MAX = 4;
export const LEARN_MIN = 3;
export const LEARN_MAX = 5;
export const BITE_MIN = 8;
export const BITE_MAX = 12;

/** A one-go session holds at most this many cards. */
export const LONG_MAX = 40;

export const biteMinutes = (n: number) => Math.max(2, Math.round(n * 0.6));

/**
 * Minutes `n` cards take: at her own measured pace (`secondsPerCard`, seconds
 * a card) when there is one, never under a minute; else the app's estimate
 * (`biteMinutes`). 0 for no cards.
 */
export function minutesFor(n: number, secondsPerCard?: number | null): number {
  if (n <= 0) return 0;
  if (secondsPerCard == null || !(secondsPerCard > 0)) return biteMinutes(n);
  return Math.max(1, Math.round((n * secondsPerCard) / 60));
}

const ms = (t: Time) => (typeof t === "number" ? t : t.getTime());
const conceptsOf = (c: BiteCard) => c.conceptIds ?? [c.conceptId];

// Per deck object, so one build (and each simulated bite) works these out once.
const blanks = new WeakMap<Deck, MemoryState>();
const dues = new WeakMap<Deck, Map<string, number>>();

/** The card's memory; a card never graded is new, due now. */
function stateOf(deck: Deck, id: string): MemoryState {
  const stored = deck.states[id];
  if (stored) return stored;
  let blank = blanks.get(deck);
  if (!blank) blanks.set(deck, (blank = newCard(new Date(ms(deck.now)))));
  return blank;
}

/**
 * When the card is due, if that is now or earlier (exam-aimed, or the stored
 * date once the exam has started); a card that is not due yet gives
 * `Infinity`. `dueNow` is `aimedDue` for exactly those cases, without the
 * search for a date that lies ahead: a bite only asks what is due.
 */
function dueOf(deck: Deck, id: string): number {
  let known = dues.get(deck);
  if (!known) dues.set(deck, (known = new Map()));
  let due = known.get(id);
  if (due === undefined) known.set(id, (due = dueNow(stateOf(deck, id), deck.examAt, deck.now) ?? Infinity));
  return due;
}

/** The deck's cards by `conceptId`, in deck order. */
function byConcept(cards: readonly BiteCard[]): Map<string, BiteCard[]> {
  const out = new Map<string, BiteCard[]>();
  for (const c of cards) {
    const list = out.get(c.conceptId);
    if (list) list.push(c);
    else out.set(c.conceptId, [c]);
  }
  return out;
}

const isDue = (deck: Deck, id: string) => dueOf(deck, id) <= ms(deck.now);

const kept = (sections: Section[]): Section[] | null => {
  const some = sections.filter(([, ids]) => ids.length > 0);
  return some.length > 0 ? some : null;
};

function session(deck: Deck, sections: Section[] | null): Bite | null {
  if (!sections) return null;
  const ids = sections.flatMap(([, list]) => list);
  return { sections, minutes: biteMinutes(ids.length), gain: gainOf(deck, ids) };
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
  const own = byConcept(deck.cards);
  const left = [...deck.concepts]
    .sort((a, b) => a.order - b.order)
    .map((c) => {
      const mine = own.get(c.id) ?? [];
      const cards = mine.map((k) => ({ state: stateOf(deck, k.id), active: k.active }));
      const mastery = conceptMastery(cards, examAt);
      const started = mine.some((k) => k.active && isGraded(deck, k.id));
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

/** The end of the Helsinki day that holds `t` (00:00 of the next day), epoch ms. */
export function endOfDay(t: Time): number {
  // 36 hours on from the day's start is inside the next day whatever the clock change.
  return startOfDay(new Date(startOfDay(new Date(ms(t))).getTime() + 36 * 60 * 60 * 1000)).getTime();
}

/**
 * The graded, active cards of a paced deck that are due: most overdue first.
 * On a reviews-only day everything due by the end of the day is due now, so a
 * bite is a full one instead of the two or three cards that happen to have
 * come due this minute.
 */
function dueCards(deck: Deck, pace: Pace): BiteCard[] {
  const index = new Map(deck.cards.map((c, i) => [c.id, i]));
  const by = pace.open ? ms(deck.now) : Math.min(endOfDay(deck.now), ms(deck.examAt));
  return deck.cards
    .filter((c) => c.active && isGraded(deck, c.id))
    .map((c) => ({ c, due: pace.open ? dueOf(deck, c.id) : (dueNow(stateOf(deck, c.id), deck.examAt, by) ?? Infinity) }))
    .filter((x) => x.due <= by)
    .sort((a, b) => a.due - b.due || index.get(a.c.id)! - index.get(b.c.id)!)
    .map((x) => x.c);
}

/** The reviews still waiting are "optional" once they are together worth less than this many forecast points. */
export const ENOUGH_POINTS = 1;
/**
 * Two or more days before the exam the bar is half of that: the earlier day
 * asks for a little more, so that the day before the exam is the lighter one.
 */
export const ENOUGH_POINTS_EARLY = 0.5;

/** Where "enough" is with `daysToExam` calendar days to the exam. */
export function enoughPoints(daysToExam: number): number {
  return daysToExam >= 2 ? ENOUGH_POINTS_EARLY : ENOUGH_POINTS;
}

export type ReviewDay = {
  /** Reviews today still asks for: the important ones. */
  today: number;
  /** Due cards beyond those: optional today. */
  later: number;
  /** What the optional ones are worth together, in forecast points. */
  laterGain: number;
};

/**
 * A reviews-only day's due cards in the order they are served (see the
 * header): what each review is worth first (`reviewWorth`: the forecast
 * points it adds), highest first; ties in the plan's own order. `important`
 * is how many of them the day asks for: the shortest run from the top after
 * which the cards still waiting are together worth less than one forecast
 * point (`enoughPoints`: half a point two days before the exam). A card she has reviewed today is not served again
 * today (one she missed comes back inside its session).
 *
 * The worth is taken as of the start of the day, not of this minute, so it
 * is the same number all day: the important set only ever loses the cards
 * she reviews, and what the day still asks for never goes up.
 */
function todaysReviews(
  deck: Deck,
  pace: Pace,
  due: readonly BiteCard[],
): { order: BiteCard[]; important: number; restGain: number } {
  const enough = enoughPoints(pace.daysToExam);
  const start = startOfDay(new Date(ms(deck.now))).getTime();
  const reviewedToday = (id: string) => (deck.states[id]?.lastReviewAt ?? -1) >= start;
  const open = due.filter((c) => !reviewedToday(c.id));
  const worth = reviewWorth({ ...deck, now: start }, open.map((c) => c.id));
  const place = planPlace(deck);
  const order = [...open].sort((a, b) => worth.get(b.id)! - worth.get(a.id)! || place.get(a.id)! - place.get(b.id)!);
  let rest = order.reduce((sum, c) => sum + worth.get(c.id)!, 0);
  let important = 0;
  while (important < order.length && rest >= enough) rest -= worth.get(order[important++].id)!;
  return { order, important, restGain: Math.max(0, rest) };
}

/**
 * Past a paced deck's cut-off, before the exam: how many reviews today still
 * asks for (the important ones), and how many due cards are optional and
 * what those are worth together. Null for any other deck or day (there, what
 * is due is what is asked).
 */
export function reviewDay(deck: Deck): ReviewDay | null {
  if (!isPaced(deck)) return null;
  const pace = paceOf(deck)!;
  if (pace.open || ms(deck.now) >= ms(deck.examAt)) return null;
  const { order, important, restGain } = todaysReviews(deck, pace, dueCards(deck, pace));
  return { today: important, later: order.length - important, laterGain: order.length > important ? restGain : 0 };
}

/** A bite for a paced deck: due reviews and the plan's next new cards (see the header). */
function pacedSections(deck: Deck): Section[] | null {
  const pace = paceOf(deck)!;
  const all = dueCards(deck, pace);
  const due = pace.open ? all : todaysReviews(deck, pace, all).order;
  const reviews = due.filter((c) => !c.boss);
  const fresh = pace.open ? newQueue(deck).slice(0, Math.min(pace.left, LEARN_MAX)) : [];
  const warm = reviews.slice(0, WARM_MAX);
  const learn = fresh.length > 0 ? fresh.filter((c) => !c.boss) : reviews.slice(WARM_MAX, BITE_MIN);
  const freshBoss = fresh.filter((c) => c.boss);
  // A due boss card: one in a bite that has other cards, more when the bite would be short
  // (so the last boss reviews of a day are one bite, not one bite each).
  const room = Math.max(1, BITE_MIN - warm.length - learn.length);
  const boss = freshBoss.length > 0 ? freshBoss : due.filter((c) => c.boss).slice(0, room);
  return kept([
    ["warm", warm.map((c) => c.id)],
    ["learn", learn.map((c) => c.id)],
    ["boss", boss.map((c) => c.id)],
  ]);
}

/** Past a paced deck's cut-off, only the cards she has graded. */
const practiceDeck = (deck: Deck): Deck => (isPaced(deck) && !paceOf(deck)!.open ? reviewsOnly(deck) : deck);

export function buildBite(input: BiteInput): Bite | null {
  return session(input, biteSections(input));
}

/**
 * The cards of the bite `buildBite` gives, without its minutes and gain: what
 * the plan simulation (`./plan`) plays, bite after bite.
 */
export function biteSections(input: BiteInput): Section[] | null {
  if (isPaced(input)) return pacedSections(input);
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
  const studyableOf = byConcept(studyable);
  const take = (pick: (c: BiteCard, target: number) => boolean) => {
    for (const concept of order) {
      if (learn.length >= LEARN_MAX) return;
      const cards = (studyableOf.get(concept.id) ?? [])
        .filter((c) => !used.has(c.id))
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
  return kept([
    ["warm", warm.map((c) => c.id)],
    ["learn", learn.slice(0, learnN).map((c) => c.id)],
    ["boss", boss ? [boss.id] : []],
  ]);
}

/**
 * Today's remaining plan of a paced deck as one session (see the header): the
 * bites the plan still asks of today in a row, whole bites while the total
 * stays within `max` cards. The sections repeat (warm, learn, boss, warm, ...)
 * in the order she meets them. Any other deck: its ordinary bite.
 */
export function longSections(input: BiteInput, max = LONG_MAX): Section[] | null {
  if (!isPaced(input)) return biteSections(input);
  const at = new Date(ms(input.now));
  const states: Record<string, MemoryState> = { ...input.states };
  const newToday = [...(input.newToday ?? [])];
  const picked = new Set<string>();
  const out: Section[] = [];
  const first = paceOf(input)!;
  // While new cards are open the plan asks for the bites that use up today's budget, no more.
  let bitesLeft = first.open ? Math.max(1, first.bites) : Infinity;
  // On a reviews-only day it holds the important reviews; once only optional ones are left, those.
  const asksReviews = !first.open && (reviewDay(input)?.today ?? 0) > 0;
  let total = 0;
  while (bitesLeft-- > 0) {
    if (asksReviews && total > 0 && (reviewDay({ ...input, states, newToday })?.today ?? 0) === 0) break;
    const built = pacedSections({ ...input, states, newToday });
    const sections = kept((built ?? []).map(([kind, list]): Section => [kind, list.filter((id) => !picked.has(id))]));
    if (!sections) break;
    const ids = sections.flatMap(([, list]) => list);
    if (total > 0 && total + ids.length > max) break;
    out.push(...sections);
    total += ids.length;
    for (const id of ids) {
      picked.add(id);
      if ((states[id]?.lastReviewAt ?? null) === null) newToday.push(id);
      states[id] = grade(states[id] ?? newCard(at), 3, at);
    }
  }
  return out.length > 0 ? out : null;
}

/** The one-go session (`longSections`) with its minutes and gain. */
export function buildLong(input: BiteInput): Bite | null {
  return session(input, longSections(input));
}

/**
 * A tile session: 3 active, non-boss cards of one type, all in learn. Null
 * when the deck has none ("No … for this one yet.").
 *
 * Which three: cards that are due first (most overdue first), then cards she
 * has never met, then the rest, the one she saw longest ago first. So a tile
 * moves through its cards instead of serving the same three every time. On a
 * fresh deck that is the first three in deck order. Never-met cards come in
 * deck order, or, in a deck with core or first marks, in the plan's order
 * (`newQueue`: core cards first).
 */
export function tileSession(whole: Deck, type: CardType): Bite | null {
  const deck = practiceDeck(whole);
  const now = ms(deck.now);
  const index = new Map(deck.cards.map((c, i) => [c.id, i]));
  const place = usesStudyOrder(deck) ? new Map(newQueue(deck).map((c, i) => [c.id, i])) : index;
  // 0 due, 1 never met, 2 seen and not due.
  const group = (c: BiteCard) => (!isGraded(deck, c.id) ? 1 : dueOf(deck, c.id) <= now ? 0 : 2);
  const key = (c: BiteCard) => {
    const g = group(c);
    return g === 0 ? dueOf(deck, c.id) : g === 1 ? place.get(c.id)! : stateOf(deck, c.id).lastReviewAt!;
  };
  const ids = deck.cards
    .filter((c) => c.active && !c.boss && c.type === type)
    .sort((a, b) => group(a) - group(b) || key(a) - key(b) || index.get(a.id)! - index.get(b.id)!)
    .slice(0, 3)
    .map((c) => c.id);
  return session(whole, kept([["learn", ids]]));
}

/**
 * A concept session: 4 active cards touching the concept. Boss cards go in
 * boss, the rest in learn (learn shown first).
 *
 * Which four, as in a bite: the concept's `first` card while she has never
 * graded it, then core cards, then the others, each in deck order. A deck
 * with no marks gives the first four in deck order.
 */
export function conceptSession(whole: Deck, conceptId: string): Bite | null {
  const deck = practiceDeck(whole);
  const index = new Map(deck.cards.map((c, i) => [c.id, i]));
  const opens = (c: BiteCard) => Number(c.first === true && !isGraded(deck, c.id));
  const cards = deck.cards
    .filter((c) => c.active && conceptsOf(c).includes(conceptId))
    .sort(
      (a, b) =>
        opens(b) - opens(a) || Number(b.core === true) - Number(a.core === true) || index.get(a.id)! - index.get(b.id)!,
    )
    .slice(0, 4);
  return session(
    whole,
    kept([
      ["learn", cards.filter((c) => !c.boss).map((c) => c.id)],
      ["boss", cards.filter((c) => c.boss).map((c) => c.id)],
    ]),
  );
}

/**
 * An extra session (after the plan is done, or on request): the first 5
 * active, non-boss cards available now (new or due), in deck order, all in
 * warm. When none is available, the first 4 active non-boss cards instead.
 *
 * A paced deck (`./pace`) before its cut-off: the next 5 new cards of the plan
 * instead, core first, with no daily cap; the rule above once none is left.
 */
export function extraSession(whole: Deck): Bite | null {
  if (isPaced(whole) && paceOf(whole)!.open) {
    const next = newQueue(whole).slice(0, 5);
    if (next.length > 0) {
      return session(
        whole,
        kept([
          ["warm", next.filter((c) => !c.boss).map((c) => c.id)],
          ["boss", next.filter((c) => c.boss).map((c) => c.id)],
        ]),
      );
    }
  }
  const deck = practiceDeck(whole);
  const pool = deck.cards.filter((c) => c.active && !c.boss);
  let ids = pool
    .filter((c) => isDue(deck, c.id))
    .slice(0, 5)
    .map((c) => c.id);
  if (ids.length === 0) ids = pool.slice(0, 4).map((c) => c.id);
  return session(whole, kept([["warm", ids]]));
}
