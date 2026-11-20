// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { cardConcepts, cards, cardStates, concepts, exams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import type { Grade } from "@/lib/study/memory";

// The actions read the user from the session cookie and use the app's `db`.
// Both are swapped for the test's: `signedIn.userId` is who the cookie says,
// and `db` forwards to this test's PGlite.
const signedIn = vi.hoisted(() => ({ userId: "", db: null as unknown as Record<string | symbol, unknown> }));

vi.mock("@/server/auth/session", () => ({
  currentUser: async () => {
    if (!signedIn.userId) throw new Error("NotSignedIn");
    return { id: signedIn.userId };
  },
}));

vi.mock("@/server/db/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db/client")>();
  const db = new Proxy(
    {},
    {
      get(_, key) {
        const v = signedIn.db[key];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(signedIn.db) : v;
      },
    },
  );
  return { ...real, db };
});

// Home's one-time greeting cookie (M4-15): recorded instead of written.
const flashes = vi.hoisted(() => [] as unknown[][]);
vi.mock("@/server/data/flash", () => ({
  setFlash: async (...args: unknown[]) => {
    flashes.push(args);
  },
}));

const { beginSession, endSession, examView, saveProgress, setGradeMode } = await import("./actions");
const { StudyNotFound } = await import("./store");

const DB_TIMEOUT = 30_000;
const MIN = 60 * 1000;
const D = 24 * 60 * MIN;
// Saturday 14 Nov 2026, 12:00 in Helsinki.
const NOW = new Date("2026-11-14T10:00:00Z");

let t: TestDb;
let her: string;
let other: string;
let examId: string;
let theirExamId: string;
let clock = NOW.getTime();

function setNow(ms: number) {
  clock = ms;
  vi.setSystemTime(new Date(ms));
}

async function makeUser(): Promise<string> {
  const [u] = await t.db.insert(users).values({ settings: { theme: "calm" } }).returning();
  return u.id;
}

/** An exam 20 days out with 3 concepts, 4 cards each, and one boss card on two concepts. */
async function seedDeck(userId: string, moodleId: number): Promise<string> {
  const [course] = await t.db.insert(courses).values({ userId, moodleId, name: `Course ${moodleId}` }).returning();
  const [exam] = await t.db
    .insert(exams)
    .values({ userId, courseId: course.id, title: "Final", kind: "exam", at: new Date(NOW.getTime() + 20 * D) })
    .returning();
  const made = await t.db
    .insert(concepts)
    .values([1, 2, 3].map((p) => ({ userId, examId: exam.id, name: `Concept ${p}`, position: p, weight: 1 })))
    .returning();
  for (const [i, concept] of made.entries()) {
    for (let k = 0; k < 4; k++) {
      const [card] = await t.db
        .insert(cards)
        .values({
          userId,
          examId: exam.id,
          type: "basic",
          rung: 1 + (k % 3),
          body: { front: `Q${i}.${k}`, back: "A" },
          origin: "manual",
          contentHash: `${userId}-${i}-${k}`,
        })
        .returning();
      await t.db.insert(cardConcepts).values({ cardId: card.id, conceptId: concept.id });
    }
  }
  const [boss] = await t.db
    .insert(cards)
    .values({ userId, examId: exam.id, type: "explain", rung: 5, boss: true, body: { front: "Boss" }, origin: "manual", contentHash: `${userId}-boss` })
    .returning();
  await t.db.insert(cardConcepts).values([
    { cardId: boss.id, conceptId: made[0].id },
    { cardId: boss.id, conceptId: made[1].id },
  ]);
  return exam.id;
}

/** Plays a whole session, one save per card as the screen does; returns the done screen. */
async function play(sessionCards: { id: string }[], sessionId: string, grade: (i: number) => Grade = () => 3) {
  for (const [i, c] of sessionCards.entries()) {
    setNow(clock + 20_000);
    const saved = await saveProgress(sessionId, [{ cardId: c.id, grade: grade(i), firstTry: true, ms: 20_000, at: new Date(clock) }]);
    expect(saved.stored).toBe(1);
  }
  return endSession(sessionId);
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setNow(NOW.getTime());
  t = await createTestDb();
  signedIn.db = t.db as unknown as Record<string | symbol, unknown>;
  her = await makeUser();
  other = await makeUser();
  examId = await seedDeck(her, 1);
  theirExamId = await seedDeck(other, 1);
  signedIn.userId = her;
}, DB_TIMEOUT);

afterEach(async () => {
  vi.useRealTimers();
  await t.close();
}, DB_TIMEOUT);

