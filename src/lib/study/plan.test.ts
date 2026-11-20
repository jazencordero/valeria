import { describe, expect, it } from "vitest";
import { buildBite, type Bite, type BiteCard, type BiteConcept, type Deck, type ExamKind } from "./bite";
import { deckForecast, deckMasteries, forecastNow, gainLabel, gainOf, GAIN_SHOWN_FROM } from "./forecast";
import { conceptMastery } from "./ladder";
import { grade, newCard, recallAt, type MemoryState } from "./memory";
import { paceOf } from "./pace";
import {
  askedToday,
  flatPlan,
  keepWords,
  leftLine,
  optionalLine,
  paceWords,
  planOf,
  planSentence,
  simulate,
  todayLine,
  verdictOf,
  type Plan,
  type PlanPace,
} from "./plan";

const DAY = 24 * 60 * 60 * 1000;
// Monday 23 Nov 2026, 09:00 in Helsinki.
const EXAM = new Date("2026-11-23T07:00:00Z");
/** 10:00 in Helsinki on a November day of 2026. */
const at = (day: number) => new Date(Date.UTC(2026, 10, day, 8, 0, 0));
const ids = (b: Bite | null) => (b ? b.sections.flatMap(([, s]) => s) : []);

/** An invented deck: `concepts` concepts of `per` cards; the first `core` of each are core. */
function makeDeck(concepts: number, per: number, core: number, now: Date, kind: ExamKind = "exam"): Deck {
  const list: BiteConcept[] = Array.from({ length: concepts }, (_, i) => ({ id: `c${i}`, weight: 1 + (i % 3), order: i }));
  const cards: BiteCard[] = [];
  for (let c = 0; c < concepts; c++) {
    for (let k = 0; k < per; k++) {
      cards.push({
        id: `k${cards.length}`,
        conceptId: `c${c}`,
        rung: ((k % 5) + 1) as BiteCard["rung"],
        type: "basic",
        boss: false,
        active: true,
        core: k < core,
      });
    }
  }
  return { cards, states: {}, concepts: list, examAt: EXAM, now, kind, newToday: [] };
}

/** The same deck with its first `n` cards graded Good three days before `deck.now`. */
function withSeen(deck: Deck, n: number): Deck {
  const t = new Date(new Date(deck.now).getTime() - 3 * DAY);
  const states: Record<string, MemoryState> = {};
  for (const c of deck.cards.slice(0, n)) states[c.id] = grade(newCard(t), 3, t);
  return { ...deck, states };
}

describe("the gain of a session", () => {
  it("is the forecast if each of its cards is recalled, minus the forecast now", () => {
    const deck = withSeen(makeDeck(6, 8, 0, at(16)), 10);
    const bite = buildBite({ ...deck, kind: "exam", bitesDoneToday: 0 })!;
    // Worked out here from the model itself: every card of the bite graded Good now.
    const now = new Date(deck.now);
    const after = { ...deck.states };
    for (const id of ids(bite)) after[id] = grade(after[id] ?? newCard(now), 3, now);
    const forecast = (states: Record<string, MemoryState>) =>
      forecastNow(
        deck.concepts.map((c) => ({
          weight: c.weight,
          mastery: conceptMastery(
            deck.cards.filter((k) => k.conceptId === c.id).map((k) => ({ state: states[k.id] ?? newCard(EXAM), active: true })),
            EXAM,
          ),
        })),
      );
    expect(bite.gain).toBeCloseTo(forecast(after) - forecast(deck.states), 10);
    expect(bite.gain).toBe(gainOf(deck, ids(bite)));
    expect(bite.gain).toBeGreaterThan(0);
    // The deck's forecast is the same model.
    expect(deckForecast(deck)).toBeCloseTo(forecast(deck.states), 10);
    expect(deckMasteries(deck).c0).toBeCloseTo(
      deck.cards.filter((k) => k.conceptId === "c0").reduce((s, k) => s + recallAt(deck.states[k.id] ?? newCard(EXAM), EXAM), 0) / 8,
      10,
    );
  });

  it("is a fraction of a point on a 400-card deck, never the old flat +4 to +7", () => {
    const deck = makeDeck(40, 10, 5, at(16));
    const bite = buildBite({ ...deck, kind: "exam", bitesDoneToday: 0 })!;
    expect(ids(bite)).toHaveLength(5);
    expect(bite.gain).toBeGreaterThan(0);
    expect(bite.gain).toBeLessThan(2);
  });

  it("is shown as measured, and not at all under half a point", () => {
    expect(GAIN_SHOWN_FROM).toBe(0.5);
    expect(gainLabel(0.5)).toBe("+0.5%");
    expect(gainLabel(0.54)).toBe("+0.5%");
    expect(gainLabel(1.26)).toBe("+1.3%");
    expect(gainLabel(9.94)).toBe("+9.9%");
    expect(gainLabel(9.96)).toBe("+10%");
    expect(gainLabel(12.4)).toBe("+12%");
    for (const g of [0.49, 0.3, 0, -1, Number.NaN, null, undefined]) expect(gainLabel(g)).toBeNull();
  });
});

