import { describe, expect, it } from "vitest";
import { startOfDay } from "../dates";
import {
  ENOUGH_POINTS,
  ENOUGH_POINTS_EARLY,
  LEARN_MAX,
  LONG_MAX,
  biteMinutes,
  buildBite,
  buildLong,
  minutesFor,
  planMinutes,
  conceptSession,
  enoughPoints,
  extraSession,
  reviewDay,
  tileSession,
  type Bite,
  type BiteCard,
  type BiteConcept,
  type Deck,
} from "./bite";
import { aimedDue, dueNow } from "./exam-aim";
import { deckForecast, gainOf, reviewWorth } from "./forecast";
import { grade, type MemoryState } from "./memory";
import {
  CUTOFF_DAYS,
  MAX_NEW_PER_DAY,
  MIN_NEW_PER_DAY,
  PACE_MIN_SECONDS,
  NEW_PER_BITE,
  daysToCutoff,
  impossibleLine,
  isPaced,
  newBudget,
  newQueue,
  onTrackLine,
  paceOf,
  secondsPerCard,
} from "./pace";
import { newCard } from "./memory";
import { askedToday, cardsLeftToday, simulate, todayPlan } from "./plan";

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
/** The deck as of 00:00 that day in Helsinki: a reviews-only day values its reviews as of then, so the order holds all day. */
const morningOf = (deck: Deck): Deck => ({ ...deck, now: startOfDay(new Date(deck.now)) });
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
    // All eight due boss cards come in one bite (served by worth; nothing is held back).
    const bite = buildBite({ ...deck, kind: "exam", bitesDoneToday: 0 })!;
    expect(bite.sections.map(([k]) => k)).toEqual(["boss"]);
    expect(section(bite, "boss")).toHaveLength(8);
  });
});

