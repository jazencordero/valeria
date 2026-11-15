import { describe, expect, it } from "vitest";
import {
  LEARN_MAX,
  buildBite,
  conceptSession,
  extraSession,
  tileSession,
  type Bite,
  type BiteCard,
  type BiteConcept,
  type Deck,
} from "./bite";
import { grade, type MemoryState } from "./memory";
import {
  CUTOFF_DAYS,
  MAX_NEW_PER_DAY,
  MIN_NEW_PER_DAY,
  NEW_PER_BITE,
  daysToCutoff,
  impossibleLine,
  isPaced,
  newBudget,
  newQueue,
  onTrackLine,
  paceOf,
} from "./pace";
import { newCard } from "./memory";

const DAY = 24 * 60 * 60 * 1000;
// The exam: Monday 23 Nov 2026, 09:00 in Helsinki. The cut-off day is Friday the 20th.
const EXAM = new Date("2026-11-23T07:00:00Z");
/** 10:00 in Helsinki on a November day of 2026. */
const at = (day: number) => new Date(Date.UTC(2026, 10, day, 8, 0, 0));

const ids = (b: Bite | null) => (b ? b.sections.flatMap(([, s]) => s) : []);
const section = (b: Bite, kind: string) => b.sections.find(([k]) => k === kind)?.[1] ?? [];

/**
 * An invented deck: `concepts` concepts of `per` cards each, in study order.
 * In every concept the first `core` cards are core. Every 23rd card is a boss card, so
 * some boss cards are core and some are not.
 */
function makeDeck(concepts: number, per: number, core: number, now: Date): Deck {
  const list: BiteConcept[] = Array.from({ length: concepts }, (_, i) => ({ id: `c${i}`, weight: 1, order: i }));
  const cards: BiteCard[] = [];
  for (let c = 0; c < concepts; c++) {
    for (let k = 0; k < per; k++) {
      const n = cards.length;
      const boss = n % 23 === 22;
      cards.push({
        id: `k${n}`,
        conceptId: `c${c}`,
        rung: ((k % 5) + 1) as BiteCard["rung"],
        type: "basic",
        boss,
        active: true,
        core: k < core,
        first: k === 0,
      });
    }
  }
  return { cards, states: {}, concepts: list, examAt: EXAM, now, kind: "exam", newToday: [] };
}

/** She does the session: every card recalled (Good), 20 seconds a card. Returns the deck after it. */
function play(deck: Deck, session: Bite): Deck {
  const states: Record<string, MemoryState> = { ...deck.states };
  const newToday = [...(deck.newToday ?? [])];
  let t = new Date(deck.now).getTime();
  for (const id of ids(session)) {
    t += 20_000;
    if (!states[id]) newToday.push(id);
    states[id] = grade(states[id] ?? newCard(new Date(t)), 3, new Date(t));
  }
  return { ...deck, states, newToday, now: new Date(t) };
}

const seen = (deck: Deck, id: string) => deck.states[id] !== undefined;
const coreOf = (deck: Deck) => deck.cards.filter((c) => c.core);

describe("newBudget", () => {
  it("is the unseen core cards over the days to the cut-off, today included, rounded up", () => {
    // Exam day minus 3 is the cut-off: 7 days out leaves 5 days, 10 days out leaves 8.
    expect(daysToCutoff(7)).toBe(5);
    expect(daysToCutoff(10)).toBe(8);
    expect(newBudget(184, 7)).toEqual({ budget: 37, impossible: false });
    expect(newBudget(184, 8)).toEqual({ budget: 31, impossible: false });
    expect(newBudget(184, 10)).toEqual({ budget: 23, impossible: false });
    expect(newBudget(100, 4)).toEqual({ budget: 50, impossible: false });
  });

  it("is never below 7", () => {
    expect(MIN_NEW_PER_DAY).toBe(7);
    expect(newBudget(184, 60)).toEqual({ budget: 7, impossible: false });
    expect(newBudget(3, 7)).toEqual({ budget: 7, impossible: false });
    expect(newBudget(0, 7)).toEqual({ budget: 7, impossible: false });
  });

  it("on the cut-off day it is everything that is left", () => {
    expect(CUTOFF_DAYS).toBe(3);
    expect(daysToCutoff(3)).toBe(1);
    expect(newBudget(40, 3)).toEqual({ budget: 40, impossible: false });
  });

  it("is closed after the cut-off, the day before the exam and on exam day", () => {
    for (const daysToExam of [2, 1, 0, -1]) {
      expect(daysToCutoff(daysToExam)).toBe(0);
      expect(newBudget(184, daysToExam)).toEqual({ budget: 0, impossible: false });
    }
  });

  it("stops at 60 a day and calls the plan impossible above that", () => {
    expect(MAX_NEW_PER_DAY).toBe(60);
    expect(newBudget(120, 4)).toEqual({ budget: 60, impossible: false });
    expect(newBudget(121, 4)).toEqual({ budget: 60, impossible: true });
    expect(newBudget(184, 3)).toEqual({ budget: 60, impossible: true });
  });
});