describe("the readiness model", () => {
  const card = (id: string, conceptId: string, extra: Partial<BiteCard> = {}): BiteCard => ({ id, conceptId, rung: 1, type: "basic", boss: false, active: true, ...extra });
  const t = new Date(at(16).getTime() - DAY);
  const known = () => grade(grade(newCard(t), 4, t), 4, new Date(t.getTime() + 20 * 60 * 1000));
  const deckOf = (cards: BiteCard[], states: Record<string, MemoryState> = {}): Deck => ({
    cards,
    states,
    concepts: [
      { id: "a", weight: 3, order: 0 },
      { id: "b", weight: 1, order: 1 },
    ],
    examAt: EXAM,
    now: at(16),
    kind: "exam",
  });
  const marked = [
    card("a1", "a", { core: true }),
    card("a2", "a", { core: true }),
    card("a3", "a"),
    card("a4", "a"),
    card("b1", "b", { core: true }),
    card("b2", "b"),
  ];
  const r = recallAt(known(), EXAM);

  it("a deck without core marks is measured over all its cards, as before", () => {
    const plain = marked.map((c) => ({ ...c, core: false }));
    const deck = deckOf(plain, { a1: known(), a2: known() });
    expect(deckMasteries(deck)).toEqual({ a: (2 * r) / 4, b: 0 });
    expect(deckForecast(deck)).toBeCloseTo((100 * 3 * ((2 * r) / 4)) / 4, 10);
  });

  it("a deck with core marks is measured on its core cards; an unseen core card counts as not known", () => {
    expect(r).toBeGreaterThan(0.9);
    expect(deckMasteries(deckOf(marked))).toEqual({ a: 0, b: 0 });
    // One of concept a's two core cards known: half of that concept, whatever its other cards.
    expect(deckMasteries(deckOf(marked, { a1: known() }))).toEqual({ a: r / 2, b: 0 });
    // Every core card known: the forecast is her recall of them, not 3 cards out of 6.
    const all = deckOf(marked, { a1: known(), a2: known(), b1: known() });
    expect(deckMasteries(all)).toEqual({ a: r, b: r });
    expect(deckForecast(all)).toBeCloseTo(100 * r, 10);
    // The same cards known in an unmarked deck would read as half.
    expect(deckForecast(deckOf(marked.map((c) => ({ ...c, core: false })), all.states))).toBeCloseTo(50 * r, 10);
  });

  it("other cards add on top only once the concept's core cards are all seen", () => {
    const weak = grade(newCard(t), 1, t);
    const rw = recallAt(weak, EXAM);
    // An extra card met before core is covered counts for nothing.
    expect(deckMasteries(deckOf(marked, { a1: known(), a3: known() })).a).toBe(r / 2);
    // Core covered: the extra cards she has met join the mean; the unmet one (a4) never counts against her.
    expect(deckMasteries(deckOf(marked, { a1: known(), a2: known(), a3: known() })).a).toBeCloseTo(r, 10);
    expect(deckMasteries(deckOf(marked, { a1: known(), a2: known(), a3: weak })).a).toBeCloseTo((2 * r + rw) / 3, 10);
    expect(deckMasteries(deckOf(marked, { a1: known(), a2: known() })).a).toBe(r);
  });

  it("a concept with no core card is measured over all its cards, and a suspended card is left out", () => {
    const cards = [card("a1", "a", { core: true }), card("b1", "b"), card("b2", "b"), card("b3", "b", { active: false })];
    expect(deckMasteries(deckOf(cards, { b1: known() }))).toEqual({ a: 0, b: r / 2 });
    // A caller that cut cards out still says the deck is marked.
    const cut = { ...deckOf([card("b1", "b"), card("b2", "b")], { b1: known() }), coreMarked: true };
    expect(deckMasteries(cut).b).toBe(r / 2);
  });
});