describe("a day of bites", () => {
  it("a full bite raises the forecast; the second bite is offered, the third is not", async () => {
    const start = await examView(examId);
    expect(start.forecast).toBe(0);
    expect(start.daysLeft).toBe(20);
    expect(start.concepts).toHaveLength(3);
    expect(start.focusConcept?.name).toBe("Concept 1");
    expect(start.bite).not.toBeNull();
    expect(start.bitesPerDay).toBe(2);
    expect(start.gradeMode).toBe("two");
    expect(start.counts.new).toBe(13);

    // The plan: one value a day from today to exam day, ending where the verdict and the plan line say.
    expect(start.plan.curve).toHaveLength(21);
    expect(start.plan.curve[0]).toBe(0);
    expect(start.planEnd).toBe(start.plan.curve[20]);
    expect(start.plan.pace).toEqual({ kind: "bites", perDay: 1 });
    expect(start.plan.reaches).toBe(Math.round(start.planEnd) >= start.exam.targetPct);
    expect(start.plan.endShown).toBe(Math.round(start.planEnd));
    // 13 cards, a bite a day for 20 days: the target is reached, and the status says so.
    expect(start.verdict).toMatchObject({ key: "on_track", text: "On track with a bite a day" });

    const first = await beginSession(examId, "bite");
    expect(first).not.toBeNull();
    expect(first!.cards.length).toBe(start.bite!.cards);
    // The gain shown is the forecast if every card is recalled, minus the forecast now.
    expect(first!.gain).toBe(start.bite!.gain);
    expect(first!.gain).toBeGreaterThan(0);
    expect(first!.cards[0].body).toMatchObject({ back: "A" });
    // A new card: Missed comes back in a minute, Got it in ten.
    expect(first!.cards[0].intervals[1].ms).toBe(MIN);
    expect(first!.cards[0].intervals[3].ms).toBe(10 * MIN);

    flashes.length = 0;
    const done1 = await play(first!.cards, first!.sessionId);
    // Ending a session leaves Home a one-time "Nice. ... up to N%" greeting.
    expect(flashes).toEqual([["studied", { examId, forecast: done1.forecastAfterShown }]]);
    expect(done1.forecastAfter).toBeGreaterThan(done1.forecastBefore);
    expect(done1.forecastBefore).toBe(0);
    // She recalled every card: the forecast moved by the gain the bite showed.
    expect(done1.forecastAfter - done1.forecastBefore).toBeCloseTo(first!.gain, 1);
    // The done screen's sentence is the plan after this session.
    expect(done1.planLead).toBe("Keep a bite a day");
    expect(done1.planEnd).toBe(Math.round((await examView(examId)).planEnd));
    expect(done1.stats).toMatchObject({ cards: first!.cards.length, missed: 0, perfect: true, best: first!.cards.length });
    expect(done1.moved.length).toBeGreaterThan(0);
    expect(done1.week.days.find((d) => d.isToday)?.state).toBe("done");
    expect(done1.bitesDoneToday).toBe(1);
    expect(done1.anotherBite).toBe(true);

    const mid = await examView(examId);
    expect(mid.forecast).toBeGreaterThan(start.forecast);
    expect(mid.forecast).toBeCloseTo(done1.forecastAfter);
    expect(mid.bite).not.toBeNull();
    expect(mid.last14[13].count).toBe(first!.cards.length);

    const second = await beginSession(examId, "bite");
    expect(second).not.toBeNull();
    const done2 = await play(second!.cards, second!.sessionId);
    expect(done2.forecastAfter).toBeGreaterThan(done2.forecastBefore);
    expect(done2.bitesDoneToday).toBe(2);
    expect(done2.anotherBite).toBe(false);

    const after = await examView(examId);
    expect(after.bite).toBeNull();
    expect(await beginSession(examId, "bite")).toBeNull();
    // Extra practice is still there once the plan is done.
    expect(await beginSession(examId, "extra")).not.toBeNull();
  }, DB_TIMEOUT);

  it("ending a session twice keeps one finished bite", async () => {
    const s = await beginSession(examId, "bite");
    await play(s!.cards.slice(0, 2), s!.sessionId);
    const again = await endSession(s!.sessionId);
    expect(again.bitesDoneToday).toBe(1);
    expect(again.stats.cards).toBe(2);
  }, DB_TIMEOUT);

  it("history comes from yesterday's reviews", async () => {
    setNow(NOW.getTime() - D);
    const s = await beginSession(examId, "bite");
    await play(s!.cards, s!.sessionId);
    setNow(NOW.getTime());
    const view = await examView(examId);
    expect(view.history).toHaveLength(1);
    expect(view.history[0]).toBeCloseTo(view.forecast);
    expect(view.bitesDoneToday).toBe(0);
  }, DB_TIMEOUT);
});

