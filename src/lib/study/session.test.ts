import { describe, expect, it } from "vitest";
import type { Bite, BiteCard, CardType } from "./bite";
import type { Grade } from "./memory";
import {
  biteCards,
  gainFor,
  hint,
  initSession,
  mulberry32,
  progress,
  result,
  step,
  type SessionCard,
  type SessionEvent,
  type SessionMode,
  type SessionState,
} from "./session";

const T0 = 1_000_000;
// Seeds whose first mulberry32 draw lands on each side of 0.5.
const SEED_TWO = 7; // draw < 0.5 -> 2 places later
const SEED_THREE = 1; // draw >= 0.5 -> 3 places later

function card(id: string, type: CardType = "basic", extra: Partial<SessionCard> = {}): SessionCard {
  return { id, type, boss: false, section: "learn", conceptIds: ["c1"], ...extra };
}

function boss(id: string): SessionCard {
  return card(id, "basic", { boss: true, section: "boss" });
}

function start(
  cards: SessionCard[],
  opts: { mode?: SessionMode; seed?: number; masteries?: Record<string, number> } = {},
): SessionState {
  return initSession({
    cards,
    mode: opts.mode ?? "bite",
    seed: opts.seed ?? SEED_TWO,
    at: T0,
    masteries: opts.masteries ?? { c1: 0 },
  });
}

function run(s: SessionState, events: SessionEvent[]): SessionState {
  return events.reduce(step, s);
}

/** Reveal and grade the basic card on screen. */
function rg(s: SessionState, g: Grade, at = s.lastAt + 1000): SessionState {
  return run(s, [{ type: "reveal" }, { type: "grade", g, at }]);
}

const basics = (n: number) => Array.from({ length: n }, (_, i) => card("k" + i));

describe("requeue", () => {
  it("puts a grade-1 card 2 places later with a low draw", () => {
    expect(mulberry32(SEED_TWO)[0]).toBeLessThan(0.5);
    const s = rg(start(basics(6), { seed: SEED_TWO }), 1);
    expect(s.queue).toEqual(["k1", "k2", "k0", "k3", "k4", "k5"]);
    expect(s.lastRequeue).toBe(2);
  });

  it("puts a grade-1 card 3 places later with a high draw", () => {
    expect(mulberry32(SEED_THREE)[0]).toBeGreaterThanOrEqual(0.5);
    const s = rg(start(basics(6), { seed: SEED_THREE }), 1);
    expect(s.queue).toEqual(["k1", "k2", "k3", "k0", "k4", "k5"]);
  });

  it("is deterministic for a seed and advances the rng", () => {
    const a = rg(start(basics(6), { seed: 42 }), 1);
    const b = rg(start(basics(6), { seed: 42 }), 1);
    expect(a.queue).toEqual(b.queue);
    expect(a.rng).not.toBe(42);
  });

  it("never goes after a final boss card", () => {
    const cards = [card("a"), card("b"), boss("z")];
    const s = rg(start(cards, { seed: SEED_THREE }), 1);
    expect(s.queue).toEqual(["b", "a", "z"]);
    expect(s.queue[s.queue.length - 1]).toBe("z");
  });

  it("goes to the end when fewer cards are left", () => {
    const s = rg(start([card("a"), card("b")], { seed: SEED_THREE }), 1);
    expect(s.queue).toEqual(["b", "a"]);
  });

  it("grows the progress total by one", () => {
    let s = start(basics(4));
    expect(progress(s)).toEqual({ done: 0, total: 4 });
    s = rg(s, 1);
    expect(progress(s)).toEqual({ done: 1, total: 5 });
    s = rg(s, 3);
    expect(progress(s)).toEqual({ done: 2, total: 5 });
  });
});

describe("combo and best", () => {
  it("goes up on first-try passes and resets on grade 1", () => {
    let s = start(basics(5));
    s = rg(rg(s, 3), 4);
    expect(s.combo).toBe(2);
    s = rg(s, 1);
    expect(s.combo).toBe(0);
    expect(s.best).toBe(2);
  });

  it("resets on grade 2 and keeps best", () => {
    let s = start(basics(6));
    s = rg(rg(rg(s, 3), 3), 3);
    s = rg(s, 2);
    expect(s.combo).toBe(0);
    s = rg(s, 3);
    expect(s.combo).toBe(1);
    expect(s.best).toBe(3);
  });

  it("a later pass of a requeued card neither raises nor resets it", () => {
    let s = start([card("a"), card("b"), card("c")], { seed: SEED_TWO });
    s = rg(s, 1); // a -> back at index 2: [b, c, a]
    s = rg(rg(s, 3), 3); // b, c
    expect(s.combo).toBe(2);
    expect(s.queue).toEqual(["a"]);
    s = rg(s, 3); // a again, not first try
    expect(s.combo).toBe(2);
    expect(s.firstOk).toBe(2);
    expect(s.over).toBe(true);
  });
});

