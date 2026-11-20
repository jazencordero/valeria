import { describe, expect, it } from "vitest";
import {
  aimedDue,
  dueNow,
  finalSlot,
  FINAL_MARGIN_MS,
  FINAL_WINDOW_MS,
  finalPass,
  isLeech,
  reviewShare,
  spreadBacklog,
  wantedRecall,
  type DueCard,
  type PlannedCard,
} from "./exam-aim";
import { grade, GRADES, newCard, recallAt, type Grade, type MemoryState } from "./memory";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-14T13:48:00Z").getTime();

/** Grade a new card through `grades`, one step after each due date. */
function history(grades: Grade[], start = NOW): { state: MemoryState; at: number } {
  let state = newCard(new Date(start));
  let at = start;
  for (const g of grades) {
    at = Math.max(at, state.dueAt);
    state = grade(state, g, new Date(at));
  }
  return { state, at };
}

/** Small deterministic PRNG so the property loop is repeatable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("wantedRecall", () => {
  it("is 0.85 far out and 0.95 in the final 3 days", () => {
    expect(wantedRecall(30)).toBe(0.85);
    expect(wantedRecall(14)).toBeCloseTo(0.85, 10);
    expect(wantedRecall(3)).toBeCloseTo(0.95, 10);
    expect(wantedRecall(0.5)).toBe(0.95);
  });

  it("rises linearly in between", () => {
    expect(wantedRecall(8.5)).toBeCloseTo(0.9, 10);
    expect(wantedRecall(10)).toBeGreaterThan(wantedRecall(12));
  });
});

describe("aimedDue", () => {
  it("never lands after the exam, and only ever pulls earlier", () => {
    const rand = rng(42);
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      const len = 1 + Math.floor(rand() * 8);
      const grades = Array.from({ length: len }, () => GRADES[Math.floor(rand() * 4)]);
      const { state, at } = history(grades);
      const now = at + rand() * 20 * DAY;
      const examAt = now + rand() * 90 * DAY + MIN;
      const due = aimedDue(state, examAt, now);
      if (due === null) continue;
      checked++;
      expect(due).toBeLessThanOrEqual(examAt);
      expect(due).toBeLessThanOrEqual(state.dueAt);
      if (state.dueAt > now) expect(due).toBeGreaterThanOrEqual(now);
    }
    expect(checked).toBeGreaterThan(300);
  });

  it("returns null at and after the exam", () => {
    const { state, at } = history([3, 3, 3]);
    expect(aimedDue(state, at, at)).toBeNull();
    expect(aimedDue(state, at - DAY, at)).toBeNull();
  });

  it("pulls a long interval in to the wanted recall near the exam", () => {
    const { state, at } = history([3, 3, 3]);
    const examAt = at + 12 * DAY;
    expect(state.dueAt).toBeGreaterThan(examAt);
    const due = aimedDue(state, examAt, at)!;
    expect(due).toBeLessThan(examAt - FINAL_MARGIN_MS);
    const want = wantedRecall((examAt - due) / DAY);
    expect(want).toBeGreaterThan(0.9);
    expect(recallAt(state, new Date(due))).toBeCloseTo(want, 3);
  });

  it("a card that holds past the exam gets one review inside the final window", () => {
    const { state, at } = history([3, 3, 4, 4]);
    const examAt = at + 8 * DAY;
    expect(state.dueAt).toBeGreaterThan(examAt);
    const due = aimedDue(state, examAt, at)!;
    expect(due).toBeGreaterThanOrEqual(examAt - FINAL_WINDOW_MS);
    expect(due).toBeLessThanOrEqual(examAt - FINAL_MARGIN_MS);
    expect(due).toBe(finalSlot(state, examAt));
    // The same state gives the same date, whenever it is asked.
    expect(aimedDue(state, examAt, at + 2 * DAY)).toBe(due);
    // Once its slot has passed it is due now.
    expect(aimedDue(state, examAt, due + HOUR)).toBe(due + HOUR);
    expect(dueNow(state, examAt, due + HOUR)).toBe(due + HOUR);
    expect(dueNow(state, examAt, due - HOUR)).toBeNull();
  });

  it("a card already reviewed inside the final window is not scheduled again", () => {
    const { state, at } = history([3, 3, 4, 4]);
    const examAt = at + 2 * DAY;
    expect(state.dueAt).toBeGreaterThan(examAt);
    expect(finalSlot(state, examAt)).toBeNull();
    expect(aimedDue(state, examAt, at)).toBeNull();
    expect(dueNow(state, examAt, examAt - HOUR)).toBeNull();
  });

  it("spreads those last reviews over the final window instead of one evening", () => {
    // 300 cards, each learned at its own moment on days 9 to 6 before the exam and holding past it.
    const examAt = new Date("2026-11-23T07:00:00Z").getTime(); // Monday 09:00 in Helsinki
    const helsinkiDay = (t: number) => new Date(t + 2 * HOUR).toISOString().slice(0, 10);
    const perDay = new Map<string, number>();
    const slots: number[] = [];
    for (let i = 0; i < 300; i++) {
      const start = examAt - 9 * DAY + i * 14 * MIN;
      let state = newCard(new Date(start));
      state = grade(state, 4, new Date(start));
      state = grade(state, 4, new Date(start + 20 * MIN + (i % 7) * 1000));
      expect(state.dueAt).toBeGreaterThan(examAt);
      const due = aimedDue(state, examAt, state.lastReviewAt!)!;
      expect(due).toBeGreaterThanOrEqual(examAt - FINAL_WINDOW_MS);
      expect(due).toBeLessThanOrEqual(examAt - FINAL_MARGIN_MS);
      slots.push(due);
      perDay.set(helsinkiDay(due), (perDay.get(helsinkiDay(due)) ?? 0) + 1);
    }
    // The window runs Friday 09:00 to Sunday 21:00: three calendar days, none with most of the cards.
    expect([...perDay.keys()].sort()).toEqual(["2026-11-20", "2026-11-21", "2026-11-22"]);
    for (const n of perDay.values()) {
      expect(n).toBeGreaterThan(300 * 0.15);
      expect(n).toBeLessThan(300 * 0.5);
    }
    // Not bunched inside a day either: no single hour holds more than a tenth of them.
    const perHour = new Map<number, number>();
    for (const t of slots) perHour.set(Math.floor(t / HOUR), (perHour.get(Math.floor(t / HOUR)) ?? 0) + 1);
    expect(Math.max(...perHour.values())).toBeLessThan(30);
    // Before the change every one of them fell due at this one moment.
    expect(slots.filter((t) => t === examAt - FINAL_MARGIN_MS).length).toBeLessThan(3);
  });

  it("leaves the FSRS due date alone far from the exam", () => {
    const { state, at } = history([3, 3, 3]);
    const examAt = state.dueAt + 60 * DAY;
    expect(aimedDue(state, examAt, at)).toBe(state.dueAt);
  });

  it("clamps a due date past the exam to 12 h before it", () => {
    // Never graded: no recall to aim at, so only the clamp applies.
    const state = { ...newCard(new Date(NOW)), dueAt: NOW + 30 * DAY };
    const examAt = NOW + 10 * DAY;
    expect(aimedDue(state, examAt, NOW)).toBe(examAt - FINAL_MARGIN_MS);
    expect(aimedDue(state, examAt, examAt - 6 * HOUR)).toBeNull();
  });

  it("accepts Dates as well as epoch ms", () => {
    const { state, at } = history([3, 3, 4]);
    const examAt = at + 5 * DAY;
    expect(aimedDue(state, new Date(examAt), new Date(at))).toBe(aimedDue(state, examAt, at));
  });
});

describe("dueNow", () => {
  it("is aimedDue's answer whenever that is now or earlier, and null otherwise", () => {
    const T0 = NOW;
    const exam = T0 + 10 * DAY;
    const states: MemoryState[] = [newCard(new Date(T0))];
    for (const g of [1, 2, 3, 4] as const) {
      let s = grade(newCard(new Date(T0)), g, new Date(T0));
      states.push(s);
      for (let i = 1; i <= 3; i++) {
        s = grade(s, 3, new Date(T0 + i * DAY));
        states.push(s);
      }
    }
    let due = 0;
    for (const s of states) {
      for (const now of [T0, T0 + 5 * 60 * 1000, T0 + DAY, T0 + 4 * DAY, T0 + 8 * DAY, exam - 60 * 1000, exam, exam + DAY]) {
        const aimed = aimedDue(s, exam, now) ?? s.dueAt;
        const expected = aimed <= now ? aimed : null;
        expect(dueNow(s, exam, now)).toBe(expected);
        if (expected !== null) due++;
      }
    }
    expect(due).toBeGreaterThan(20);
  });
});

describe("finalPass", () => {
  const examAt = NOW + 10 * DAY;
  const windowStart = examAt - FINAL_WINDOW_MS;
  // Both graded well before NOW, so exam-day recall is a real forecast.
  const strong = history([3, 3, 4, 4], NOW - 120 * DAY).state;
  const weak = history([3, 3, 1], NOW - 120 * DAY).state;

  it("gives a concept with no card in the last 72 h one card there", () => {
    const cards: PlannedCard[] = [
      { id: "a1", conceptId: "A", state: strong, dueAt: examAt - DAY },
      { id: "b1", conceptId: "B", state: strong, dueAt: examAt + 20 * DAY },
      { id: "b2", conceptId: "B", state: weak, dueAt: null },
      { id: "b3", conceptId: "B", state: weak, dueAt: NOW + DAY },
    ];
    const changes = finalPass(cards, examAt, NOW);
    expect(changes).toHaveLength(1);
    expect(changes[0].id).toBe("b2");
    expect(changes[0].dueAt).toBeGreaterThanOrEqual(windowStart);
    expect(changes[0].dueAt).toBeLessThanOrEqual(examAt);
  });

  it("picks the lowest exam-day recall, ties by id", () => {
    const cards: PlannedCard[] = [
      { id: "c2", conceptId: "C", state: weak, dueAt: null },
      { id: "c1", conceptId: "C", state: weak, dueAt: null },
      { id: "c0", conceptId: "C", state: strong, dueAt: null },
    ];
    expect(finalPass(cards, examAt, NOW)).toEqual([{ id: "c1", dueAt: windowStart }]);
  });

  it("uses a card due before the window when that is all there is", () => {
    const cards: PlannedCard[] = [{ id: "d1", conceptId: "D", state: weak, dueAt: NOW + DAY }];
    expect(finalPass(cards, examAt, NOW)).toEqual([{ id: "d1", dueAt: windowStart }]);
  });

  it("schedules for now once the window has begun, and nothing after the exam", () => {
    const now = examAt - DAY;
    const cards: PlannedCard[] = [{ id: "e1", conceptId: "E", state: weak, dueAt: null }];
    expect(finalPass(cards, examAt, now)).toEqual([{ id: "e1", dueAt: now }]);
    expect(finalPass(cards, examAt, examAt)).toEqual([]);
  });
});

describe("reviewShare", () => {
  it("is two thirds of the pile two days out, all of it on the last day", () => {
    expect(reviewShare(9, 2)).toBe(6);
    expect(reviewShare(10, 2)).toBe(7);
    expect(reviewShare(131, 2)).toBe(88);
    expect(reviewShare(9, 1)).toBe(9);
    // No days left counts as the last day; nothing due asks for nothing.
    expect(reviewShare(9, 0)).toBe(9);
    expect(reviewShare(0, 2)).toBe(0);
    expect(reviewShare(1, 2)).toBe(1);
    expect(reviewShare(8, 3)).toBe(4);
  });

  it("no day asks for more than twice the daily average, each day is lighter than the one before, and nothing is left", () => {
    for (let days = 1; days <= 6; days++) {
      for (const pile of [1, 7, 60, 184, 401]) {
        const perDay: number[] = [];
        let left = pile;
        for (let d = days; d >= 1; d--) {
          const today = reviewShare(left, d);
          perDay.push(today);
          left -= today;
        }
        expect(left).toBe(0);
        // Rounding up may add one card to a day.
        expect(Math.max(...perDay)).toBeLessThanOrEqual(Math.ceil((2 * pile) / days));
        for (let i = 1; i < perDay.length; i++) expect(perDay[i]).toBeLessThanOrEqual(perDay[i - 1]);
        // The day before the exam is the lightest.
        expect(perDay[perDay.length - 1]).toBe(Math.min(...perDay));
      }
    }
  });
});

describe("spreadBacklog", () => {
  const examAt = NOW + 6 * DAY;

  function backlog(n: number): DueCard[] {
    const out: DueCard[] = [];
    for (let i = 0; i < n; i++) {
      const { state } = history(i % 3 === 0 ? [3, 1] : [3, 3, 3], NOW - 30 * DAY);
      out.push({ id: `k${String(i).padStart(2, "0")}`, conceptId: `c${i % 5}`, state });
    }
    return out;
  }

  it("gives 10 or fewer today for 60 overdue with 6 days left", () => {
    const today = spreadBacklog(backlog(60), examAt, NOW, 50);
    expect(today.length).toBeLessThanOrEqual(10);
    expect(today.length).toBe(10);
  });

  it("caps at perDay", () => {
    expect(spreadBacklog(backlog(60), examAt, NOW, 4)).toHaveLength(4);
  });

  it("puts the weakest concept first", () => {
    const weakState = history([3, 1], NOW - 30 * DAY).state;
    const strongState = history([3, 3, 4, 4], NOW - 2 * DAY).state;
    const cards: DueCard[] = [
      { id: "s1", conceptId: "strong", state: strongState },
      { id: "s2", conceptId: "strong", state: strongState },
      { id: "w1", conceptId: "weak", state: weakState },
      { id: "w2", conceptId: "weak", state: weakState },
    ];
    const today = spreadBacklog(cards, NOW + 2 * DAY, NOW, 10);
    expect(today.map((c) => c.id)).toEqual(["w1", "w2"]);
  });

  it("returns nothing at the exam, for an empty list, or with no budget", () => {
    expect(spreadBacklog(backlog(10), NOW, NOW, 10)).toEqual([]);
    expect(spreadBacklog([], examAt, NOW, 10)).toEqual([]);
    expect(spreadBacklog(backlog(10), examAt, NOW, 0)).toEqual([]);
  });
});

describe("isLeech", () => {
  it("is a leech at 4 lapses, not at 3", () => {
    const s = newCard(new Date(NOW));
    expect(isLeech({ ...s, lapses: 3 })).toBe(false);
    expect(isLeech({ ...s, lapses: 4 })).toBe(true);
  });
});