describe("saveProgress", () => {
  it("a missed card is due within a minute", async () => {
    const s = await beginSession(examId, "bite");
    const card = s!.cards[0];
    const at = new Date(clock + 5000);
    setNow(at.getTime());
    const saved = await saveProgress(s!.sessionId, [{ cardId: card.id, grade: 1, firstTry: true, ms: 5000, at }]);
    expect(saved.stored).toBe(1);
    expect(saved.due[0].cardId).toBe(card.id);
    expect(saved.due[0].dueAt.getTime() - at.getTime()).toBeLessThanOrEqual(MIN);
    const [row] = await t.db.select().from(cardStates).where(eq(cardStates.cardId, card.id));
    expect(row.dueAt.getTime() - at.getTime()).toBeLessThanOrEqual(MIN);
    expect(row.dueAt.getTime()).toBeGreaterThan(at.getTime());
  }, DB_TIMEOUT);

  it("is safe to send twice and aims due dates at the exam", async () => {
    const s = await beginSession(examId, "bite");
    const card = s!.cards[0];
    const batch = [{ cardId: card.id, grade: 3 as Grade, firstTry: true, ms: 3000, at: new Date(clock + 3000) }];
    const once = await saveProgress(s!.sessionId, batch);
    const twice = await saveProgress(s!.sessionId, batch);
    expect(once.stored).toBe(1);
    expect(twice).toMatchObject({ stored: 0, skipped: 1 });
    expect(twice.due).toEqual(once.due);

    // A long interval is pulled to before the exam.
    const exam = await t.db.select().from(exams).where(eq(exams.id, examId));
    setNow(clock + 11 * MIN);
    const easy = [{ cardId: card.id, grade: 4 as Grade, firstTry: false, ms: 2000, at: new Date(clock) }];
    const saved = await saveProgress(s!.sessionId, easy);
    expect(saved.due[0].dueAt.getTime()).toBeLessThan(exam[0].at.getTime());
  }, DB_TIMEOUT);
});

describe("other users and settings", () => {
  it("refuses another user's exam and session", async () => {
    expect(await caught(examView(theirExamId))).toBeInstanceOf(StudyNotFound);
    expect(await caught(beginSession(theirExamId, "bite"))).toBeInstanceOf(StudyNotFound);
    expect(await caught(examView("not-a-uuid"))).toBeInstanceOf(StudyNotFound);

    signedIn.userId = other;
    const theirs = await beginSession(theirExamId, "bite");
    signedIn.userId = her;
    const card = theirs!.cards[0].id;
    expect(
      await caught(saveProgress(theirs!.sessionId, [{ cardId: card, grade: 3, firstTry: true, ms: 1, at: new Date(clock) }])),
    ).toBeInstanceOf(StudyNotFound);
    expect(await caught(endSession(theirs!.sessionId))).toBeInstanceOf(StudyNotFound);

    // Her session cannot take their card either.
    const mine = await beginSession(examId, "bite");
    expect(
      await caught(saveProgress(mine!.sessionId, [{ cardId: card, grade: 3, firstTry: true, ms: 1, at: new Date(clock) }])),
    ).toBeInstanceOf(StudyNotFound);

    signedIn.userId = "";
    expect(await caught(examView(examId))).toBeInstanceOf(Error);
  }, DB_TIMEOUT);

  it("setGradeMode persists and keeps other settings", async () => {
    expect(await setGradeMode("anki")).toBe("anki");
    expect((await examView(examId)).gradeMode).toBe("anki");
    const s = await beginSession(examId, "bite");
    expect(s!.gradeMode).toBe("anki");
    const [row] = await t.db.select().from(users).where(eq(users.id, her));
    expect(row.settings).toEqual({ theme: "calm", gradeMode: "anki" });
    const [theirs] = await t.db.select().from(users).where(eq(users.id, other));
    expect(theirs.settings).toEqual({ theme: "calm" });

    await setGradeMode("two");
    expect((await examView(examId)).gradeMode).toBe("two");
    expect(await caught(setGradeMode("four" as never))).toBeInstanceOf(Error);
  }, DB_TIMEOUT);

  it("starts tile and concept sessions", async () => {
    const view = await examView(examId);
    const tile = await beginSession(examId, "tile", "basic");
    expect(tile!.cards.every((c) => c.type === "basic")).toBe(true);
    expect(await beginSession(examId, "tile", "mcq")).toBeNull();
    const concept = await beginSession(examId, "concept", view.concepts[1].id);
    expect(concept!.cards.every((c) => c.conceptIds.includes(view.concepts[1].id))).toBe(true);
    expect(await caught(beginSession(examId, "tile", "nope"))).toBeInstanceOf(Error);
    expect(await caught(beginSession(examId, "nope" as never))).toBeInstanceOf(Error);
  }, DB_TIMEOUT);
});

