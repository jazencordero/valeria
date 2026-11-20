/**
 * A replay of a reviews-only day on an invented deck, session by session: the
 * projected exam-day number must not fall while she does the plan and recalls
 * her cards, and the status must not turn against her. Simulation-heavy, so
 * it has its own file.
 */
import { describe, expect, it } from "vitest";
import { buildBite, buildLong, type BiteCard, type BiteConcept, type Deck } from "./bite";
import { deckForecast } from "./forecast";
import { grade, newCard, type MemoryState } from "./memory";
import { paceOf } from "./pace";
import { askedToday, planOf, verdictOf } from "./plan";

// The exam: Monday 23 Nov 2026, 09:00 in Helsinki. Saturday the 21st is two days before it.
const EXAM = new Date("2026-11-23T07:00:00Z");
const at = (day: number) => new Date(Date.UTC(2026, 10, day, 8, 0, 0));
const ids = (deck: Deck, long: boolean, n: number) =>
  ((long ? buildLong : buildBite)({ ...deck, kind: "exam", bitesDoneToday: n })?.sections ?? []).flatMap(([, list]) => list);

/** 360 invented cards in 36 concepts, 180 of them core. */
function makeDeck(now: Date): Deck {
  const concepts: BiteConcept[] = Array.from({ length: 36 }, (_, i) => ({ id: `c${i}`, weight: 1 + (i % 3), order: i }));
  const cards: BiteCard[] = [];
  for (let c = 0; c < 36; c++) {
    for (let k = 0; k < 10; k++) {
      cards.push({ id: `k${cards.length}`, conceptId: `c${c}`, rung: ((k % 5) + 1) as BiteCard["rung"], type: "basic", boss: false, active: true, core: k < 5 });
    }
  }
  return { cards, states: {}, concepts, examAt: EXAM, now, kind: "exam", newToday: [], coreMarked: true };
}

/**
 * She does the cards, 20 seconds each. Every `missEvery`th card she has met before is missed and
 * passed on the retry a minute later, as the player has her do (0: every card recalled).
 */
function answer(deck: Deck, cards: readonly string[], missEvery: number, counter: { n: number; missed: number }): Deck {
  const states: Record<string, MemoryState> = { ...deck.states };
  const newToday = [...(deck.newToday ?? [])];
  let t = new Date(deck.now).getTime();
  for (const id of cards) {
    t += 20_000;
    const before = states[id];
    if (!before) {
      newToday.push(id);
      states[id] = grade(newCard(new Date(t)), 3, new Date(t));
      continue;
    }
    if (missEvery > 0 && ++counter.n % missEvery === 0) {
      counter.missed++;
      states[id] = grade(grade(before, 1, new Date(t)), 3, new Date(t + 60_000));
      t += 60_000;
    } else states[id] = grade(before, 3, new Date(t));
  }
  return { ...deck, states, newToday, now: new Date(t) };
}

/** The plan kept from Monday the 16th to the cut-off on Friday the 20th, one review in `missEvery` missed. */
function saturdayMorning(missEvery: number): Deck {
  let deck = makeDeck(at(16));
  const counter = { n: 0, missed: 0 };
  for (let day = 16; day <= 20; day++) {
    deck = { ...deck, now: at(day), newToday: [] };
    const bites = paceOf(deck)!.bites;
    for (let b = 0; b < bites; b++) deck = answer(deck, ids(deck, false, b), missEvery, counter);
  }
  return { ...deck, now: at(21), newToday: [] };
}

/** Saturday as the report did it: one go twice, then bites while the plan asks for one. */
function replay(morning: Deck, target: number, missEvery: number) {
  let deck = morning;
  const counter = { n: 0, missed: 0 };
  const read = (missed: number) => {
    const plan = planOf(deck, target);
    const forecast = deckForecast(deck);
    return { end: plan.end, forecast, key: verdictOf(Math.round(forecast), target, plan, { day: "Monday" }).key, missed };
  };
  const steps = [read(0)];
  for (let s = 0; s < 40 && askedToday(deck) > 0; s++) {
    const before = counter.missed;
    const cards = ids(deck, s < 2, s);
    expect(cards.length).toBeGreaterThan(0);
    deck = answer(deck, cards, missEvery, counter);
    steps.push(read(counter.missed - before));
  }
  return steps;
}

