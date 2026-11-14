import { describe, expect, it } from "vitest";
import {
  BITE_MAX,
  BITE_MIN,
  buildBite,
  conceptSession,
  extraSession,
  tileSession,
  type Bite,
  type BiteCard,
  type BiteConcept,
  type CardType,
  type Deck,
} from "./bite";
import { grade, newCard, type MemoryState } from "./memory";

const NOW = new Date("2026-11-14T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const EXAM = new Date(NOW.getTime() + 10 * DAY);
const TYPES: CardType[] = ["basic", "cloze", "explain", "mcq", "match"];

/** Graded once, `daysAgo` days ago: due 10 minutes after that, so overdue now. */
function reviewed(daysAgo: number): MemoryState {
  const t = new Date(NOW.getTime() - daysAgo * DAY);
  return grade(newCard(t), 3, t);
}

/**
 * A deck of `n` cards over `k` concepts. Every 7th card is a boss card
 * mixing its concept and the next. The first `due` non-boss cards were
 * reviewed (most overdue first: card 0 is the oldest).
 */
function makeDeck(n: number, k: number, due: number): Deck {
  const concepts: BiteConcept[] = Array.from({ length: k }, (_, i) => ({
    id: `c${i}`,
    weight: 1,
    order: i,
  }));
  const cards: BiteCard[] = [];
  const states: Record<string, MemoryState> = {};
  let reviews = 0;
  for (let i = 0; i < n; i++) {
    const boss = i % 7 === 6;
    const conceptId = `c${i % k}`;
    cards.push({
      id: `k${i}`,
      conceptId,
      conceptIds: boss ? [conceptId, `c${(i + 1) % k}`] : undefined,
      rung: ((i % 5) + 1) as BiteCard["rung"],
      type: TYPES[i % TYPES.length],
      boss,
      active: true,
    });
    if (!boss && reviews < due) {
      states[`k${i}`] = reviewed(30 - reviews);
      reviews++;
    }
  }
  return { cards, states, concepts, examAt: EXAM, now: NOW };
}

const ids = (b: Bite) => b.sections.flatMap(([, s]) => s);
const section = (b: Bite, kind: string) =>
  b.sections.find(([k]) => k === kind)?.[1] ?? [];

function expectLimits(b: Bite) {
  const all = ids(b);
  expect(new Set(all).size).toBe(all.length);
  expect(section(b, "warm").length).toBeLessThanOrEqual(4);
  expect(section(b, "learn").length).toBeLessThanOrEqual(5);
  expect(section(b, "boss").length).toBeLessThanOrEqual(1);
  expect(all.length).toBeLessThanOrEqual(BITE_MAX);
  expect(b.minutes).toBe(Math.max(2, Math.round(all.length * 0.6)));
  expect(b.gainEstimate).toBe(Math.max(2, Math.round(all.length * 0.85)));
}

describe("buildBite size limits", () => {
  it("a 3-card deck gives a short bite with every card at most once", () => {
    const deck = makeDeck(3, 2, 1);
    const b = buildBite({ ...deck, kind: "exam", bitesDoneToday: 0 })!;
    expectLimits(b);
    expect(ids(b).length).toBeLessThanOrEqual(3);
    expect(ids(b).length).toBeGreaterThan(0);
  });

  it("a 13-card deck fills 8 to 12 cards with warm, learn and boss", () => {
    const deck = makeDeck(13, 3, 5);
    const b = buildBite({ ...deck, kind: "exam", bitesDoneToday: 0 })!;
    expectLimits(b);
    expect(ids(b).length).toBeGreaterThanOrEqual(BITE_MIN);
    expect(section(b, "warm").length).toBeGreaterThanOrEqual(2);
    expect(section(b, "learn").length).toBeGreaterThanOrEqual(3);
    expect(section(b, "boss")).toHaveLength(1);
    expect(b.sections.map(([k]) => k)).toEqual(["warm", "learn", "boss"]);
  });

  it("a 200-card deck fills 8 to 12 cards", () => {
    const deck = makeDeck(200, 8, 40);
    const b = buildBite({ ...deck, kind: "quiz", bitesDoneToday: 0 })!;
    expectLimits(b);
    expect(ids(b).length).toBeGreaterThanOrEqual(BITE_MIN);
    expect(section(b, "warm")).toHaveLength(4);
    expect(section(b, "learn").length).toBeGreaterThanOrEqual(3);
  });

  it("never puts boss or inactive cards in warm or learn", () => {
    const deck = makeDeck(40, 4, 10);
    const cards = deck.cards.map((c, i) =>
      i % 3 === 0 ? { ...c, active: false } : c,
    );
    const b = buildBite({ ...deck, cards, kind: "exam", bitesDoneToday: 0 })!;
    const byId = new Map(cards.map((c) => [c.id, c]));
    for (const id of [...section(b, "warm"), ...section(b, "learn")]) {
      expect(byId.get(id)!.boss).toBe(false);
      expect(byId.get(id)!.active).toBe(true);
    }
    expectLimits(b);
  });
});

describe("buildBite plan done", () => {
  const deck = makeDeck(13, 3, 5);
  it("an exam has two bites a day", () => {
    expect(
      buildBite({ ...deck, kind: "exam", bitesDoneToday: 1 }),
    ).not.toBeNull();
    expect(buildBite({ ...deck, kind: "exam", bitesDoneToday: 2 })).toBeNull();
  });
  it("a quiz has one bite a day", () => {
    expect(
      buildBite({ ...deck, kind: "quiz", bitesDoneToday: 0 }),
    ).not.toBeNull();
    expect(buildBite({ ...deck, kind: "quiz", bitesDoneToday: 1 })).toBeNull();
  });
  it("an empty deck gives no bite", () => {
    expect(
      buildBite({ ...makeDeck(0, 1, 0), kind: "exam", bitesDoneToday: 0 }),
    ).toBeNull();
  });
});

describe("buildBite order", () => {
  it("warm takes the most overdue reviews first", () => {
    const deck = makeDeck(20, 2, 6);
    // Shuffle the deck order so order cannot come from deck position.
    const cards = [...deck.cards].reverse();
    const b = buildBite({ ...deck, cards, kind: "exam", bitesDoneToday: 0 })!;
    // k0 was reviewed 30 days ago, k1 29, k2 28, k3 27 (none are boss).
    expect(section(b, "warm")).toEqual(["k0", "k1", "k2", "k3"]);
  });

  it("learn starts with the focus concept at its lowest unpassed rung", () => {
    const concepts: BiteConcept[] = [
      { id: "small", weight: 1, order: 0 },
      { id: "big", weight: 5, order: 1 },
    ];
    const card = (
      id: string,
      conceptId: string,
      rung: BiteCard["rung"],
    ): BiteCard => ({
      id,
      conceptId,
      rung,
      type: "basic",
      boss: false,
      active: true,
    });
    const cards = [
      card("s1", "small", 1),
      card("b3", "big", 3),
      card("b1", "big", 1),
      card("b2", "big", 2),
      card("s2", "small", 2),
    ];
    const b = buildBite({
      cards,
      states: {},
      concepts,
      examAt: EXAM,
      now: NOW,
      kind: "exam",
      bitesDoneToday: 0,
    })!;
    // Nothing studied: mastery 0, rung 0, so rung 1 and up, lowest first.
    expect(section(b, "learn")).toEqual(["b1", "b2", "b3", "s1", "s2"]);
  });

  it("is deterministic", () => {
    const deck = makeDeck(60, 5, 12);
    const a = buildBite({ ...deck, kind: "exam", bitesDoneToday: 0 });
    const b = buildBite({ ...deck, kind: "exam", bitesDoneToday: 0 });
    expect(a).toEqual(b);
  });
});

describe("tileSession", () => {
  it("gives 3 non-boss cards of one type", () => {
    const deck = makeDeck(200, 8, 0);
    // Every type also has boss cards in this deck (i % 7 === 6 hits all of i % 5).
    for (const type of TYPES) {
      const s = tileSession(deck, type)!;
      const got = ids(s);
      expect(got).toHaveLength(3);
      for (const id of got) {
        const c = deck.cards.find((k) => k.id === id)!;
        expect(c.type).toBe(type);
        expect(c.boss).toBe(false);
      }
      expect(s.sections.map(([k]) => k)).toEqual(["learn"]);
    }
  });
  it("is null when the deck has none of that type", () => {
    expect(tileSession(makeDeck(3, 1, 0), "match")).toBeNull();
  });
});

describe("conceptSession", () => {
  it("gives up to 4 cards touching the concept, boss in boss", () => {
    const deck = makeDeck(60, 3, 0);
    const s = conceptSession(deck, "c0")!;
    const got = ids(s);
    expect(got.length).toBeLessThanOrEqual(4);
    expect(new Set(got).size).toBe(got.length);
    for (const id of got) {
      const c = deck.cards.find((k) => k.id === id)!;
      expect(c.conceptIds ?? [c.conceptId]).toContain("c0");
    }
    for (const id of section(s, "boss")) {
      expect(deck.cards.find((k) => k.id === id)!.boss).toBe(true);
    }
  });
});

describe("extraSession", () => {
  it("gives 5 available non-boss cards in deck order", () => {
    const deck = makeDeck(30, 3, 0);
    const s = extraSession(deck)!;
    expect(section(s, "warm")).toEqual(["k0", "k1", "k2", "k3", "k4"]);
  });
  it("falls back to 4 non-boss cards when none is available", () => {
    const deck = makeDeck(10, 2, 0);
    const later = new Date(NOW.getTime() - 60 * 1000);
    const states = Object.fromEntries(
      deck.cards.map((c) => [c.id, grade(newCard(later), 4, later)]),
    );
    const s = extraSession({ ...deck, states })!;
    expect(section(s, "warm")).toEqual(["k0", "k1", "k2", "k3"]);
  });
});