describe("a seeded deck (M3-52)", () => {
  it("a card with first: true in its body opens the first bite", async () => {
    const [course] = await t.db.insert(courses).values({ userId: her, moodleId: 7, name: "Seeded" }).returning();
    const [exam] = await t.db
      .insert(exams)
      .values({ userId: her, courseId: course.id, title: "Seeded final", kind: "exam", at: new Date(NOW.getTime() + 20 * D) })
      .returning();
    // The heavier concept is later in the course, and the opening card is at rung 3:
    // without core/first the bite would start with a rung-1 card of the heavy concept.
    const [intro, heavy] = await t.db
      .insert(concepts)
      .values([
        { userId: her, examId: exam.id, name: "Intro", position: 1, weight: 1 },
        { userId: her, examId: exam.id, name: "Heavy", position: 2, weight: 5 },
      ])
      .returning();
    const seeded = [
      { concept: heavy, rung: 1, body: { q: "Heavy?", a: "A", core: true, first: false } },
      { concept: intro, rung: 1, body: { q: "Intro 1?", a: "A", core: false, first: false } },
      { concept: intro, rung: 3, body: { q: "Intro opens?", a: "A", core: true, first: true } },
      { concept: intro, rung: 2, body: { q: "Intro 2?", a: "A" } },
    ];
    for (const [i, s] of seeded.entries()) {
      const [card] = await t.db
        .insert(cards)
        .values({ userId: her, examId: exam.id, type: "basic", rung: s.rung, body: s.body, origin: "manual", contentHash: `seeded-${i}` })
        .returning();
      await t.db.insert(cardConcepts).values({ cardId: card.id, conceptId: s.concept.id });
    }

    const bite = await beginSession(exam.id, "bite");
    expect(bite!.cards[0].body).toMatchObject({ q: "Intro opens?", first: true, core: true });
    // Core marks make it a paced deck: both core cards (study order) before the others.
    expect(bite!.cards.map((c) => (c.body as { q: string }).q)).toEqual(["Intro opens?", "Heavy?", "Intro 1?", "Intro 2?"]);
    const view = await examView(exam.id);
    expect(view.pace).toMatchObject({ open: true, budget: 7, left: 4, bites: 1, impossible: false, done: false });
    // A deck without core marks has no pace.
    expect((await examView(examId)).pace).toBeUndefined();
  }, DB_TIMEOUT);
});

describe("a paced exam (core marks)", () => {
  /** An exam 7 days out (5 days to its cut-off) with one concept of 60 core cards and 6 others. */
  async function seedPaced(): Promise<{ examId: string; core: string[]; plain: string[] }> {
    const [course] = await t.db.insert(courses).values({ userId: her, moodleId: 11, name: "Paced" }).returning();
    const [exam] = await t.db
      .insert(exams)
      .values({ userId: her, courseId: course.id, title: "Paced final", kind: "exam", at: new Date(NOW.getTime() + 7 * D) })
      .returning();
    const [concept] = await t.db.insert(concepts).values({ userId: her, examId: exam.id, name: "Paced concept", position: 1, weight: 1 }).returning();
    const core: string[] = [];
    const plain: string[] = [];
    // The other cards come first in the deck: the plan still starts with the core ones.
    for (let k = 0; k < 66; k++) {
      const isCore = k >= 6;
      const [card] = await t.db
        .insert(cards)
        .values({ userId: her, examId: exam.id, type: "basic", rung: 1, body: { q: `Paced ${k}?`, a: "A", core: isCore }, origin: "manual", contentHash: `paced-${k}`, createdAt: new Date(NOW.getTime() - D + k * 1000) })
        .returning();
      await t.db.insert(cardConcepts).values({ cardId: card.id, conceptId: concept.id });
      (isCore ? core : plain).push(card.id);
    }
    return { examId: exam.id, core, plain };
  }

  it("serves today's budget in as many bites as it takes, then is done; extra goes on with the next core cards", async () => {
    const paced = await seedPaced();
    const start = await examView(paced.examId);
    // 60 core cards over 5 days: 12 a day, in 3 bites of up to 5 new cards.
    expect(start.pace).toMatchObject({ open: true, budget: 12, left: 12, bites: 3, impossible: false, done: false, long: false });
    // An exam within 14 days: the week's goal is every day until it (Saturday and Sunday are left this week).
    expect(start.week.goal).toBe(2);
    expect((await examView(examId)).week.goal).toBe(4); // her other exam is 20 days out
    // No week in a row yet: no streak line.
    expect(start.week.streakLine).toBe("");
    // One plan for every screen: the core-first pace, its projection, and a verdict that agrees with it.
    expect(start.plan.pace).toEqual({ kind: "core", open: true, perDay: 3, bitesToday: 3 });
    expect(start.plan.curve).toHaveLength(8);
    expect(start.planEnd).toBe(start.plan.curve[7]);
    // Readiness is measured on the 60 core cards, and the plan shows them all by the cut-off.
    expect(start.plan.endShown).toBeGreaterThan(80);
    expect(start.verdict).toMatchObject({ key: "on_track", text: "On track with 3 bites a day", ok: true });

    const served: string[] = [];
    for (const [i, left] of [7, 2, 0].entries()) {
      const bite = await beginSession(paced.examId, "bite");
      expect(bite).not.toBeNull();
      const done = await play(bite!.cards, bite!.sessionId);
      served.push(...bite!.cards.map((c) => c.id));
      expect(done.bitesDoneToday).toBe(i + 1);
      // The third bite is offered although an exam otherwise has two a day.
      expect(done.anotherBite).toBe(left > 0);
      expect((await examView(paced.examId)).pace).toMatchObject({ budget: 12, left, bites: Math.ceil(left / 5) });
    }
    expect(served).toEqual(paced.core.slice(0, 12));

    // The budget is used and nothing is due yet: today's bites are done.
    const after = await examView(paced.examId);
    expect(after.bite).toBeNull();
    expect(after.pace).toMatchObject({ left: 0, bites: 0, done: true });
    expect(await beginSession(paced.examId, "bite")).toBeNull();

    // Extra: the next unseen core cards, in order, with no cap.
    for (const from of [12, 17]) {
      const extra = await beginSession(paced.examId, "extra");
      expect(extra!.cards.map((c) => c.id)).toEqual(paced.core.slice(from, from + 5));
      await play(extra!.cards, extra!.sessionId);
    }

    // Tomorrow the budget is worked out again from what is still unseen: 38 over 4 days.
    setNow(NOW.getTime() + D);
    expect((await examView(paced.examId)).pace).toMatchObject({ budget: 10, left: 10, bites: 2, done: false });
  }, DB_TIMEOUT);

  it("serves no new card after the cut-off, the day before the exam or on exam day", async () => {
    const paced = await seedPaced();
    const first = await beginSession(paced.examId, "bite");
    await play(first!.cards, first!.sessionId);
    const met = new Set(first!.cards.map((c) => c.id));

    // The cut-off day (three days before the exam): new cards still come.
    setNow(NOW.getTime() + 4 * D);
    const cutoff = await examView(paced.examId);
    expect(cutoff.daysLeft).toBe(3);
    expect(cutoff.pace).toMatchObject({ open: true, budget: 55 });

    for (const daysOn of [5, 6, 7]) {
      setNow(NOW.getTime() + daysOn * D - 3 * 60 * MIN);
      const view = await examView(paced.examId);
      expect(view.daysLeft).toBe(7 - daysOn);
      // Reviews only: what is asked is the bites that clear what is due (one here: five cards).
      expect(view.pace).toMatchObject({ open: false, budget: 0, left: 0 });
      expect(view.pace!.bites).toBeLessThanOrEqual(1);
      expect(view.plan.pace).toMatchObject({ kind: "core", open: false });
      for (const kind of ["bite", "extra", "tile", "concept"] as const) {
        const arg = kind === "tile" ? "basic" : kind === "concept" ? view.concepts[0].id : undefined;
        const s = await beginSession(paced.examId, kind, arg);
        expect(s).not.toBeNull();
        expect(s!.cards.every((c) => met.has(c.id))).toBe(true);
      }
    }
  }, DB_TIMEOUT);
});