describe("auto-grades", () => {
  it("quiz: right answer is grade 3", () => {
    let s = start([card("q", "mcq"), card("x")]);
    s = step(s, { type: "pick", option: 1, correct: true });
    expect(s.phase).toBe("fb");
    expect(s.fbGrade).toBe(3);
    s = step(s, { type: "continue", at: T0 + 4000 });
    expect(s.reviews[0]).toEqual({ cardId: "q", grade: 3, firstTry: true, ms: 4000 });
  });

  it("quiz: wrong answer is grade 1 and requeues", () => {
    let s = start([card("q", "mcq"), card("x")]);
    s = step(s, { type: "pick", option: 0, correct: false });
    expect(s.fbGrade).toBe(1);
    s = step(s, { type: "continue", at: T0 + 1000 });
    expect(s.reviews[0].grade).toBe(1);
    expect(s.queue).toEqual(["x", "q"]);
  });

  it("match: 3 with no slips", () => {
    let s = start([card("m", "match", { pairs: 2 }), card("x")]);
    s = step(s, { type: "match", a: "p", b: "p" });
    expect(s.phase).toBe("front");
    s = step(s, { type: "match", a: "p", b: "p" }); // same pair twice does not count
    expect(s.phase).toBe("front");
    s = step(s, { type: "match", a: "q", b: "q" });
    expect(s.phase).toBe("fb");
    expect(s.fbGrade).toBe(3);
  });

  it("match: 2 with slips", () => {
    let s = start([card("m", "match", { pairs: 2 }), card("x")]);
    s = run(s, [
      { type: "match", a: "p", b: "q" },
      { type: "match", a: "p", b: "p" },
      { type: "match", a: "q", b: "q" },
    ]);
    expect(s.fbGrade).toBe(2);
    expect(s.fbSlips).toBe(1);
    s = step(s, { type: "continue", at: T0 + 1000 });
    expect(s.reviews[0].grade).toBe(2);
    expect(s.combo).toBe(0);
  });

  it("explain: check stores the rubric and waits for a self-grade", () => {
    let s = start([card("e", "explain"), card("x")]);
    s = step(s, { type: "check", text: "my answer", rubricResult: [true, false] });
    expect(s.phase).toBe("graded");
    expect(s.rubric).toEqual([true, false]);
    expect(s.text).toBe("my answer");
    expect(step(s, { type: "continue", at: T0 + 1 })).toBe(s); // not auto-graded
    s = step(s, { type: "grade", g: 4, at: T0 + 2000 });
    expect(s.reviews[0].grade).toBe(4);
  });

  it("recall and fill-the-gap: reveal then self-grade; cloze opens each blank", () => {
    let s = start([card("c", "cloze", { blanks: 2 }), card("b")]);
    expect(step(s, { type: "grade", g: 3, at: T0 })).toBe(s); // cannot grade the front
    s = step(s, { type: "reveal" });
    expect(s.phase).toBe("front");
    s = step(s, { type: "reveal" });
    expect(s.phase).toBe("graded");
    s = step(s, { type: "grade", g: 3, at: T0 + 1000 });
    s = step(s, { type: "reveal" });
    expect(s.phase).toBe("graded");
  });

  it("ignores events meant for another card type", () => {
    const s = start([card("b"), card("x")]);
    expect(step(s, { type: "pick", option: 0, correct: true })).toBe(s);
    expect(step(s, { type: "match", a: "p", b: "p" })).toBe(s);
    expect(step(s, { type: "check", text: "", rubricResult: [] })).toBe(s);
  });
});

describe("mastery gain", () => {
  it("uses the prototype's amounts", () => {
    expect(gainFor(3, true, false, "bite")).toBe(0.055);
    expect(gainFor(4, true, true, "bite")).toBe(0.06);
    expect(gainFor(2, false, false, "bite")).toBe(0.015);
    expect(gainFor(3, false, false, "bite")).toBe(0.025);
    expect(gainFor(1, true, false, "bite")).toBe(0);
    expect(gainFor(3, true, false, "concept")).toBe(0.055);
  });

  it("is times 0.6 in tile and extra modes", () => {
    expect(gainFor(3, true, false, "tile")).toBeCloseTo(0.033, 10);
    expect(gainFor(3, true, true, "extra")).toBeCloseTo(0.036, 10);
    const s = rg(start(basics(2), { mode: "tile" }), 3);
    expect(s.mastery.c1).toBeCloseTo(0.033, 10);
  });

  it("caps at 0.97 and moves every concept a boss card touches", () => {
    const cards = [card("a"), boss("z")];
    cards[1] = { ...cards[1], conceptIds: ["c1", "c2"] };
    let s = start(cards, { masteries: { c1: 0.95, c2: 0.2 } });
    s = rg(s, 3);
    expect(s.mastery.c1).toBe(0.97);
    s = rg(s, 3);
    expect(s.mastery.c1).toBe(0.97);
    expect(s.mastery.c2).toBeCloseTo(0.26, 10);
  });
});