/** The plan played by hand: each day the bites the screen asks for, every card recalled. */
function playedByHand(deck: Deck, perDay: number | "core", doneToday = 0): number {
  let states: Record<string, MemoryState> = { ...deck.states };
  const start = new Date(deck.now).getTime();
  const days = Math.round((Date.UTC(2026, 10, 23) - Date.UTC(2026, 10, new Date(start).getUTCDate())) / DAY);
  for (let d = 0; d < days; d++) {
    const day = doDay({ ...deck, states, now: new Date(start + d * DAY), newToday: d === 0 ? deck.newToday : [] }, perDay === "core" ? null : perDay - (d === 0 ? doneToday : 0));
    states = day.states as Record<string, MemoryState>;
  }
  return deckForecast(deck, states);
}

/**
 * One day as she does it: `bites` bites (null: what a paced plan asks today), every card
 * recalled, 20 seconds a card. Returns the deck after the day.
 */
function doDay(deck: Deck, bites: number | null): Deck {
  const states: Record<string, MemoryState> = { ...deck.states };
  const newToday = [...(deck.newToday ?? [])];
  let t = new Date(deck.now).getTime();
  const n = bites ?? askedToday(deck);
  for (let b = 0; b < n; b++) {
    const bite = buildBite({ ...deck, states, now: t, newToday, kind: deck.kind ?? "exam", bitesDoneToday: 0 });
    if (!bite) break;
    for (const id of ids(bite)) {
      t += 20_000;
      if (!states[id]) newToday.push(id);
      states[id] = grade(states[id] ?? newCard(new Date(t)), 3, new Date(t));
    }
  }
  return { ...deck, states, newToday };
}