describe("a paced exam: minutes and one go", () => {
  /** 300 core cards in one concept, the exam 7 days out: 60 new cards a day, 12 bites. */
  async function seedBig(): Promise<{ examId: string; order: string[] }> {
    const [course] = await t.db.insert(courses).values({ userId: her, moodleId: 13, name: "Big" }).returning();
    const [exam] = await t.db
      .insert(exams)
      .values({ userId: her, courseId: course.id, title: "Big final", kind: "exam", at: new Date(NOW.getTime() + 7 * D) })
      .returning();
    const [concept] = await t.db.insert(concepts).values({ userId: her, examId: exam.id, name: "Big concept", position: 1, weight: 1 }).returning();
    const made = await t.db
      .insert(cards)
      .values(
        Array.from({ length: 300 }, (_, k) => ({
          userId: her,
          examId: exam.id,
          type: "basic" as const,
          rung: 1,
          body: { q: `Big ${k}?`, a: "A", core: true },
          origin: "manual" as const,
          contentHash: `big-${k}`,
          createdAt: new Date(NOW.getTime() - D + k * 1000),
        })),
      )
      .returning();
    await t.db.insert(cardConcepts).values(made.map((c) => ({ cardId: c.id, conceptId: concept.id })));
    return { examId: exam.id, order: made.map((c) => c.id) };
  }

  it("says today's plan in minutes, starts it in one go, and counts a stopped session", async () => {
    const big = await seedBig();
    const start = await examView(big.examId);
    // 60 new cards in 12 bites: more than three, so time and one go. No pace measured yet: the app's estimate.
    expect(start.pace).toMatchObject({ open: true, budget: 60, left: 60, bites: 12, long: true });
    // The cards left in today's plan: the 60 new ones (nothing was graded before today, so no reviews).
    expect(start.pace!.cards).toBe(60);
    expect(start.pace!.minutes).toBe(36);
    expect(start.bite!.minutes).toBe(3);

    // One go: today's remaining plan in order, whole bites up to 40 cards, stored as a bite.
    const long = await beginSession(big.examId, "long");
    expect(long).toMatchObject({ mode: "bite", long: true });
    expect(long!.cards.map((c) => c.id)).toEqual(big.order.slice(0, 40));
    expect(long!.minutes).toBe(24);

    // She stops after 22 cards (20 seconds each): the session ends there and what she did counts.
    const done = await play(long!.cards.slice(0, 22), long!.sessionId);
    expect(done).toMatchObject({ mode: "bite", long: true, anotherBite: true, leftLong: true });
    expect(done.stats.cards).toBe(22);
    const after = await examView(big.examId);
    expect(after.pace).toMatchObject({ budget: 60, left: 38, bites: 8, long: true });
    // The minutes left went down with the cards: 38 left. Her pace does not move during the day
    // (today's grades are not in it yet), so they are still the app's estimate.
    expect(after.pace!.cards).toBe(38);
    expect(after.pace!.minutes).toBe(23);
    expect(done.left).toEqual({ minutes: 23, bites: 8 });
    expect(after.bite!.minutes).toBe(Math.max(2, Math.round(after.bite!.cards * 0.6)));
    expect(done.nextMinutes).toBe(after.bite!.minutes);

    // The next one-go session goes on with the cards that were left.
    const next = await beginSession(big.examId, "long");
    expect(next!.cards.filter((c) => big.order.includes(c.id)).map((c) => c.id).filter((id) => big.order.indexOf(id) >= 22).slice(0, 5)).toEqual(big.order.slice(22, 27));
    expect(next!.cards.length).toBeLessThanOrEqual(40);

    // Tomorrow her own pace is known (22 different cards timed, 20 seconds each): the minutes use it.
    setNow(NOW.getTime() + D);
    const tomorrow = await examView(big.examId);
    expect(tomorrow.pace!.minutes).toBe(Math.round((tomorrow.pace!.cards * 20) / 60));
    expect(tomorrow.bite!.minutes).toBe(Math.round((tomorrow.bite!.cards * 20) / 60));
  }, DB_TIMEOUT);

  it("three bites or fewer are not said as time; an exam that is not paced gets its ordinary bite", async () => {
    // Her unpaced exam: "long" is the ordinary bite and nothing is marked.
    const plain = await beginSession(examId, "long");
    expect(plain).toMatchObject({ mode: "bite", long: false });
    const bite = await examView(examId);
    expect(bite.pace).toBeUndefined();
    await expect(beginSession(examId, "longer" as never)).rejects.toThrow(/unknown kind/);
  }, DB_TIMEOUT);
});