describe("a reviews-only day two days before the exam, session by session", () => {
  // She reached the cut-off with one review in three missed: every core card seen, the forecast well under the projection.
  const morning = saturdayMorning(3);
  const start = planOf(morning, 0);
  // A target she is on track for, just: one point under where the plan lands.
  const target = Math.floor(start.end) - 1;

  it("starts on track, with reviews asked for and a forecast below the target", () => {
    expect(paceOf(morning)!).toMatchObject({ open: false, coreUnseen: 0 });
    expect(askedToday(morning)).toBeGreaterThan(6);
    expect(deckForecast(morning)).toBeLessThan(target);
    expect(planOf(morning, target).reaches).toBe(true);
    expect(verdictOf(Math.round(deckForecast(morning)), target, planOf(morning, target), { day: "Monday" }).key).toBe("on_track");
  });

  it("with every card recalled the projected end never falls and the status never leaves on track", () => {
    const steps = replay(morning, target, 0);
    expect(steps.length).toBeGreaterThan(4);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].end).toBeGreaterThanOrEqual(steps[i - 1].end - 1e-9);
      expect(steps[i].forecast).toBeGreaterThan(steps[i - 1].forecast);
      expect(["on_track", "ready"]).toContain(steps[i].key);
    }
    // Recalling everything is better than the projection expected: the end has risen.
    expect(steps.at(-1)!.end).toBeGreaterThan(steps[0].end);
    // Where the day's forecast ends is where the projection said the day would end, or above.
    expect(steps.at(-1)!.forecast).toBeGreaterThanOrEqual(start.curve[1] - 1e-9);
  });

  it("a wrong answer lowers it only by what that answer costs", () => {
    const steps = replay(morning, target, 5);
    const missed = steps.reduce((n, s) => n + s.missed, 0);
    expect(missed).toBeGreaterThan(10);
    const fall = steps[0].end - steps.at(-1)!.end;
    // One answer in five wrong is more than the projection expected, so the end may fall,
    // by less than a tenth of a point a missed card (360 cards, 180 counted)...
    expect(fall).toBeLessThan(missed * 0.1);
    for (let i = 1; i < steps.length; i++) expect(steps[i - 1].end - steps[i].end).toBeLessThan(Math.max(1, steps[i].missed) * 0.15);
    // ...and by less than it would if every planned review had been counted as recalled:
    // the projection had already allowed for some of these misses.
    const clean = replay(morning, target, 0);
    expect(clean.at(-1)!.end - steps.at(-1)!.end).toBeGreaterThan(fall);
    // The status copy stays true: whenever it says not reachable, the projected end is under the target.
    for (const s of steps) expect(s.key === "not_reachable").toBe(s.forecast < target && Math.round(s.end) < target);
  });

  it("the projection is never above the same plan played with every card recalled", () => {
    for (const missEvery of [0, 3]) {
      const deck = saturdayMorning(missEvery);
      const plan = planOf(deck, 85);
      expect(plan.curve[0]).toBe(deckForecast(deck));
      // The plan played by hand, every card recalled, to the day before the exam.
      let played = deck;
      for (const day of [21, 22]) {
        played = { ...played, now: at(day), newToday: [] };
        for (let b = 0; b < 40 && askedToday(played) > 0; b++) played = answer(played, ids(played, false, b), 0, { n: 0, missed: 0 });
      }
      expect(plan.end).toBeLessThanOrEqual(deckForecast(played) + 1e-9);
      expect(plan.end).toBeGreaterThan(deckForecast(played) - 3);
    }
  });
});