describe("the plan's projection", () => {
  it("is a simulation of the bites the plan serves: one value a day, today to exam day", () => {
    const deck = withSeen(makeDeck(6, 8, 0, at(16)), 10);
    const curve = simulate(deck, 1);
    expect(curve).toHaveLength(8); // the 16th to the 23rd
    expect(curve[0]).toBe(deckForecast(deck));
    // The projection expects some misses at the planned reviews: it ends a little under the same
    // bites played with every card recalled, never above.
    const under = (projected: number, recalled: number) => {
      expect(projected).toBeLessThanOrEqual(recalled);
      expect(projected).toBeGreaterThan(recalled - 1);
    };
    under(curve[7], playedByHand(deck, 1));
    under(simulate(deck, 2)[7], playedByHand(deck, 2));
    expect(simulate(deck, 2)[7]).toBeGreaterThan(curve[7]);
    // A bite already done today is not played again.
    expect(simulate(deck, 1, 1)[1]).toBe(curve[0]);
    under(simulate(deck, 1, 1)[7], playedByHand(deck, 1, 1));
    // On exam day, and after it, there is nothing left to play.
    expect(simulate({ ...deck, now: new Date("2026-11-23T05:00:00Z") }, 1)).toHaveLength(1);
    expect(simulate({ ...deck, now: at(25) }, 1)).toHaveLength(1);
  });

  it("the plan sentence says that simulation's number, with the plan's own pace", () => {
    const deck = withSeen(makeDeck(6, 8, 0, at(16)), 10);
    const plan = planOf(deck, 10);
    expect(plan.pace).toEqual({ kind: "bites", perDay: 1 });
    expect(plan.end).toBe(simulate(deck, 1)[7]);
    expect(plan.end).toBeLessThanOrEqual(playedByHand(deck, 1));
    expect(plan.end).toBe(plan.curve[plan.curve.length - 1]);
    expect(plan.endShown).toBe(Math.round(plan.end));
    expect(planSentence(plan, "Monday")).toBe(`A bite a day gets you to about ${plan.endShown}% by Monday.`);
  });

  it("a paced deck is projected with its core-first plan, and that plan reaches a high forecast", () => {
    const deck = makeDeck(40, 10, 5, at(16));
    const plan = planOf(deck, 85);
    const pace = paceOf(deck)!;
    expect(plan.pace).toEqual({ kind: "core", open: true, perDay: Math.ceil(pace.budget / 5), bitesToday: pace.bites });
    expect(plan.curve).toHaveLength(8);
    expect(plan.end).toBeLessThanOrEqual(playedByHand(deck, "core"));
    expect(plan.end).toBeGreaterThan(playedByHand(deck, "core") - 1);
    // 200 of 400 cards are core: seeing and holding them is what readiness measures.
    expect(plan.endShown).toBeGreaterThan(85);
    expect(plan.reaches).toBe(true);
    // The same cards without marks, at the unmarked pace, stay far below.
    const plain = { ...deck, cards: deck.cards.map((c) => ({ ...c, core: false })) };
    expect(planOf(plain, 85).endShown).toBeLessThan(40);
    expect(planSentence(plan, "Monday")).toBe(`8 bites a day gets you to about ${plan.endShown}% by Monday.`);
  });

  it("past the cut-off a paced plan asks for the bites that clear today's reviews", () => {
    let deck = makeDeck(8, 10, 5, at(16));
    deck = doDay(deck, null);
    const later = { ...deck, now: at(21), newToday: [] };
    expect(paceOf(later)!.open).toBe(false);
    const asked = askedToday(later);
    expect(asked).toBeGreaterThan(0);
    const plan = planOf(later, 20);
    expect(plan.pace).toEqual({ kind: "core", open: false, perDay: asked, bitesToday: asked });
    expect(planSentence(plan, "Monday")).toBe(`Your reviews get you to about ${plan.endShown}% by Monday.`);
    // Once they are done, nothing more is asked today.
    expect(askedToday(doDay(later, null))).toBe(0);
  });
});

describe("one pace", () => {
  it("is the fewest bites a day that reach the target, up to what the app serves", () => {
    const deck = withSeen(makeDeck(6, 8, 0, at(16)), 10);
    const one = simulate(deck, 1)[7];
    const two = simulate(deck, 2)[7];
    expect(two).toBeGreaterThan(one + 2);
    // A target one bite a day reaches.
    expect(planOf(deck, Math.floor(one) - 1)).toMatchObject({ pace: { kind: "bites", perDay: 1 }, reaches: true });
    // A target only two bites a day reach.
    const between = Math.round((one + two) / 2);
    expect(planOf(deck, between)).toMatchObject({ pace: { kind: "bites", perDay: 2 }, reaches: true, end: two });
    // A target nothing reaches: the most the app serves, and it does not reach.
    expect(planOf(deck, 99)).toMatchObject({ pace: { kind: "bites", perDay: 2 }, reaches: false, end: two });
    // A quiz has one bite a day, whatever the target.
    expect(planOf({ ...deck, kind: "quiz" }, 99)).toMatchObject({ pace: { kind: "bites", perDay: 1 }, reaches: false });
  });

  it("is named the same way wherever it is said", () => {
    const core: PlanPace = { kind: "core", open: true, perDay: 8, bitesToday: 3 };
    const closed: PlanPace = { kind: "core", open: false, perDay: 2, bitesToday: 2 };
    expect(paceWords({ kind: "bites", perDay: 1 })).toBe("a bite a day");
    expect(paceWords({ kind: "bites", perDay: 2 })).toBe("two bites a day");
    expect(paceWords(core)).toBe("8 bites a day");
    expect(paceWords({ ...core, perDay: 1 })).toBe("1 bite a day");
    expect(paceWords(closed)).toBe("your reviews");
    expect(keepWords({ kind: "bites", perDay: 1 })).toBe("Keep a bite a day");
    expect(keepWords({ kind: "bites", perDay: 2 })).toBe("Keep two bites a day");
    expect(keepWords(core)).toBe("Keep 8 bites a day");
    expect(keepWords(closed)).toBe("Keep up your reviews");
    const two: Plan = { pace: { kind: "bites", perDay: 2 }, curve: [40, 62.4], end: 62.4, endShown: 62, reaches: false };
    expect(planSentence(two, "Friday")).toBe("Two bites a day gets you to about 62% by Friday.");
    expect(verdictOf(40, 85, two, { day: "Friday" }).text).toContain("Two bites a day gets you to about 62%.");
  });

  it("an exam that is over or not started promises no pace", () => {
    const deck = withSeen(makeDeck(6, 8, 0, at(16)), 10);
    const flat = flatPlan(deck, 85);
    expect(flat.curve).toEqual([deckForecast(deck)]);
    expect(flat.end).toBe(deckForecast(deck));
    expect(flat.reaches).toBe(false);
  });
});