describe("paceOf", () => {
  it("counts days as Helsinki calendar days, and a core boss card as a core card", () => {
    const deck = makeDeck(40, 10, 5, at(16));
    const pace = paceOf(deck)!;
    const core = deck.cards.filter((c) => c.core).length;
    expect(core).toBe(200);
    expect(deck.cards.filter((c) => c.core && c.boss).length).toBeGreaterThan(5);
    expect(pace).toMatchObject({ daysToExam: 7, daysToCutoff: 5, open: true, coreTotal: core, coreUnseen: core });
    expect(pace.budget).toBe(Math.ceil(core / 5));
    // 23:30 on the 16th in Helsinki is still the 16th; 00:30 is the 17th.
    expect(paceOf({ ...deck, now: new Date("2026-11-16T21:30:00Z") })!.daysToCutoff).toBe(5);
    expect(paceOf({ ...deck, now: new Date("2026-11-16T22:30:00Z") })!.daysToCutoff).toBe(4);
  });

  it("keeps today's budget the same while she works through it", () => {
    let deck = makeDeck(40, 10, 5, at(16));
    const start = paceOf(deck)!;
    expect(start.left).toBe(start.budget);
    expect(start.bites).toBe(Math.ceil(start.budget / NEW_PER_BITE));
    deck = play(deck, buildBite({ ...deck, kind: "exam", bitesDoneToday: 0 })!);
    const after = paceOf(deck)!;
    expect(after.budget).toBe(start.budget);
    expect(after.newToday).toBe(5);
    expect(after.left).toBe(start.budget - 5);
    expect(after.bites).toBe(Math.ceil((start.budget - 5) / NEW_PER_BITE));
  });

  it("is only for an exam whose deck has core marks", () => {
    const deck = makeDeck(4, 5, 2, at(16));
    expect(isPaced(deck)).toBe(true);
    expect(paceOf({ ...deck, kind: "quiz" })).toBeNull();
    expect(paceOf({ ...deck, kind: undefined })).toBeNull();
    const plain = { ...deck, cards: deck.cards.map((c) => ({ ...c, core: false })) };
    expect(paceOf(plain)).toBeNull();
    // A caller that cut cards out says what the whole deck is.
    expect(isPaced({ ...plain, coreMarked: true })).toBe(true);
  });
});

describe("how many bites today", () => {
  const line = (unseenCore: number, day: number, done = 0) => {
    const deck = makeDeck(40, 10, 5, at(day));
    const core = coreOf(deck);
    // Mark all but `unseenCore` core cards as met on an earlier day.
    const t = new Date(at(day).getTime() - 3 * DAY);
    const states: Record<string, MemoryState> = {};
    for (const c of core.slice(0, core.length - unseenCore)) states[c.id] = grade(newCard(t), 3, t);
    const pace = paceOf({ ...deck, states })!;
    return { pace, text: onTrackLine(pace, "Monday", done > 0) };
  };

  it("is today's new cards over five a bite, rounded up", () => {
    expect(NEW_PER_BITE).toBe(LEARN_MAX);
    // 150 unseen core cards, 5 days: 30 a day, 6 bites.
    expect(line(150, 16)).toMatchObject({ pace: { budget: 30, bites: 6 }, text: "6 bites today keeps you on track for Monday" });
    // 13 unseen on the 18th, 3 days: the floor of 7, 2 bites.
    expect(line(13, 18)).toMatchObject({ pace: { budget: 7, bites: 2 }, text: "2 bites today keeps you on track for Monday" });
    // 5 unseen on the cut-off day: 7 a day (2 are other cards), 2 bites.
    expect(line(5, 20).pace).toMatchObject({ budget: 7, bites: 2 });
    expect(line(3, 16, 1).text).toBe("2 more bites today keeps you on track for Monday");
  });

  it("says one bite in the singular, and nothing once new cards are closed", () => {
    expect(onTrackLine({ open: true, bites: 1, impossible: false }, "Mon 23 Nov")).toBe("1 bite today keeps you on track for Mon 23 Nov");
    expect(onTrackLine({ open: true, bites: 0, impossible: false }, "Monday")).toBeNull();
    expect(line(20, 21)).toMatchObject({ pace: { open: false, budget: 0, bites: 0 }, text: null });
  });
});