describe("result", () => {
  it("has the done-screen shape", () => {
    let s = start([card("a"), card("b")], { masteries: { c1: 0.1, c9: 0.5 } });
    s = rg(s, 3, T0 + 3000);
    s = rg(s, 4, T0 + 7500);
    const r = result(s);
    expect(r).toEqual({
      cards: 2,
      seconds: 7,
      best: 2,
      perfect: true,
      climbs: [{ concept: "c1", from: 0.1, to: expect.closeTo(0.21, 10) }],
      reviews: [
        { cardId: "a", grade: 3, firstTry: true, ms: 3000 },
        { cardId: "b", grade: 4, firstTry: true, ms: 4500 },
      ],
    });
  });

  it("perfect allows one non-first-try pass but no misses", () => {
    let s = start(basics(3));
    s = rg(rg(rg(s, 3), 2), 3);
    expect(result(s).perfect).toBe(true);
    let t = start(basics(3));
    t = rg(rg(rg(t, 2), 2), 3);
    expect(result(t).perfect).toBe(false);
  });

  it("any miss makes it not perfect", () => {
    let s = start(basics(3), { seed: SEED_TWO });
    s = rg(s, 1);
    while (!s.over) s = rg(s, 3);
    const r = result(s);
    expect(r.perfect).toBe(false);
    expect(r.cards).toBe(3);
    expect(r.reviews.filter((x) => x.cardId === "k0").map((x) => x.firstTry)).toEqual([true, false]);
  });
});

describe("stop and keep going", () => {
  it("askStop opens the confirm and freezes card events", () => {
    let s = step(start(basics(2)), { type: "askStop" });
    expect(s.confirm).toBe(true);
    expect(step(s, { type: "reveal" })).toBe(s);
    s = step(s, { type: "keepGoing" });
    expect(s.confirm).toBe(false);
    expect(step(s, { type: "reveal" }).phase).toBe("graded");
  });

  it("stop ends early and the result covers what was done", () => {
    let s = rg(start(basics(4)), 3, T0 + 2000);
    s = run(s, [{ type: "askStop" }, { type: "stop", at: T0 + 9000 }]);
    expect(s.over).toBe(true);
    expect(s.stopped).toBe(true);
    expect(s.phase).toBe("done");
    expect(step(s, { type: "reveal" })).toBe(s);
    const r = result(s);
    expect(r.cards).toBe(1);
    expect(r.seconds).toBe(9);
  });

  it("askStop on a finished session asks the UI to close", () => {
    const s = rg(start(basics(1)), 3);
    expect(s.over).toBe(true);
    const t = step(s, { type: "askStop" });
    expect(t.closed).toBe(true);
    expect(t.confirm).toBe(false);
  });

  it("does not mutate the previous state", () => {
    const s = start(basics(3));
    const snap = JSON.stringify(s);
    rg(s, 1);
    expect(JSON.stringify(s)).toBe(snap);
  });
});

describe("hint", () => {
  const front = (type: CardType) => start([card("x", type), card("y")]);

  it("front of recall and fill-the-gap", () => {
    expect(hint(front("basic"), "four")).toBe("Space to reveal · 1–4 to grade");
    expect(hint(front("cloze"), "two")).toBe("Space to reveal · 1 or 2 to grade");
  });

  it("front of explain", () => {
    expect(hint(front("explain"), "four")).toBe("Write, then check it · 1–4 to grade");
    expect(hint(front("explain"), "two")).toBe("Write, then check it · 1 or 2 to grade");
  });

  it("front of quiz and match", () => {
    expect(hint(front("mcq"), "four")).toBe("1–4 to choose · Enter to continue");
    expect(hint(front("match"), "two")).toBe("Tap to match · Enter to continue");
  });

  it("grade buttons", () => {
    const s = step(front("basic"), { type: "reveal" });
    expect(hint(s, "four")).toBe("1–4 to grade");
    expect(hint(s, "two")).toBe("1 missed · 2 got it");
  });

  it("feedback strip and done", () => {
    const s = step(front("mcq"), { type: "pick", option: 0, correct: true });
    expect(hint(s, "four")).toBe("Enter to continue");
    expect(hint(rg(start(basics(1)), 3), "four")).toBe("");
  });
});

describe("biteCards", () => {
  it("flattens sections in order with their kinds and concepts", () => {
    const deck: BiteCard[] = [
      { id: "w", conceptId: "c1", rung: 1, type: "basic", boss: false, active: true },
      { id: "n", conceptId: "c2", rung: 2, type: "match", boss: false, active: true },
      { id: "z", conceptId: "c1", conceptIds: ["c1", "c2"], rung: 5, type: "explain", boss: true, active: true },
    ];
    const bite: Bite = { sections: [["warm", ["w"]], ["learn", ["n", "gone"]], ["boss", ["z"]]], minutes: 2, gainEstimate: 2 };
    expect(biteCards(bite, deck, { n: { pairs: 4 } })).toEqual([
      { id: "w", type: "basic", boss: false, section: "warm", conceptIds: ["c1"] },
      { id: "n", type: "match", boss: false, section: "learn", conceptIds: ["c2"], pairs: 4 },
      { id: "z", type: "explain", boss: true, section: "boss", conceptIds: ["c1", "c2"] },
    ]);
  });
});