describe("the status", () => {
  const plan = (pace: PlanPace, end: number, target: number): Plan => ({ pace, curve: [10, end], end, endShown: Math.round(end), reaches: Math.round(end) >= target });
  const core: PlanPace = { kind: "core", open: true, perDay: 8, bitesToday: 8 };
  const day = { day: "Mon 23 Nov" };

  it("before the study start says when it starts, whatever the numbers", () => {
    expect(verdictOf(90, 85, plan({ kind: "bites", perDay: 1 }, 95, 85), { ...day, starts: "Tue 24 Nov" })).toEqual({
      key: "before_start",
      text: "Starts Tue 24 Nov",
      ok: false,
    });
  });

  it("ready and on track keep their sentences", () => {
    expect(verdictOf(86, 85, plan({ kind: "bites", perDay: 1 }, 90, 85), day)).toMatchObject({ key: "ready", text: "Ready. Keep it warm.", ok: true });
    expect(verdictOf(60, 85, plan({ kind: "bites", perDay: 1 }, 85.2, 85), day)).toMatchObject({ key: "on_track", text: "On track with a bite a day", ok: true });
    expect(verdictOf(11, 85, plan(core, 90, 85), day)).toMatchObject({ key: "on_track", text: "On track with 8 bites a day", ok: true });
    expect(verdictOf(11, 85, plan({ kind: "core", open: false, perDay: 2, bitesToday: 2 }, 90, 85), day).text).toBe("On track with 2 bites of reviews today");
    expect(verdictOf(11, 85, plan({ kind: "core", open: false, perDay: 1, bitesToday: 1 }, 90, 85), day).text).toBe("On track with 1 bite of reviews today");
    expect(verdictOf(11, 85, plan({ kind: "core", open: false, perDay: 0, bitesToday: 0 }, 90, 85), day).text).toBe("On track. Today’s plan is done.");
  });

  it("reachable: more than a bite a day is needed, and it gets there", () => {
    expect(verdictOf(60, 85, plan({ kind: "bites", perDay: 2 }, 88, 85), day)).toEqual({
      key: "reachable",
      text: "Two bites a day gets you to your 85% by Mon 23 Nov",
      ok: false,
    });
  });

  it("not reachable: says so, with the pace and the number the model gives", () => {
    expect(verdictOf(6, 85, plan({ kind: "bites", perDay: 2 }, 23.4, 85), day)).toEqual({
      key: "not_reachable",
      text: "At this point you won’t reach 85% by Mon 23 Nov. Two bites a day gets you to about 23%.",
      ok: false,
    });
    expect(verdictOf(6, 85, plan({ kind: "bites", perDay: 1 }, 20, 85), day).text).toBe(
      "At this point you won’t reach 85% by Mon 23 Nov. A bite a day gets you to about 20%.",
    );
    expect(verdictOf(6, 85, plan({ ...core, perDay: 12 }, 62, 85), day).text).toBe(
      "At this point you won’t reach 85% by Mon 23 Nov. 12 bites a day gets you to about 62%. Core cards first.",
    );
    expect(verdictOf(6, 85, plan({ kind: "core", open: false, perDay: 3, bitesToday: 3 }, 62, 85), day).text).toBe(
      "At this point you won’t reach 85% by Mon 23 Nov. Your reviews get you to about 62%.",
    );
  });

  it("never promises the target when the plan ends below it", () => {
    const decks = [
      withSeen(makeDeck(6, 8, 0, at(16)), 10),
      makeDeck(40, 10, 5, at(16)),
      makeDeck(40, 10, 5, at(19)),
      withSeen(makeDeck(6, 8, 0, at(21), "quiz"), 20),
      makeDeck(3, 4, 0, at(10)),
    ];
    const seenKeys = new Set<string>();
    for (const deck of decks) {
      const shown = Math.round(deckForecast(deck));
      for (const target of [20, 50, 70, 85, 95]) {
        const p = planOf(deck, target);
        const v = verdictOf(shown, target, p, { day: "Monday" });
        seenKeys.add(v.key);
        const below = p.endShown < target && shown < target;
        expect(v.key === "not_reachable").toBe(below);
        if (below) {
          expect(v.ok).toBe(false);
          expect(v.text).not.toMatch(/on track|gets you to your|ready/i);
          expect(v.text).toContain(`about ${p.endShown}%`);
        }
        // The chip, the Progress sentence and the done screen name the same pace and number.
        const words = paceWords(p.pace);
        expect(planSentence(p, "Monday")).toContain(`about ${p.endShown}% by Monday`);
        expect(planSentence(p, "Monday").toLowerCase()).toContain(words);
        expect(keepWords(p.pace).toLowerCase()).toContain(words);
        if (v.key !== "ready") expect(v.text.toLowerCase()).toContain(words);
      }
    }
    expect([...seenKeys].sort()).toEqual(["not_reachable", "on_track", "reachable", "ready"]);
  });
});

