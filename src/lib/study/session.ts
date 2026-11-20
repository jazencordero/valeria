/**
 * Study session rules as one pure reducer (prototype main-flow.html:
 * startSession L3104-3106, showGrades/showFeedback/gradeCard L3345-3408,
 * renderFrontActions hint L3240, sessionDone L3441).
 *
 * The UI dispatches events; `step(state, event)` returns the next state and
 * never mutates its input. Time comes in on the events (`at`, epoch ms) and
 * the requeue coin is a seeded mulberry32 kept in the state, so the same
 * events always give the same session.
 *
 * The mastery numbers here only feed the "what moved" display on the done
 * screen. The stored truth is the review log (`reviews`) plus FSRS state.
 */
import type { Bite, BiteCard, CardType, SectionKind } from "./bite";
import { rungOf } from "./ladder";
import type { Grade } from "./memory";

export type SessionMode = "bite" | "tile" | "concept" | "extra";
/**
 * What a screen can ask to start: a session mode, or `long`, today's remaining
 * plan in one go (it runs and is stored as a `bite`).
 */
export type SessionKind = SessionMode | "long";
/** Four grade buttons (Again/Hard/Good/Easy) or two (Missed/Got it). */
export type GradeMode = "four" | "two";

/** One card as the session needs it. */
export type SessionCard = {
  id: string;
  type: CardType;
  boss: boolean;
  /** Which bite section it came from; the requeue rule looks for "boss". */
  section: SectionKind;
  /** Concepts whose mastery the card moves. */
  conceptIds: readonly string[];
  /** Match cards: number of pairs to match. Default 1. */
  pairs?: number;
  /** Fill-the-gap cards: number of blanks to open. Default 1. */
  blanks?: number;
};

/** Content the session needs that a BiteCard does not carry. */
export type CardDetail = { pairs?: number; blanks?: number };

/**
 * Flattens a bite's sections into the ordered session cards. Ids missing from
 * `cards` are skipped.
 */
export function biteCards(
  bite: Bite,
  cards: readonly BiteCard[],
  detail: Readonly<Record<string, CardDetail>> = {},
): SessionCard[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const out: SessionCard[] = [];
  for (const [section, ids] of bite.sections) {
    for (const id of ids) {
      const c = byId.get(id);
      if (!c) continue;
      out.push({
        id,
        type: c.type,
        boss: c.boss,
        section,
        conceptIds: c.conceptIds?.length ? [...c.conceptIds] : [c.conceptId],
        ...detail[id],
      });
    }
  }
  return out;
}

export type SessionPhase = "front" | "graded" | "fb" | "done";

export type Review = {
  cardId: string;
  grade: Grade;
  /** Not seen before in this session (no earlier pass, no requeue). */
  firstTry: boolean;
  /** Time from the card appearing to its grade. */
  ms: number;
};

export type Climb = { concept: string; from: number; to: number };

export type SessionResult = {
  /** Unique cards reviewed. */
  cards: number;
  seconds: number;
  best: number;
  perfect: boolean;
  climbs: Climb[];
  reviews: Review[];
};

export type SessionState = {
  mode: SessionMode;
  cards: Readonly<Record<string, SessionCard>>;
  /** Cards still to do; `queue[0]` is on screen. */
  queue: readonly string[];
  /** Card ids in the order they were graded (one entry per grade). */
  order: readonly string[];
  /** Grades given so far (the prototype's `passed`). */
  passed: number;
  /** First-try passes. */
  firstOk: number;
  /** Cards graded 1 at least once. */
  again: Readonly<Record<string, true>>;
  /** Cards graded at least once. */
  seen: Readonly<Record<string, true>>;
  phase: SessionPhase;
  /** The verdict an auto-graded card carries into `continue`. */
  fbGrade: Grade | null;
  /** Match slips on a finished match card, for the feedback line. */
  fbSlips: number;
  /** The "Stop this session?" confirm is open. */
  confirm: boolean;
  /** No more cards: finished or stopped. */
  over: boolean;
  stopped: boolean;
  /** askStop on a finished session: the UI should close it. */
  closed: boolean;
  combo: number;
  best: number;
  masteryBefore: Readonly<Record<string, number>>;
  mastery: Readonly<Record<string, number>>;
  /** Concepts whose rung went up on the last grade (for the toast). */
  lastClimbs: readonly string[];
  /** Where the last grade-1 card went back in the queue, or null. */
  lastRequeue: number | null;
  /** mulberry32 state. */
  rng: number;
  start: number;
  /** When the current card appeared. */
  shownAt: number;
  /** Time of the last timed event. */
  lastAt: number;
  reviews: readonly Review[];
  /** Per-card front state. */
  revealed: number;
  matched: readonly string[];
  slips: number;
  picked: number | null;
  text: string | null;
  rubric: readonly boolean[] | null;
};