describe("the reviews after the cut-off", () => {
  const dueBy = (deck: Deck, by: number) =>
    deck.cards.filter((c) => deck.states[c.id] && dueNow(deck.states[c.id], EXAM, by) !== null);
  /** 23:59:59 in Helsinki on a November day of 2026, or the exam when that is sooner. */
  const endOf = (day: number) => Math.min(Date.UTC(2026, 10, day, 21, 59, 59), EXAM.getTime());

  /** 360 cards, 180 of them core; she keeps the plan from Monday the 16th to the cut-off on Friday the 20th. */
  function atTheCutoff(daysDone: number[] = [16, 17, 18, 19, 20]): { deck: Deck; learned: string[] } {
    let deck = makeDeck(36, 10, 5, at(16));
    const learned: string[] = [];
    for (const day of daysDone) {
      deck = { ...deck, now: at(day), newToday: [] };
      const bites = paceOf(deck)!.bites;
      for (let b = 0; b < bites; b++) {
        const bite = buildBite({ ...deck, kind: "exam", bitesDoneToday: b })!;
        learned.push(...ids(bite).filter((id) => !seen(deck, id)));
        deck = play(deck, bite);
      }
    }
    return { deck, learned };
  }

  /** The due cards in the order the day serves them, with what each is worth. */
  function servedOrder(deck: Deck): { id: string; worth: number }[] {
    const out: { id: string; worth: number }[] = [];
    let d = deck;
    for (let guard = 0; guard < 80; guard++) {
      const bite = buildBite({ ...d, kind: "exam", bitesDoneToday: guard });
      if (!bite) break;
      // Measured before the bite is played, on the deck as it stands.
      for (const id of ids(bite)) out.push({ id, worth: gainOf(morningOf(deck), [id]) });
      d = play(d, bite);
    }
    return out;
  }

  it("what a review is worth is the model's own marginal gain, and the worths add up", () => {
    const { deck: cut } = atTheCutoff();
    const deck: Deck = { ...cut, now: at(21), newToday: [] };
    const due = dueBy(deck, endOf(21)).map((c) => c.id);
    const worth = reviewWorth(deck, due);
    for (const id of due.slice(0, 40)) expect(worth.get(id)!).toBeCloseTo(gainOf(deck, [id]), 9);
    expect(due.reduce((sum, id) => sum + worth.get(id)!, 0)).toBeCloseTo(gainOf(deck, due), 8);
    // A card the forecast does not count is worth nothing: an extra card of a concept whose core is not all seen.
    const partly = atTheCutoff([16]).deck;
    const extra = partly.cards.find((c) => !c.core && !c.boss && partly.cards.some((k) => k.conceptId === c.conceptId && k.core && !seen(partly, k.id)))!;
    expect(reviewWorth(partly, [extra.id]).get(extra.id)).toBe(0);
    expect(gainOf(partly, [extra.id])).toBe(0);
    // A heavier concept makes the same review worth more.
    const heavy: Deck = { ...deck, concepts: deck.concepts.map((c) => (c.id === "c0" ? { ...c, weight: 5 } : c)) };
    const c0 = due.find((id) => deck.cards.find((c) => c.id === id)!.conceptId === "c0")!;
    expect(reviewWorth(heavy, [c0]).get(c0)!).toBeGreaterThan(4 * worth.get(c0)!);
  });

  it("serves the due cards by what they are worth and asks only until the rest is worth under a point", () => {
    const start = atTheCutoff();
    expect(start.learned).toHaveLength(180);
    // Two days before the exam the bar is half a point; from the day before it is one point.
    const BAR = enoughPoints(2);
    expect([enoughPoints(3), BAR, enoughPoints(1), enoughPoints(0)]).toEqual([0.5, 0.5, 1, 1]);
    expect([ENOUGH_POINTS_EARLY, ENOUGH_POINTS]).toEqual([0.5, 1]);
    // Saturday the 21st, two days before the exam.
    const deck: Deck = { ...start.deck, now: at(21), newToday: [] };
    const due = dueBy(deck, endOf(21)).map((c) => c.id);
    const worth = reviewWorth(morningOf(deck), due);
    const total = due.reduce((sum, id) => sum + worth.get(id)!, 0);
    expect(total).toBeGreaterThan(BAR);

    // Highest worth first: warm and learn cards across the bites, and the boss cards among themselves.
    const served = servedOrder(deck);
    expect(served.map((x) => x.id).sort()).toEqual([...due].sort());
    const boss = new Set(deck.cards.filter((c) => c.boss).map((c) => c.id));
    for (const pick of [(id: string) => !boss.has(id), (id: string) => boss.has(id)]) {
      const worths = served.filter((x) => pick(x.id)).map((x) => x.worth);
      for (let i = 1; i < worths.length; i++) expect(worths[i]).toBeLessThanOrEqual(worths[i - 1] + 1e-9);
    }

    // "Enough": the shortest run from the top after which what still waits is worth less than one point.
    const sorted = [...due].sort((a, b) => worth.get(b)! - worth.get(a)!);
    let rest = total;
    let important = 0;
    while (rest >= BAR) rest -= worth.get(sorted[important++])!;
    const asked = reviewDay(deck)!;
    expect(asked.today).toBe(important);
    expect(asked.later).toBe(due.length - important);
    expect(asked.laterGain).toBeCloseTo(rest, 8);
    expect(asked.laterGain).toBeLessThan(BAR);
    expect(asked.laterGain + worth.get(sorted[important - 1])!).toBeGreaterThanOrEqual(BAR);
    expect(important).toBeGreaterThan(0);
    expect(important).toBeLessThan(due.length);

    // The plan asks for the bites that finish the important ones; after them the rest is optional, and still served.
    const bites = askedToday(deck);
    expect(bites).toBe(todayPlan(deck).bites);
    let d = deck;
    for (let b = 0; b < bites; b++) d = play(d, buildBite({ ...d, kind: "exam", bitesDoneToday: b })!);
    const after = reviewDay(d)!;
    expect(after.today).toBe(0);
    expect(after.later).toBeGreaterThan(0);
    expect(after.laterGain).toBeLessThan(BAR);
    expect(askedToday(d)).toBe(0);
    const more = buildBite({ ...d, kind: "exam", bitesDoneToday: bites })!;
    expect(ids(more).length).toBeGreaterThan(0);
    // One go serves the optional rest too, up to 40 at a time, no card she did today again.
    const rest1 = buildLong({ ...d, kind: "exam", bitesDoneToday: bites })!;
    expect(ids(rest1).length).toBeGreaterThan(8);
    expect(ids(rest1).length).toBeLessThanOrEqual(LONG_MAX);
    expect(ids(rest1).slice(0, ids(more).length)).toEqual(ids(more));
    const start21 = Date.UTC(2026, 10, 20, 22);
    expect(ids(rest1).every((id) => d.states[id].lastReviewAt! < start21)).toBe(true);
  });

  it("the day before the exam asks for less, and stopping at enough costs under a point a day", () => {
    const start = atTheCutoff();
    /** Each reviews-only day: the asked bites, or with `all` every bite offered. */
    const run = (all: boolean) => {
      let d: Deck = start.deck;
      const asked: number[] = [];
      for (const now of [at(21), at(22), new Date("2026-11-23T05:00:00Z")]) {
        d = { ...d, now, newToday: [] };
        asked.push(reviewDay(d)!.today);
        const bites = all ? 80 : askedToday(d);
        for (let b = 0; b < bites; b++) {
          const bite = buildBite({ ...d, kind: "exam", bitesDoneToday: b });
          if (!bite) break;
          expect(ids(bite).every((id) => seen(d, id))).toBe(true);
          d = play(d, bite);
        }
      }
      return { deck: d, asked };
    };
    const enough = run(false);
    const everything = run(true);
    // Saturday asks for the most, Sunday for less, exam morning for no more than Sunday.
    expect(enough.asked[0]).toBeGreaterThan(0);
    expect(enough.asked[1]).toBeLessThan(enough.asked[0]);
    expect(enough.asked[2]).toBeLessThanOrEqual(enough.asked[1]);
    const is = deckForecast(enough.deck);
    const best = deckForecast(everything.deck);
    expect(best).toBeGreaterThan(80);
    expect(is).toBeLessThanOrEqual(best + 1e-9);
    // Three days, each leaving less than a point on the table.
    expect(best - is).toBeLessThan(2);
    // The plan's own projection is the important reviews, so it is where stopping at enough lands.
    expect(simulate({ ...start.deck, now: at(21), newToday: [] }, "core").at(-1)).toBeGreaterThan(is - 1);
    // Nothing is scheduled after the exam.
    for (const c of everything.deck.cards) {
      const state = everything.deck.states[c.id];
      if (!state) continue;
      const due = aimedDue(state, EXAM, everything.deck.now);
      expect(due === null || due <= EXAM.getTime()).toBe(true);
    }
    expect(reviewDay({ ...everything.deck, now: at(23) })).toBeNull();
  });

  it("behind plan the same order applies and little may be asked; no new card is served", () => {
    // She studied on two days only.
    const start = atTheCutoff([16, 18]);
    expect(start.learned.length).toBeLessThan(100);
    const deck: Deck = { ...start.deck, now: at(21), newToday: [] };
    const due = dueBy(deck, endOf(21)).map((c) => c.id);
    const asked = reviewDay(deck)!;
    expect(asked.today + asked.later).toBe(due.length);
    const served = servedOrder(deck);
    expect(served.every((x) => seen(deck, x.id))).toBe(true);
    const worths = served.filter((x) => !deck.cards.find((c) => c.id === x.id)!.boss).map((x) => x.worth);
    for (let i = 1; i < worths.length; i++) expect(worths[i]).toBeLessThanOrEqual(worths[i - 1] + 1e-9);
    // The projection does not pretend: with most core cards unseen it ends far below a target of 85.
    expect(simulate(deck, "core").at(-1)!).toBeLessThan(60);
  });

  it("a deck without core marks and a day with new cards keep what they had", () => {
    const { deck } = atTheCutoff([16, 17]);
    // The cut-off day itself still serves new cards with up to four reviews: not a reviews-only day.
    expect(reviewDay({ ...deck, now: at(20), newToday: [] })).toBeNull();
    const plain: Deck = { ...deck, cards: deck.cards.map((c) => ({ ...c, core: false, first: false })), now: at(21) };
    expect(reviewDay(plain)).toBeNull();
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

describe("her own pace", () => {
  const log = (cards: number, ms: (i: number) => number | null) => Array.from({ length: cards }, (_, i) => ({ cardId: `k${i}`, ms: ms(i) }));

  it("is the median time a card, once 20 different cards are timed", () => {
    expect(secondsPerCard(log(19, () => 20_000))).toBeNull();
    expect(secondsPerCard(log(20, () => 20_000))).toBe(20);
    // The same card graded over and over is one card.
    expect(secondsPerCard(Array.from({ length: 50 }, () => ({ cardId: "k0", ms: 20_000 })))).toBeNull();
    // Untimed grades do not count; one card left open for ten minutes does not move the median.
    expect(secondsPerCard(log(25, (i) => (i < 6 ? null : 20_000)))).toBeNull();
    expect(secondsPerCard(log(21, (i) => (i === 0 ? 600_000 : 10_000 + i * 1000)))).toBe(21);
    expect(secondsPerCard(log(20, (i) => 10_000 + i * 1000))).toBe(19.5);
  });

  it("is never read as faster than five seconds a card", () => {
    expect(PACE_MIN_SECONDS).toBe(5);
    expect(secondsPerCard(log(40, () => 1_000))).toBe(5);
    expect(secondsPerCard(log(40, () => 9_000))).toBe(9);
  });

  it("the day's minutes and a bite's minutes come from one estimate and never contradict each other", () => {
    // The reported case: a pace of a second a card. A 9-card bite says 1 min; 15 of them say 15, not 2.
    const fast = secondsPerCard(log(40, () => 1_000));
    expect(minutesFor(9, fast)).toBe(1);
    expect(planMinutes(130, 15, fast)).toBe(15);
    for (const pace of [null, 5, 12, 20, 36, 60]) {
      for (const size of [5, 8, 9]) {
        for (const bites of [1, 3, 4, 8, 15]) {
          const total = planMinutes(size * bites, bites, pace);
          const parts = bites * minutesFor(size, pace);
          // At least a minute a bite, and within rounding (half a minute a bite) of the bites added up.
          expect(total).toBeGreaterThanOrEqual(bites);
          expect(Math.abs(total - parts)).toBeLessThanOrEqual(Math.max(1, bites));
        }
      }
    }
    expect(planMinutes(0, 0, 20)).toBe(0);
    expect(planMinutes(63, 7, 24)).toBe(25);
  });

  it("gives the minutes of a session; the app's estimate until it is known", () => {
    expect(minutesFor(63, null)).toBe(biteMinutes(63));
    expect(minutesFor(63, undefined)).toBe(38);
    expect(minutesFor(63, 24)).toBe(25);
    expect(minutesFor(63, 20)).toBe(21);
    expect(minutesFor(1, 5)).toBe(1);
    expect(minutesFor(0, 20)).toBe(0);
  });
});

describe("today's plan in one go", () => {
  /** The bites the plan asks of today, each built as if the one before had just been done (the clock not moved). */
  function bitesInARow(deck: Deck): string[][] {
    const at = new Date(deck.now);
    const states: Record<string, MemoryState> = { ...deck.states };
    const newToday = [...(deck.newToday ?? [])];
    const out: string[][] = [];
    const most = paceOf(deck)!.open ? paceOf(deck)!.bites : 99;
    for (let b = 0; b < most; b++) {
      const bite = buildBite({ ...deck, states, newToday, kind: "exam", bitesDoneToday: b });
      if (!bite) break;
      out.push(ids(bite));
      for (const id of ids(bite)) {
        if (!states[id]) newToday.push(id);
        states[id] = grade(states[id] ?? newCard(at), 3, at);
      }
    }
    return out;
  }

  it("is the bites the plan still asks of today, in order, whole bites up to 40 cards", () => {
    // Day one of 180 core cards: 36 new cards, eight bites, nothing due.
    const fresh = makeDeck(36, 10, 5, at(16));
    expect(paceOf(fresh)!.bites).toBe(8);
    const all = buildLong({ ...fresh, kind: "exam", bitesDoneToday: 0 })!;
    expect(ids(all)).toEqual(bitesInARow(fresh).flat());
    expect(ids(all)).toHaveLength(36);
    expect(new Set(ids(all)).size).toBe(36);
    expect(all.minutes).toBe(biteMinutes(36));
    expect(all.gain).toBeGreaterThan(0);
    // A boss card sits in a boss section, as in a bite.
    for (const [kind, list] of all.sections) for (const id of list) expect(fresh.cards.find((c) => c.id === id)!.boss).toBe(kind === "boss");

    // Day two: every bite also brings reviews, so 40 cards hold only the first bites; the rest is the next session.
    let deck = play(fresh, all);
    expect(paceOf(deck)!.left).toBe(0);
    deck = { ...deck, now: at(17), newToday: [] };
    const rows = bitesInARow(deck);
    expect(rows.flat().length).toBeGreaterThan(LONG_MAX);
    const first = buildLong({ ...deck, kind: "exam", bitesDoneToday: 0 })!;
    let fit = 0;
    let n = 0;
    while (fit < rows.length && n + rows[fit].length <= LONG_MAX) n += rows[fit++].length;
    expect(ids(first)).toEqual(rows.slice(0, fit).flat());
    expect(ids(first).length).toBeLessThanOrEqual(LONG_MAX);
    expect(ids(first).length).toBeGreaterThan(LONG_MAX - 10);
    const second = buildLong({ ...play(deck, first), kind: "exam", bitesDoneToday: 1 })!;
    expect(ids(second).some((id) => ids(first).includes(id))).toBe(false);
  });

  it("stopped part-way, what she did counts and the next session goes on from there", () => {
    const deck = makeDeck(36, 10, 5, at(16));
    const whole = buildLong({ ...deck, kind: "exam", bitesDoneToday: 0 })!;
    // She stops after 13 cards.
    const done = ids(whole).slice(0, 13);
    const after = play(deck, { sections: [["learn", done]], minutes: 0, gain: 0 });
    expect(paceOf(after)!).toMatchObject({ budget: 36, newToday: 13, left: 23, bites: 5 });
    expect(todayPlan(after)).toMatchObject({ bites: 5 });
    expect(todayPlan(after).cards).toBe(23);
    const rest = buildLong({ ...after, kind: "exam", bitesDoneToday: 1 })!;
    // The same cards that were left (a boss card closes whichever bite it now falls in).
    expect(ids(rest).filter((id) => !seen(after, id)).sort()).toEqual(ids(whole).slice(13).sort());
    // The same 13 cards done as bites leave the day in the same place.
    expect(paceOf(play(deck, { sections: [["warm", done]], minutes: 0, gain: 0 }))!.left).toBe(23);
  });

  it("on a reviews-only day it holds the important reviews, most valuable first, 40 at a time", () => {
    // The plan kept to the cut-off, as in the tests above.
    let deck = makeDeck(36, 10, 5, at(16));
    for (const day of [16, 17, 18, 19, 20]) {
      deck = { ...deck, now: at(day), newToday: [] };
      for (let g = 0; g < 10 && askedToday(deck) > 0; g++) deck = play(deck, buildLong({ ...deck, kind: "exam", bitesDoneToday: g })!);
    }
    expect(Object.keys(deck.states)).toHaveLength(180);
    deck = { ...deck, now: at(21), newToday: [] };
    const important = reviewDay(deck)!.today;
    expect(important).toBeGreaterThan(LONG_MAX);
    const morning = deck;
    const served: string[] = [];
    let sessions = 0;
    for (; sessions < 10 && reviewDay(deck)!.today > 0; sessions++) {
      const long = buildLong({ ...deck, kind: "exam", bitesDoneToday: sessions })!;
      expect(ids(long).length).toBeLessThanOrEqual(LONG_MAX);
      expect(ids(long).every((id) => seen(deck, id))).toBe(true);
      served.push(...ids(long));
      deck = play(deck, long);
    }
    // The important ones and at most the rest of the bite that finishes them; no card twice.
    expect(served.length).toBeGreaterThanOrEqual(important);
    expect(served.length).toBeLessThan(important + 9);
    expect(new Set(served).size).toBe(served.length);
    expect(sessions).toBeLessThanOrEqual(Math.ceil(served.length / (LONG_MAX - 9)));
    const worth = reviewWorth(morningOf(morning), served);
    const plain = served.filter((id) => !morning.cards.find((c) => c.id === id)!.boss).map((id) => worth.get(id)!);
    for (let i = 1; i < plain.length; i++) expect(plain[i]).toBeLessThanOrEqual(plain[i - 1] + 1e-9);
    // What is left is optional, and one go still serves it.
    expect(reviewDay(deck)!.later).toBeGreaterThan(0);
    expect(buildLong({ ...deck, kind: "exam", bitesDoneToday: sessions })).not.toBeNull();
  });

  it("the week lands on the same numbers whether she does bites or one-go sessions", () => {
    const deck = makeDeck(36, 10, 5, at(16));
    const bites = simulate(deck, "core");
    const long = simulate(deck, "long");
    expect(long).toHaveLength(bites.length);
    // The same number on exam day (within half a point), and day by day within a point.
    expect(Math.abs(long.at(-1)! - bites.at(-1)!)).toBeLessThan(0.5);
    for (let d = 0; d < bites.length; d++) expect(Math.abs(long[d] - bites[d])).toBeLessThan(1);
  });

  it("a deck without core marks gets its ordinary bite", () => {
    const plain = makeDeck(8, 10, 0, at(16));
    const unmarked: Deck = { ...plain, cards: plain.cards.map((c) => ({ ...c, first: false })) };
    expect(ids(buildLong({ ...unmarked, kind: "exam", bitesDoneToday: 0 }))).toEqual(ids(buildBite({ ...unmarked, kind: "exam", bitesDoneToday: 0 })));
    expect(buildLong({ ...unmarked, kind: "exam", bitesDoneToday: 2 })).toBeNull();
    expect(todayPlan(unmarked)).toEqual({ bites: 0, cards: 0 });
  });
});

describe("the minutes left for today", () => {
  /** The plan kept in bites from the 16th up to (not including) `day`. */
  function upTo(day: number): Deck {
    let deck = makeDeck(36, 10, 5, at(16));
    for (let d = 16; d < day && d <= 20; d++) {
      deck = { ...deck, now: at(d), newToday: [] };
      const bites = paceOf(deck)!.bites;
      for (let b = 0; b < bites; b++) deck = play(deck, buildBite({ ...deck, kind: "exam", bitesDoneToday: b })!);
    }
    return { ...deck, now: at(day), newToday: [] };
  }

  /**
   * Walks the day card by card: sessions one after the other (bites or one-go) while the plan
   * asks for a bite, `seconds` a card, every seventh card missed. After every answered card the
   * cards left, and the minutes at any pace, must not have gone up.
   */
  function walk(start: Deck, oneGo: boolean, seconds: number): { cards: number; first: number; last: number } {
    let deck = start;
    const first = cardsLeftToday(deck);
    let left = first;
    let bitesLeft = askedToday(deck);
    let answered = 0;
    const check = () => {
      const now = cardsLeftToday(deck);
      expect(now).toBeLessThanOrEqual(left);
      for (const pace of [null, 12, 20, 47]) expect(minutesFor(now, pace)).toBeLessThanOrEqual(minutesFor(left, pace));
      // The label's own number, with its bites: at a real pace and at the fastest one.
      const bitesNow = askedToday(deck);
      for (const pace of [5, 20]) expect(planMinutes(now, bitesNow, pace)).toBeLessThanOrEqual(planMinutes(left, bitesLeft, pace));
      left = now;
      bitesLeft = bitesNow;
    };
    for (let s = 0; s < 60 && askedToday(deck) > 0; s++) {
      const session = (oneGo ? buildLong : buildBite)({ ...deck, kind: "exam", bitesDoneToday: s });
      if (!session) break;
      for (const id of ids(session)) {
        const t = new Date(new Date(deck.now).getTime() + seconds * 1000);
        const states = { ...deck.states };
        const newToday = [...(deck.newToday ?? [])];
        if (!states[id]) newToday.push(id);
        states[id] = grade(states[id] ?? newCard(t), ++answered % 7 === 0 ? 1 : 3, t);
        deck = { ...deck, states, newToday, now: t };
        check();
      }
    }
    return { cards: answered, first, last: left };
  }

  it("never go up after an answered card on a day with new cards, in bites or in one go, fast or slow", () => {
    const morning = upTo(17);
    // 36 new cards and the reviews the day allows for: four a bite, eight bites.
    expect(paceOf(morning)!).toMatchObject({ budget: 36, left: 36, bites: 8 });
    expect(cardsLeftToday(morning)).toBe(36 + 32);
    for (const oneGo of [false, true]) {
      for (const seconds of [20, 180]) {
        const day = walk(morning, oneGo, seconds);
        expect(day.first).toBe(68);
        expect(day.cards).toBeGreaterThan(36);
        // The budget is used: the plan asks for nothing more.
        expect(day.last).toBe(0);
      }
    }
    // The first day has no reviews to allow for: the new cards alone.
    expect(cardsLeftToday(upTo(16))).toBe(36);
  });

  it("never go up on a reviews-only day, and count the important reviews only", () => {
    for (const day of [21, 22]) {
      const morning = upTo(day);
      const asked = reviewDay(morning)!;
      expect(cardsLeftToday(morning)).toBe(asked.today);
      expect(asked.later).toBeGreaterThan(0);
      for (const oneGo of [false, true]) {
        const walked = walk(morning, oneGo, 20);
        expect(walked.first).toBe(asked.today);
        expect(walked.last).toBe(0);
      }
      // A slow day too: three minutes a card.
      expect(walk(morning, true, 180).last).toBe(0);
    }
  });

  it("is the same count whatever the time of day, until she answers a card", () => {
    for (const day of [17, 21]) {
      const morning = upTo(day);
      const evening = { ...morning, now: new Date(new Date(morning.now).getTime() + 9 * 60 * 60 * 1000) };
      expect(cardsLeftToday(evening)).toBe(cardsLeftToday(morning));
    }
    // A deck that is not paced has no plan in minutes.
    const plain = makeDeck(8, 10, 0, at(16));
    expect(cardsLeftToday({ ...plain, cards: plain.cards.map((c) => ({ ...c, first: false })) })).toBe(0);
  });
});