describe("an impossible plan", () => {
  it("says so plainly instead of the on-track line", () => {
    // 200 core cards and two days to the cut-off: 100 a day.
    const deck = makeDeck(40, 10, 5, at(19));
    const pace = paceOf(deck)!;
    expect(pace).toMatchObject({ impossible: true, budget: 60, bites: 12 });
    expect(impossibleLine(pace)).toBe("There are more cards than days: core cards first, about 60 a day");
    expect(onTrackLine(pace, "Monday")).toBeNull();
    // A plan that fits has no such sentence.
    expect(impossibleLine(paceOf(makeDeck(40, 10, 5, at(16)))!)).toBeNull();
    // Still core first, five new cards a bite.
    const fresh = ids(buildBite({ ...deck, kind: "exam", bitesDoneToday: 0 }));
    expect(fresh).toHaveLength(5);
    expect(fresh.every((id) => deck.cards.find((c) => c.id === id)!.core)).toBe(true);
  });
});

describe("a week of bites on a paced deck", () => {
  it("shows every core card by the cut-off, no other card before that, and nothing new after", () => {
    // 400 cards, 40 concepts; 180 core cards, some of them boss cards.
    let deck = makeDeck(40, 10, 5, at(16));
    deck = { ...deck, cards: deck.cards.map((c, i) => (i >= 360 ? { ...c, core: false } : c)) };
    const core = new Set(coreOf(deck).map((c) => c.id));
    expect(deck.cards).toHaveLength(400);
    expect(core.size).toBe(180);
    expect([...core].some((id) => deck.cards.find((c) => c.id === id)!.boss)).toBe(true);
    const order: string[] = [];
    const coreSeenBy: Record<number, number> = {};

    for (let day = 16; day <= 23; day++) {
      deck = { ...deck, now: at(day), newToday: [] };
      const open = day <= 20;
      const planned = paceOf(deck)!;
      expect(planned.open).toBe(open);
      let bites = 0;
      // Exam day itself: 10:00 is after the 09:00 exam, so it is checked at 07:00 instead.
      if (day === 23) deck = { ...deck, now: new Date("2026-11-23T05:00:00Z") };
      for (let guard = 0; guard < 80; guard++) {
        // The count of bites done never ends the day for a paced deck.
        const bite = buildBite({ ...deck, kind: "exam", bitesDoneToday: bites });
        if (!bite) break;
        const fresh = ids(bite).filter((id) => !seen(deck, id));
        // A boss card is served in the boss section, a new one included.
        for (const id of section(bite, "boss")) expect(deck.cards.find((c) => c.id === id)!.boss).toBe(true);
        for (const id of [...section(bite, "warm"), ...section(bite, "learn")]) expect(deck.cards.find((c) => c.id === id)!.boss).toBe(false);
        if (!open) expect(ids(bite).filter((id) => !seen(deck, id))).toEqual([]);
        expect(fresh.length).toBeLessThanOrEqual(NEW_PER_BITE);
        expect(ids(bite).length).toBeLessThanOrEqual(10);
        order.push(...fresh);
        deck = play(deck, bite);
        bites++;
      }
      // The plan's new cards for the day were all served, in the bites the line promised (reviews may add more).
      if (open) {
        expect(paceOf(deck)!.left).toBe(0);
        expect(bites).toBeGreaterThanOrEqual(planned.bites);
        expect(deck.newToday).toHaveLength(planned.budget);
      }
      coreSeenBy[day] = [...core].filter((id) => seen(deck, id)).length;
    }

    // Every core card by the end of the cut-off day (Friday the 20th), evenly over the five days.
    expect(coreSeenBy[20]).toBe(core.size);
    expect(coreSeenBy[16]).toBe(Math.ceil(core.size / 5));
    expect(coreSeenBy[19]).toBeLessThan(core.size);
    // No other card was introduced before the last core card.
    const lastCore = Math.max(...[...core].map((id) => order.indexOf(id)));
    expect(order.slice(0, lastCore + 1).every((id) => core.has(id))).toBe(true);
    expect(lastCore + 1).toBe(core.size);
    // Core cards came in study order: concept by concept.
    const conceptOf = new Map(deck.cards.map((c) => [c.id, Number(c.conceptId.slice(1))]));
    // (A bite shows its boss cards last, so they are left out of this check.)
    const bossIds = new Set(deck.cards.filter((c) => c.boss).map((c) => c.id));
    const concepts = order
      .slice(0, core.size)
      .filter((id) => !bossIds.has(id))
      .map((id) => conceptOf.get(id)!);
    expect(concepts).toEqual([...concepts].sort((a, b) => a - b));
  });

  it("after the cut-off every session kind is reviews only", () => {
    let deck = makeDeck(8, 10, 5, at(16));
    deck = play(deck, buildBite({ ...deck, kind: "exam", bitesDoneToday: 0 })!);
    const met = new Set(Object.keys(deck.states));
    for (const day of [21, 22]) {
      const later = { ...deck, now: at(day), newToday: [] };
      for (const s of [
        buildBite({ ...later, kind: "exam", bitesDoneToday: 0 }),
        extraSession(later),
        tileSession(later, "basic"),
        conceptSession(later, "c0"),
      ]) {
        expect(s).not.toBeNull();
        expect(ids(s).every((id) => met.has(id))).toBe(true);
      }
      // A concept she never met has nothing to practise then.
      expect(conceptSession(later, "c7")).toBeNull();
    }
    // On the cut-off day new cards are still served.
    const cutoff = { ...deck, now: at(20), newToday: [] };
    expect(ids(buildBite({ ...cutoff, kind: "exam", bitesDoneToday: 0 })).some((id) => !met.has(id))).toBe(true);
  });

  it("is done for today when the budget is used and nothing is due, and offers reviews when they are", () => {
    let deck = makeDeck(8, 10, 1, at(16));
    // 8 core cards, 5 days: the floor of 7 a day.
    expect(paceOf(deck)!.budget).toBe(7);
    deck = play(deck, buildBite({ ...deck, kind: "exam", bitesDoneToday: 0 })!);
    deck = play(deck, buildBite({ ...deck, kind: "exam", bitesDoneToday: 1 })!);
    expect(paceOf(deck)!.left).toBe(0);
    // Seconds later nothing is due yet: today's bites are done.
    expect(buildBite({ ...deck, kind: "exam", bitesDoneToday: 2 })).toBeNull();
    // Half an hour later the cards she met come back: a bite of reviews, no new card.
    const later = { ...deck, now: new Date(new Date(deck.now).getTime() + 30 * 60 * 1000) };
    const reviews = buildBite({ ...later, kind: "exam", bitesDoneToday: 2 })!;
    expect(ids(reviews).length).toBeGreaterThan(0);
    expect(ids(reviews).every((id) => seen(deck, id))).toBe(true);
  });
});