describe("a plan she keeps does not shrink", () => {
  /**
   * Follows the stated plan from the 16th: each morning the screen's plan is read, then
   * exactly the bites it asks for are done, every card recalled (as the projection assumes).
   */
  function follow(start: Deck, target: number, skip: number[] = []) {
    let deck = start;
    const days: { day: number; asked: number; forecast: number; end: number; key: string }[] = [];
    for (let day = 16; day <= 22; day++) {
      deck = { ...deck, now: at(day), newToday: [] };
      const plan = planOf(deck, target);
      const asked = plan.pace.kind === "core" ? plan.pace.bitesToday : plan.pace.perDay;
      const status = verdictOf(Math.round(deckForecast(deck)), target, plan, { day: "Monday" });
      days.push({ day, asked, forecast: deckForecast(deck), end: plan.end, key: status.key });
      if (!skip.includes(day)) deck = doDay(deck, asked);
    }
    return { days, final: deckForecast(deck) };
  }

  it("an unmarked deck at its pace: the projected end holds every day and is where she lands", () => {
    const deck = withSeen(makeDeck(6, 8, 0, at(16)), 10);
    for (const target of [30, 70]) {
      const { days, final } = follow(deck, target);
      for (let i = 1; i < days.length; i++) {
        expect(days[i].end).toBeGreaterThanOrEqual(days[i - 1].end - 0.5);
        expect(days[i].forecast).toBeGreaterThanOrEqual(days[i - 1].forecast - 0.5);
      }
      // The first morning's number is the number she ends on.
      expect(Math.abs(final - days[0].end)).toBeLessThan(0.5);
      expect(Math.round(final)).toBe(Math.round(days[0].end));
    }
  });

  it("a paced deck: the projected end holds, the status stays on track, and she lands on it", () => {
    const { days, final } = follow(makeDeck(40, 10, 5, at(16)), 85);
    expect(days[0].asked).toBe(8);
    for (let i = 1; i < days.length; i++) {
      expect(days[i].end).toBeGreaterThanOrEqual(days[i - 1].end - 0.5);
    }
    expect(days.every((d) => d.key === "on_track" || d.key === "ready")).toBe(true);
    expect(Math.abs(final - days[0].end)).toBeLessThan(0.5);
    expect(final).toBeGreaterThan(85);
  });

  it("skipping two days moves the status to not reachable, with a number that is then true", () => {
    // 200 core cards. She keeps the plan on the 16th and 17th, skips the 18th and 19th.
    const { days, final } = follow(makeDeck(40, 10, 5, at(16)), 95, [18, 19]);
    const by = Object.fromEntries(days.map((d) => [d.day, d]));
    expect(by[16].key).toBe("on_track");
    expect(by[18].key).toBe("on_track");
    // On the cut-off day 120 core cards are left for one day: more than 60 a day cannot be done.
    expect(by[20].key).toBe("not_reachable");
    expect(by[20].end).toBeLessThan(by[16].end - 10);
    expect(by[20].asked).toBe(12);
    // She does what is asked from there: the number shown on the 20th is where she lands.
    expect(Math.abs(final - by[20].end)).toBeLessThan(0.5);
    expect(by[21].end).toBeGreaterThanOrEqual(by[20].end - 0.5);
  });

  it("an unmarked deck: skipping days turns reachable into not reachable", () => {
    const deck = withSeen(makeDeck(6, 8, 0, at(16)), 10);
    const two = simulate(deck, 2)[7];
    const one = simulate(deck, 1)[7];
    const target = Math.round((one + two) / 2);
    const kept = follow(deck, target);
    expect(kept.days[0].key).toBe("reachable");
    expect(kept.days.every((d) => d.key === "reachable" || d.key === "ready" || d.key === "on_track")).toBe(true);
    const skipped = follow(deck, target, [16, 17, 18, 19, 20, 21]);
    expect(skipped.days[0].key).toBe("reachable");
    expect(skipped.days[skipped.days.length - 1].key).toBe("not_reachable");
    expect(Math.round(skipped.final)).toBeLessThan(target);
  });
});