describe("a paced exam's reviews after the cut-off", () => {
  it("asks for the important reviews, then says the rest is optional and still serves it", async () => {
    // 300 core cards in one concept, the exam 7 days out: one review is worth a third of a point at most.
    const [course] = await t.db.insert(courses).values({ userId: her, moodleId: 12, name: "Worth" }).returning();
    const [exam] = await t.db
      .insert(exams)
      .values({ userId: her, courseId: course.id, title: "Worth final", kind: "exam", at: new Date(NOW.getTime() + 7 * D) })
      .returning();
    const [concept] = await t.db.insert(concepts).values({ userId: her, examId: exam.id, name: "Worth concept", position: 1, weight: 1 }).returning();
    const made = await t.db
      .insert(cards)
      .values(
        Array.from({ length: 300 }, (_, k) => ({
          userId: her,
          examId: exam.id,
          type: "basic" as const,
          rung: 1,
          body: { q: `Worth ${k}?`, a: "A", core: true },
          origin: "manual" as const,
          contentHash: `worth-${k}`,
          createdAt: new Date(NOW.getTime() - D + k * 1000),
        })),
      )
      .returning();
    await t.db.insert(cardConcepts).values(made.map((c) => ({ cardId: c.id, conceptId: concept.id })));
    // Today she does the plan: 60 new cards.
    for (let g = 0; g < 4; g++) {
      const long = await beginSession(exam.id, "long");
      if (!long) break;
      await play(long.cards, long.sessionId);
    }
    const met = new Set(Object.keys((await t.db.select().from(cardStates)).reduce((m, r) => ({ ...m, [r.cardId]: 1 }), {})));
    expect((await examView(exam.id)).pace).toMatchObject({ left: 0 });

    // Two days before the exam the cards she met are due. The day asks for the important ones only.
    setNow(NOW.getTime() + 5 * D - 3 * 60 * MIN);
    const view = await examView(exam.id);
    expect(view.daysLeft).toBe(2);
    expect(view.pace).toMatchObject({ open: false, done: false, enough: false, optional: null });
    const asked = view.counts.learning + view.counts.due;
    expect(asked).toBeGreaterThan(8);
    expect(asked).toBeLessThan(60);
    expect(view.pace!.bites).toBe(Math.ceil(asked / 8));
    const today = new Date(clock).toISOString().slice(0, 10);
    expect(view.nextReviews[0]).toEqual({ day: today, count: asked });

    // She does what is asked. The last done screen offers no further bite: what is left is optional.
    let done = null as Awaited<ReturnType<typeof endSession>> | null;
    for (let b = 0; b < view.pace!.bites; b++) {
      const bite = await beginSession(exam.id, "bite");
      expect(bite!.cards.every((c) => met.has(c.id))).toBe(true);
      done = await play(bite!.cards, bite!.sessionId);
    }
    expect(done).toMatchObject({ anotherBite: false, left: null, leftLong: false, nextMinutes: null });
    const after = await examView(exam.id);
    expect(after.pace).toMatchObject({ open: false, bites: 0, cards: 0, minutes: 0, enough: true, done: false });
    expect(after.pace!.optional!.cards).toBeGreaterThan(0);
    expect(after.pace!.optional!.cards).toBe(60 - asked - (view.pace!.bites * 8 - asked));
    expect(after.pace!.optional!.gain).toBeGreaterThan(0);
    expect(after.pace!.optional!.gain).toBeLessThan(1);
    expect(after.counts.learning + after.counts.due).toBe(0);
    expect(after.nextReviews.find((d) => d.day === today)).toBeUndefined();
    // Nothing is hidden: the bite is still there, and the optional cards are served to whoever goes on.
    expect(after.bite).not.toBeNull();
    const more = await beginSession(exam.id, "bite");
    expect(more).not.toBeNull();
    expect(more!.cards.every((c) => met.has(c.id))).toBe(true);
    const rest = await beginSession(exam.id, "long");
    expect(rest).toMatchObject({ long: true });
    expect(rest!.cards.length).toBeGreaterThan(0);
  }, DB_TIMEOUT);
});