describe("a reviews-only day", () => {
  /** Every card graded twice on the 16th, each coming due at its own minute of the 21st (after 10:00). */
  function dueThrough21st(deck: Deck, pick: (c: BiteCard) => boolean): Deck {
    const states: Record<string, MemoryState> = {};
    let k = 0;
    for (const c of deck.cards.filter(pick)) {
      const first = grade(newCard(at(16)), 3, at(16));
      const again = grade(first, 3, new Date(at(16).getTime() + 20 * 60 * 1000));
      states[c.id] = { ...again, dueAt: at(21).getTime() + (5 + k++ * 7) * 60 * 1000 };
    }
    return { ...deck, states, now: at(21), newToday: [] };
  }

  it("serves what is due by the end of the day as full bites, not the few cards due this minute", () => {
    const deck = dueThrough21st(makeDeck(4, 10, 5, at(16)), (c) => !c.boss);
    // At 10:00 none of them has come due by the minute; all of them are due today.
    const bite = buildBite({ ...deck, kind: "exam", bitesDoneToday: 0 })!;
    expect(section(bite, "warm")).toHaveLength(4);
    expect(section(bite, "learn")).toHaveLength(4);
    expect(ids(bite).every((id) => seen(deck, id))).toBe(true);
  });

  it("puts the last boss reviews of the day in one bite", () => {
    const deck = dueThrough21st(makeDeck(8, 23, 5, at(16)), (c) => c.boss);
    expect(Object.keys(deck.states)).toHaveLength(8);
    const bite = buildBite({ ...deck, kind: "exam", bitesDoneToday: 0 })!;
    expect(bite.sections.map(([k]) => k)).toEqual(["boss"]);
    expect(section(bite, "boss")).toHaveLength(8);
  });
});