describe("a paced exam's line for today", () => {
  const pace = { open: true, bites: 3, budget: 15, impossible: false };
  const plan = (end: number, target = 85): Plan => ({
    pace: { kind: "core", open: true, perDay: 3, bitesToday: 3 },
    curve: [10, end],
    end,
    endShown: Math.round(end),
    reaches: Math.round(end) >= target,
  });

  it("says on track only when the plan reaches the target", () => {
    expect(todayLine(pace, plan(88), "Monday")).toBe("3 bites today keeps you on track for Monday");
    expect(todayLine(pace, plan(88), "Monday", { more: true })).toBe("3 more bites today keeps you on track for Monday");
    expect(todayLine(pace, plan(62), "Monday")).toBe("3 bites today. The plan gets you to about 62% by Monday");
    expect(todayLine({ ...pace, bites: 1 }, plan(62), "Mon 23 Nov")).toBe("1 bite today. The plan gets you to about 62% by Mon 23 Nov");
  });

  it("says the impossible sentence once, where asked, and never on track then", () => {
    const hard = { open: true, bites: 12, budget: 60, impossible: true };
    expect(todayLine(hard, plan(88), "Monday", { sayImpossible: true })).toBe("There are more cards than days: core cards first, about 60 a day");
    expect(todayLine(hard, plan(88), "Monday")).toBe("12 bites today. The plan gets you to about 88% by Monday");
  });

  it("is nothing when today has no new cards left", () => {
    expect(todayLine({ ...pace, bites: 0 }, plan(88), "Monday")).toBeNull();
    expect(todayLine({ ...pace, open: false }, plan(88), "Monday")).toBeNull();
  });

  it("three bites or fewer keep the bite wording; more than three say the time and keep the count", () => {
    const day = "Mon 23 Nov";
    expect(todayLine({ ...pace, bites: 3 }, plan(88), day, { minutes: 11 })).toBe("3 bites today keeps you on track for Mon 23 Nov");
    expect(todayLine({ ...pace, bites: 4 }, plan(88), day, { minutes: 14 })).toBe("About 14 minutes today keeps you on track for Mon 23 Nov (4 bites)");
    expect(todayLine({ ...pace, bites: 7 }, plan(88), day, { minutes: 25 })).toBe("About 25 minutes today keeps you on track for Mon 23 Nov (7 bites)");
    expect(todayLine({ ...pace, bites: 8 }, plan(88), day, { minutes: 29 })).toBe("About 29 minutes today keeps you on track for Mon 23 Nov (8 bites)");
    expect(todayLine({ ...pace, bites: 8 }, plan(88), day, { minutes: 1 })).toBe("About 1 minute today keeps you on track for Mon 23 Nov (8 bites)");
    // Once something is done today, and when the plan ends below the target.
    expect(todayLine({ ...pace, bites: 5 }, plan(88), day, { minutes: 18, more: true })).toBe("About 18 more minutes today keeps you on track for Mon 23 Nov (5 bites)");
    expect(todayLine({ ...pace, bites: 8 }, plan(62), day, { minutes: 29 })).toBe("About 29 minutes today (8 bites). The plan gets you to about 62% by Mon 23 Nov");
    // Without the minutes the bite wording stays, whatever the count; the impossible sentence is as it was.
    expect(todayLine({ ...pace, bites: 8 }, plan(88), day)).toBe("8 bites today keeps you on track for Mon 23 Nov");
    const hard = { open: true, bites: 12, budget: 60, impossible: true };
    expect(todayLine(hard, plan(88), day, { sayImpossible: true, minutes: 40 })).toBe("There are more cards than days: core cards first, about 60 a day");
    expect(todayLine(hard, plan(88), day, { minutes: 40 })).toBe("About 40 minutes today (12 bites). The plan gets you to about 88% by Mon 23 Nov");
  });

  it("a reviews-only day says its time too when it asks for more than three bites", () => {
    const closed = { open: false, bites: 14, budget: 0, impossible: false };
    expect(todayLine(closed, plan(95), "Mon 23 Nov", { minutes: 41 })).toBe("About 41 minutes of reviews today keeps you on track for Mon 23 Nov (14 bites)");
    expect(todayLine(closed, plan(95), "Mon 23 Nov", { minutes: 17, more: true })).toBe("About 17 more minutes of reviews today keeps you on track for Mon 23 Nov (14 bites)");
    expect(todayLine(closed, plan(62), "Mon 23 Nov", { minutes: 41 })).toBe("About 41 minutes of reviews today (14 bites). The plan gets you to about 62% by Mon 23 Nov");
    // Three bites or fewer: no line, as before.
    expect(todayLine({ ...closed, bites: 3 }, plan(95), "Mon 23 Nov", { minutes: 9 })).toBeNull();
  });

  it("once the important reviews are done it says so, with what the rest is worth, and never 'on track'", () => {
    expect(optionalLine(43, 0.62)).toBe("The important ones are done. 43 more are optional (about +0.6%)");
    expect(optionalLine(1, 0.26)).toBe("The important ones are done. 1 more is optional (about +0.3%)");
    expect(optionalLine(12, 0.96)).toBe("The important ones are done. 12 more are optional (about +1.0%)");
    // A gain that rounds to nothing is not printed as +0.0%.
    expect(optionalLine(5, 0.04)).toBe("The important ones are done. 5 more are optional");
    expect(optionalLine(0, 0.5)).toBeNull();
    expect(optionalLine(43, 0.62)).not.toMatch(/track/i);
  });

  it("the done screen's line says what is left of today, or nothing", () => {
    expect(leftLine(12)).toBe("About 12 minutes of today\u2019s plan left");
    expect(leftLine(1)).toBe("About 1 minute of today\u2019s plan left");
    expect(leftLine(0)).toBeNull();
  });
});