describe("an exam with a study start (M3-53)", () => {
  // startNewOn is Tuesday 24 Nov 2026; that day starts at 22:00 UTC on the 23rd (Helsinki is UTC+2).
  const START_DAY = "2026-11-24";
  const START = new Date("2026-11-23T22:00:00Z").getTime();

  /** An exam as the importer leaves it: every card new, with a state row first due on the start day. */
  async function seedHeld(): Promise<{ examId: string; cardIds: string[] }> {
    const [course] = await t.db.insert(courses).values({ userId: her, moodleId: 9, name: "Held" }).returning();
    const [exam] = await t.db
      .insert(exams)
      .values({ userId: her, courseId: course.id, title: "Held final", kind: "exam", at: new Date(NOW.getTime() + 30 * D), startNewOn: START_DAY })
      .returning();
    const [concept] = await t.db.insert(concepts).values({ userId: her, examId: exam.id, name: "Held concept", position: 1, weight: 1 }).returning();
    const { newCard } = await import("@/lib/study/memory");
    const cardIds: string[] = [];
    for (let k = 0; k < 6; k++) {
      const [card] = await t.db
        .insert(cards)
        .values({ userId: her, examId: exam.id, type: "basic", rung: 1, body: { q: `Held ${k}?`, a: "A" }, origin: "manual", contentHash: `held-${k}`, importId: `held-${k}` })
        .returning();
      await t.db.insert(cardConcepts).values({ cardId: card.id, conceptId: concept.id });
      await t.db.insert(cardStates).values({ cardId: card.id, fsrs: newCard(new Date(START)), dueAt: new Date(START), lapses: 0 });
      cardIds.push(card.id);
    }
    return { examId: exam.id, cardIds };
  }

  it("offers no new card before the start day, and does from that day", async () => {
    const held = await seedHeld();

    // Saturday the 14th: ten days early. No bite, and no other session brings a new card either.
    const early = await examView(held.examId);
    expect(early.bite).toBeNull();
    expect(early.concepts).toHaveLength(1); // the deck is still shown
    // The status is "before start", and no pace or projection is promised.
    expect(early.verdict).toEqual({ key: "before_start", text: "Starts Tue 24 Nov", ok: false });
    expect(early.plan.curve).toEqual([early.forecast]);
    expect(await beginSession(held.examId, "bite")).toBeNull();
    expect(await beginSession(held.examId, "extra")).toBeNull();
    expect(await beginSession(held.examId, "tile", "basic")).toBeNull();
    expect(await beginSession(held.examId, "concept", early.concepts[0].id)).toBeNull();

    // The last minute of the 23rd in Helsinki: still nothing.
    setNow(START - MIN);
    expect((await examView(held.examId)).bite).toBeNull();
    expect(await beginSession(held.examId, "bite")).toBeNull();

    // Midnight: the new cards open.
    setNow(START);
    expect((await examView(held.examId)).bite).not.toBeNull();
    const bite = await beginSession(held.examId, "bite");
    expect(bite).not.toBeNull();
    expect(bite!.cards.length).toBeGreaterThanOrEqual(3);
    expect(bite!.cards.every((c) => held.cardIds.includes(c.id))).toBe(true);

    // Her other exam, which has no start day, was never held back.
    setNow(NOW.getTime());
    expect(await beginSession(examId, "bite")).not.toBeNull();
  }, DB_TIMEOUT);

  it("before the start day a card she has already graded is still reviewed, alone", async () => {
    const held = await seedHeld();
    // She met one card early (an extra session on the day the hold was not there yet).
    await t.db.update(exams).set({ startNewOn: null }).where(eq(exams.id, held.examId));
    const open = await beginSession(held.examId, "extra");
    const seen = open!.cards[0].id;
    setNow(clock + 20_000);
    await saveProgress(open!.sessionId, [{ cardId: seen, grade: 1, firstTry: true, ms: 20_000, at: new Date(clock) }]);
    await endSession(open!.sessionId);
    await t.db.update(exams).set({ startNewOn: START_DAY }).where(eq(exams.id, held.examId));

    setNow(clock + D);
    const bite = await beginSession(held.examId, "bite");
    expect(bite!.cards.map((c) => c.id)).toEqual([seen]);
  }, DB_TIMEOUT);

  it("before the start day an imported new card is held and a card from her note is offered (M9-25)", async () => {
    const held = await seedHeld();
    // One imported card (Anki) and one she turned from her own note, both new.
    const [concept] = await t.db.select().from(concepts).where(eq(concepts.examId, held.examId));
    const made: Record<string, string> = {};
    for (const origin of ["anki", "note"] as const) {
      const [card] = await t.db
        .insert(cards)
        .values({ userId: her, examId: held.examId, type: "basic", rung: 1, body: { q: `From ${origin}?`, a: "A" }, origin, contentHash: `from-${origin}`, importId: `from-${origin}` })
        .returning();
      await t.db.insert(cardConcepts).values({ cardId: card.id, conceptId: concept.id });
      made[origin] = card.id;
    }

    // Ten days before the start: only the note card is offered.
    const extra = await beginSession(held.examId, "extra");
    expect(extra).not.toBeNull();
    const offered = extra!.cards.map((c) => c.id);
    expect(offered).toEqual([made.note]);
    expect(offered).not.toContain(made.anki);
    expect(offered.some((id) => held.cardIds.includes(id))).toBe(false);
  }, DB_TIMEOUT);
});