export type SessionInit = {
  /** The bite's cards in order (see `biteCards`). */
  cards: readonly SessionCard[];
  mode: SessionMode;
  seed: number;
  /** Start time, epoch ms. */
  at: number;
  /** Concept mastery before the session, 0..1. */
  masteries: Readonly<Record<string, number>>;
};

export type SessionEvent =
  | { type: "reveal"; at?: number }
  | { type: "grade"; g: Grade; at: number }
  | { type: "pick"; option: number; correct: boolean; at?: number }
  | { type: "match"; a: string; b: string; at?: number }
  | { type: "check"; text: string; rubricResult: readonly boolean[]; at?: number }
  | { type: "continue"; at: number }
  | { type: "askStop"; at?: number }
  | { type: "keepGoing"; at?: number }
  | { type: "stop"; at: number };

export const MASTERY_CAP = 0.97;
export const GAIN = { first: 0.055, boss: 0.06, hard: 0.015, later: 0.025 } as const;
/** Tile and extra practice count for less. */
export const PRACTICE_FACTOR = 0.6;

/** One mulberry32 draw: a float in [0, 1) and the next state. */
export function mulberry32(a: number): [number, number] {
  const next = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(next ^ (next >>> 15), 1 | next);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

const FRONT_RESET = {
  revealed: 0,
  matched: [] as readonly string[],
  slips: 0,
  picked: null,
  text: null,
  rubric: null,
  fbGrade: null,
  fbSlips: 0,
} as const;

export function initSession(init: SessionInit): SessionState {
  const cards: Record<string, SessionCard> = {};
  for (const c of init.cards) cards[c.id] = c;
  const before: Record<string, number> = { ...init.masteries };
  for (const c of init.cards) for (const k of c.conceptIds) if (before[k] === undefined) before[k] = 0;
  const empty = init.cards.length === 0;
  return {
    mode: init.mode,
    cards,
    queue: init.cards.map((c) => c.id),
    order: [],
    passed: 0,
    firstOk: 0,
    again: {},
    seen: {},
    phase: empty ? "done" : "front",
    confirm: false,
    over: empty,
    stopped: false,
    closed: false,
    combo: 0,
    best: 0,
    masteryBefore: before,
    mastery: { ...before },
    lastClimbs: [],
    lastRequeue: null,
    rng: init.seed | 0,
    start: init.at,
    shownAt: init.at,
    lastAt: init.at,
    reviews: [],
    ...FRONT_RESET,
  };
}

/** The card on screen, or null when the session is over. */
export function currentCard(s: SessionState): SessionCard | null {
  return s.over || !s.queue.length ? null : (s.cards[s.queue[0]] ?? null);
}

/** Cards done so far and the total (which grows by one per requeue). */
export function progress(s: SessionState): { done: number; total: number } {
  return { done: s.passed, total: s.passed + s.queue.length };
}

/** Mastery gain for one concept from one grade (prototype gradeCard). */
export function gainFor(g: Grade, firstTime: boolean, boss: boolean, mode: SessionMode): number {
  let gain = g === 1 ? 0 : firstTime ? (boss ? GAIN.boss : GAIN.first) : g === 2 ? GAIN.hard : GAIN.later;
  if (mode === "tile" || mode === "extra") gain *= PRACTICE_FACTOR;
  return gain;
}

export function step(s: SessionState, e: SessionEvent): SessionState {
  const at = e.at ?? s.lastAt;
  const t = { ...s, lastAt: Math.max(s.lastAt, at) };

  if (e.type === "askStop") return s.over ? { ...t, closed: true } : { ...t, confirm: true };
  if (e.type === "keepGoing") return { ...t, confirm: false };
  if (e.type === "stop") {
    return s.over ? t : { ...t, confirm: false, over: true, stopped: true, phase: "done" };
  }
  // While the confirm is open or the session is over, card events do nothing.
  if (s.over || s.confirm) return s;
  const card = currentCard(s);
  if (!card) return s;

  switch (e.type) {
    case "reveal": {
      if (s.phase !== "front") return s;
      if (card.type === "basic") return { ...t, phase: "graded" };
      if (card.type === "cloze") {
        const revealed = s.revealed + 1;
        return { ...t, revealed, phase: revealed >= (card.blanks ?? 1) ? "graded" : "front" };
      }
      return s;
    }
    case "check": {
      if (s.phase !== "front" || card.type !== "explain") return s;
      return { ...t, phase: "graded", text: e.text, rubric: [...e.rubricResult] };
    }
    case "pick": {
      if (s.phase !== "front" || card.type !== "mcq") return s;
      return { ...t, phase: "fb", picked: e.option, fbGrade: e.correct ? 3 : 1 };
    }
    case "match": {
      if (s.phase !== "front" || card.type !== "match") return s;
      if (e.a !== e.b) return { ...t, slips: s.slips + 1 };
      if (s.matched.includes(e.a)) return s;
      const matched = [...s.matched, e.a];
      if (matched.length < (card.pairs ?? 1)) return { ...t, matched };
      return { ...t, matched, phase: "fb", fbGrade: s.slips ? 2 : 3, fbSlips: s.slips };
    }
    case "grade":
      return s.phase === "graded" ? applyGrade(t, card, e.g, at) : s;
    case "continue":
      return s.phase === "fb" && s.fbGrade ? applyGrade(t, card, s.fbGrade, at) : s;
  }
}

function applyGrade(s: SessionState, card: SessionCard, g: Grade, at: number): SessionState {
  const cid = card.id;
  const firstTry = !s.again[cid] && !s.seen[cid];
  const firstTime = g >= 3 && firstTry;

  const mastery = { ...s.mastery };
  const climbs: string[] = [];
  const gain = gainFor(g, firstTime, card.boss, s.mode);
  for (const k of card.conceptIds) {
    const m0 = mastery[k] ?? 0;
    // Never lower a value that already sits above the cap.
    const m1 = gain > 0 ? Math.max(m0, Math.min(MASTERY_CAP, m0 + gain)) : m0;
    mastery[k] = m1;
    if (rungOf(m1) > rungOf(m0)) climbs.push(k);
  }

  let { combo, best, firstOk } = s;
  if (firstTime) {
    firstOk++;
    combo++;
    best = Math.max(best, combo);
  } else if (g <= 2) combo = 0;

  const queue = s.queue.slice(1);
  let rng = s.rng;
  let lastRequeue: number | null = null;
  const again = g === 1 ? { ...s.again, [cid]: true as const } : s.again;
  if (g === 1) {
    const [r, next] = mulberry32(rng);
    rng = next;
    let pos = Math.min(queue.length, 2 + (r < 0.5 ? 0 : 1));
    if (queue.length && s.cards[queue[queue.length - 1]]?.section === "boss") {
      pos = Math.min(pos, queue.length - 1);
    }
    pos = Math.max(0, pos);
    queue.splice(pos, 0, cid);
    lastRequeue = pos;
  }

  const done = queue.length === 0;
  return {
    ...s,
    ...FRONT_RESET,
    queue,
    order: [...s.order, cid],
    passed: s.passed + 1,
    firstOk,
    again,
    seen: { ...s.seen, [cid]: true },
    combo,
    best,
    mastery,
    lastClimbs: climbs,
    lastRequeue,
    rng,
    reviews: [...s.reviews, { cardId: cid, grade: g, firstTry, ms: Math.max(0, at - s.shownAt) }],
    shownAt: at,
    phase: done ? "done" : "front",
    over: done,
  };
}

/** No misses and first-try passes on all but at most one unique card. */
export function isPerfect(s: SessionState): boolean {
  const unique = Object.keys(s.seen).length;
  return Object.keys(s.again).length === 0 && s.firstOk >= unique - 1;
}

/** Concepts that moved more than 0.004, biggest rung jump first, then biggest gain. */
export function climbsOf(s: SessionState): Climb[] {
  return Object.keys(s.mastery)
    .map((concept) => ({ concept, from: s.masteryBefore[concept] ?? 0, to: s.mastery[concept] }))
    .filter((c) => c.to - c.from > 0.004)
    .sort(
      (a, b) =>
        rungOf(b.to) - rungOf(b.from) - (rungOf(a.to) - rungOf(a.from)) ||
        b.to - b.from - (a.to - a.from),
    );
}

/** What the done screen shows. */
export function result(s: SessionState): SessionResult {
  return {
    cards: Object.keys(s.seen).length,
    seconds: Math.max(0, Math.floor((s.lastAt - s.start) / 1000)),
    best: s.best,
    perfect: isPerfect(s),
    climbs: climbsOf(s),
    reviews: [...s.reviews],
  };
}

/** The keyboard hint line under the card (empty once the session is over). */
export function hint(s: SessionState, mode: GradeMode): string {
  const card = currentCard(s);
  if (!card) return "";
  const two = mode === "two";
  if (s.phase === "fb") return "Enter to continue";
  if (s.phase === "graded") return two ? "1 missed · 2 got it" : "1–4 to grade";
  const keys = two ? "1 or 2" : "1–4";
  if (card.type === "mcq") return "1–4 to choose · Enter to continue";
  if (card.type === "match") return "Tap to match · Enter to continue";
  if (card.type === "explain") return "Write, then check it · " + keys + " to grade";
  return "Space to reveal · " + keys + " to grade";
}