describe("extra on a paced deck", () => {
  it("serves the next unseen core cards in order, with no daily cap", () => {
    let deck = makeDeck(8, 10, 5, at(16));
    const queue = newQueue(deck).map((c) => c.id);
    const coreCount = coreOf(deck).length;
    expect(queue.slice(0, coreCount).every((id) => deck.cards.find((c) => c.id === id)!.core)).toBe(true);
    // A concept's first card leads it.
    expect(queue[0]).toBe("k0");

    const served: string[] = [];
    // Far more than today's budget (8 a day here): extra keeps going.
    expect(paceOf(deck)!.budget).toBeLessThan(15);
    for (let i = 0; i < 6; i++) {
      const extra = extraSession(deck)!;
      expect(ids(extra)).toHaveLength(5);
      served.push(...ids(extra));
      deck = play(deck, extra);
    }
    expect(served).toEqual(queue.slice(0, 30));
    // What extra served counts as met today: the plan has nothing new left for today.
    expect(paceOf(deck)!.left).toBe(0);
  });

  it("goes on to the other cards once every core card has been seen", () => {
    let deck = makeDeck(2, 6, 2, at(16));
    deck = play(deck, extraSession(deck)!);
    expect(coreOf(deck).every((c) => seen(deck, c.id))).toBe(true);
    const next = ids(extraSession(deck));
    expect(next.length).toBeGreaterThan(0);
    expect(next.every((id) => !seen(deck, id) && !deck.cards.find((c) => c.id === id)!.core)).toBe(true);
  });
});

describe("a deck without core marks", () => {
  it("is built exactly as before, whatever the kind and today's new cards say", () => {
    const paced = makeDeck(8, 10, 5, at(16));
    const plain: Deck = { ...paced, cards: paced.cards.map((c) => ({ ...c, core: false })) };
    const bare: Deck = { cards: plain.cards, states: plain.states, concepts: plain.concepts, examAt: EXAM, now: at(16) };
    for (const deck of [plain, { ...plain, newToday: ["k0", "k1"] }]) {
      expect(buildBite({ ...deck, kind: "exam", bitesDoneToday: 0 })).toEqual(buildBite({ ...bare, kind: "exam", bitesDoneToday: 0 }));
      expect(buildBite({ ...deck, kind: "exam", bitesDoneToday: 2 })).toBeNull();
      expect(extraSession(deck)).toEqual(extraSession(bare));
      expect(tileSession(deck, "basic")).toEqual(tileSession(bare, "basic"));
      expect(conceptSession(deck, "c1")).toEqual(conceptSession(bare, "c1"));
    }
    // New cards on exam day and two bites a day: today's behaviour.
    const examDay = { ...bare, now: new Date("2026-11-23T05:00:00Z") };
    expect(ids(buildBite({ ...examDay, kind: "exam", bitesDoneToday: 0 })).length).toBeGreaterThan(0);
  });

  it("a quiz with core marks keeps one bite a day", () => {
    const deck = { ...makeDeck(8, 10, 5, at(16)), kind: "quiz" as const };
    expect(buildBite({ ...deck, bitesDoneToday: 0 })).not.toBeNull();
    expect(buildBite({ ...deck, bitesDoneToday: 1 })).toBeNull();
  });
});