describe("exam day and the day after", () => {
  // The deck's exam is 20 days after NOW (12:00 in Helsinki): Friday 4 Dec 2026, 12:00.
  const EXAM = NOW.getTime() + 20 * D;

  it("exam day lasts the whole Helsinki day, bites included, whatever the exam's clock time", async () => {
    setNow(new Date("2026-12-04T00:00:00+02:00").getTime());
    expect(await examView(examId)).toMatchObject({ daysLeft: 0, phase: { name: "Exam day" } });
    // Hours after the exam's own time.
    setNow(new Date("2026-12-04T23:59:00+02:00").getTime());
    const late = await examView(examId);
    expect(late).toMatchObject({ daysLeft: 0, phase: { name: "Exam day" } });
    expect(late.bite).not.toBeNull();
    expect(EXAM).toBeLessThan(clock);
  });

  it("a past exam starts no session of any kind", async () => {
    const { ExamOver } = await import("./start-date");
    const { studySessions } = await import("@/server/db/schema/study");
    const view = await examView(examId);
    // The last minute of exam day: still allowed.
    setNow(new Date("2026-12-04T23:59:00+02:00").getTime());
    expect(await beginSession(examId, "extra")).not.toBeNull();
    const before = (await t.db.select().from(studySessions)).length;

    setNow(new Date("2026-12-05T00:00:00+02:00").getTime());
    for (const [kind, arg] of [["bite"], ["extra"], ["tile", "basic"], ["concept", view.concepts[0].id]] as const) {
      const err = await caught(beginSession(examId, kind, arg));
      expect(err).toBeInstanceOf(ExamOver);
      expect((err as InstanceType<typeof ExamOver>).examId).toBe(examId);
    }
    expect((await t.db.select().from(studySessions)).length).toBe(before);
    // Someone else's past exam is still "not found", not "over".
    expect(await caught(beginSession(theirExamId, "bite"))).toBeInstanceOf(StudyNotFound);
  });

  it("from 00:00 the day after the exam is over: days left are negative and no bite is built", async () => {
    setNow(new Date("2026-12-05T00:00:00+02:00").getTime());
    const over = await examView(examId);
    expect(over.daysLeft).toBe(-1);
    expect(over.bite).toBeNull();
    // The deck is still there: it is the day that ended, not the cards that ran out.
    expect(over.concepts).toHaveLength(3);
    expect(over.counts.new).toBeGreaterThan(0);
  });

  it("counts days to the exam as Helsinki calendar days", async () => {
    setNow(new Date("2026-12-03T23:59:00+02:00").getTime());
    expect((await examView(examId)).daysLeft).toBe(1);
    setNow(new Date("2026-11-27T00:01:00+02:00").getTime());
    expect((await examView(examId)).daysLeft).toBe(7);
  });
});
