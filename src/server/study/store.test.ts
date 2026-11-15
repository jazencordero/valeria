// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newCard, type MemoryState } from "@/lib/study/memory";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import {
  cardConcepts,
  cards,
  cardStates,
  concepts,
  exams,
  reviews,
  studySessions,
} from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import {
  bitesDoneToday,
  countsToday,
  dayKey,
  finishSession,
  flagCard,
  last14,
  loadDeck,
  recordReviews,
  reviewDays,
  startSession,
  StudyNotFound,
  upcoming,
  type ReviewInput,
} from "./store";

const DB_TIMEOUT = 30_000;
const H = 60 * 60 * 1000;
const D = 24 * H;
// Saturday 14 Nov 2026, 12:00 in Helsinki (UTC+2 in winter).
const NOW = new Date("2026-11-14T10:00:00Z");

let t: TestDb;
let her: string;
let other: string;
let examId: string;
let otherExamId: string;
let theirExamId: string;
let hash = 0;

async function makeUser(): Promise<string> {
  const [u] = await t.db.insert(users).values({}).returning();
  return u.id;
}

async function makeExam(userId: string, moodleId: number): Promise<string> {
  const [course] = await t.db.insert(courses).values({ userId, moodleId, name: `Course ${moodleId}` }).returning();
  const [exam] = await t.db
    .insert(exams)
    .values({ userId, courseId: course.id, title: "Final", at: new Date(NOW.getTime() + 20 * D) })
    .returning();
  return exam.id;
}

async function makeCard(userId: string, exam: string, extra: Partial<typeof cards.$inferInsert> = {}): Promise<string> {
  hash += 1;
  const [c] = await t.db
    .insert(cards)
    .values({ userId, examId: exam, type: "basic", body: { front: "Q", back: "A" }, origin: "manual", contentHash: `h${hash}`, ...extra })
    .returning();
  return c.id;
}

/** A stored memory with a chosen FSRS state and due time. */
async function setState(cardId: string, state: MemoryState["state"], dueAt: Date): Promise<void> {
  const fsrs: MemoryState = { ...newCard(NOW), state, dueAt: dueAt.getTime(), reps: state === 0 ? 0 : 1 };
  await t.db.insert(cardStates).values({ cardId, fsrs, dueAt, lapses: 0, lastReviewAt: NOW });
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
  t = await createTestDb();
  her = await makeUser();
  other = await makeUser();
  examId = await makeExam(her, 1);
  otherExamId = await makeExam(her, 2);
  theirExamId = await makeExam(other, 1);
}, DB_TIMEOUT);

afterEach(async () => {
  await t.close();
}, DB_TIMEOUT);

describe("loadDeck", () => {
  it("returns concepts in order and active cards with states and concept links", async () => {
    const [c2, c1] = await t.db
      .insert(concepts)
      .values([
        { userId: her, examId, name: "Second", position: 2 },
        { userId: her, examId, name: "First", position: 1 },
      ])
      .returning();
    const a = await makeCard(her, examId);
    const b = await makeCard(her, examId);
    await makeCard(her, examId, { status: "suspended" });
    await makeCard(her, examId, { status: "flagged" });
    await makeCard(her, otherExamId);
    await t.db.insert(cardConcepts).values([
      { cardId: a, conceptId: c2.id },
      { cardId: a, conceptId: c1.id },
      { cardId: b, conceptId: c2.id },
    ]);
    await setState(b, 2, new Date(NOW.getTime() + D));

    const deck = await loadDeck(her, examId, t.db);

    expect(deck.concepts.map((c) => c.name)).toEqual(["First", "Second"]);
    expect(deck.cards.map((c) => c.id)).toEqual([a, b]);
    expect(deck.cards[0].conceptIds).toEqual([c1.id, c2.id]);
    expect(deck.cards[0].memory).toBeNull();
    expect(deck.cards[1].conceptIds).toEqual([c2.id]);
    expect(deck.cards[1].memory?.fsrs.state).toBe(2);
    expect(deck.cards[1].memory?.dueAt.getTime()).toBe(NOW.getTime() + D);
  }, DB_TIMEOUT);

  it("refuses another user's exam", async () => {
    expect(await caught(loadDeck(her, theirExamId, t.db))).toBeInstanceOf(StudyNotFound);
    expect(await caught(loadDeck(her, "not-a-uuid", t.db))).toBeInstanceOf(StudyNotFound);
  }, DB_TIMEOUT);
});

describe("loadDeck on a deck from a hand-made bundle", () => {
  it("serves cards in the bundle's order whatever order the rows were written in", async () => {
    const [c2, c1] = await t.db
      .insert(concepts)
      .values([
        { userId: her, examId, name: "Later idea", position: 2 },
        { userId: her, examId, name: "Earlier idea", position: 1 },
      ])
      .returning();
    // Written out of order, all with one timestamp, as an early import did.
    const at = new Date("2026-11-01T10:00:00Z");
    const make = (importId: string | null, body: Record<string, unknown> = {}) =>
      makeCard(her, examId, { importId, createdAt: at, body: { front: "Q", back: "A", ...body } });
    const later10 = await make("c10");
    const later2 = await make("c2");
    const earlyPlain = await make("a3");
    const earlyCore = await make("a9", { core: true });
    const earlyFirst = await make("a7", { first: true });
    const loose = await make(null);
    await t.db.insert(cardConcepts).values([
      { cardId: later10, conceptId: c2.id },
      { cardId: later2, conceptId: c2.id },
      { cardId: earlyPlain, conceptId: c1.id },
      { cardId: earlyCore, conceptId: c1.id },
      { cardId: earlyFirst, conceptId: c1.id },
    ]);

    const deck = await loadDeck(her, examId, t.db);

    // Earlier concept first; in it the opening card, then core, then the rest; "c2" before "c10";
    // a card with no concept last.
    expect(deck.cards.map((c) => c.id)).toEqual([earlyFirst, earlyCore, earlyPlain, later2, later10, loose]);
  }, DB_TIMEOUT);
});

describe("sessions", () => {
  it("starts a session with its cards and finishes it once", async () => {
    const a = await makeCard(her, examId);
    const session = await startSession(her, examId, "bite", [a], NOW, t.db);
    expect(session).toMatchObject({ userId: her, examId, mode: "bite", endedAt: null, summary: { cardIds: [a] } });
    expect(session.startedAt.getTime()).toBe(NOW.getTime());

    const end = new Date(NOW.getTime() + 5 * 60 * 1000);
    const done = await finishSession(her, session.id, { cards: 1, seconds: 300, best: 1, perfect: true, climbs: [] }, end, t.db);
    expect(done.endedAt?.getTime()).toBe(end.getTime());
    expect(done.summary).toEqual({ cardIds: [a], cards: 1, seconds: 300, best: 1, perfect: true, climbs: [] });

    const again = await finishSession(her, session.id, { cards: 1 }, new Date(end.getTime() + H), t.db);
    expect(again.endedAt?.getTime()).toBe(end.getTime());
  }, DB_TIMEOUT);

  it("refuses another user's exam, card or session", async () => {
    const theirs = await makeCard(other, theirExamId);
    const elsewhere = await makeCard(her, otherExamId);
    expect(await caught(startSession(her, theirExamId, "bite", [], NOW, t.db))).toBeInstanceOf(StudyNotFound);
    expect(await caught(startSession(her, examId, "bite", [theirs], NOW, t.db))).toBeInstanceOf(StudyNotFound);
    expect(await caught(startSession(her, examId, "bite", [elsewhere], NOW, t.db))).toBeInstanceOf(StudyNotFound);

    const theirSession = await startSession(other, theirExamId, "bite", [theirs], NOW, t.db);
    expect(await caught(finishSession(her, theirSession.id, {}, NOW, t.db))).toBeInstanceOf(StudyNotFound);
    expect(await t.db.select().from(studySessions).where(eq(studySessions.userId, her))).toHaveLength(0);
  }, DB_TIMEOUT);
});

describe("recordReviews", () => {
  it("stores the same batch once and writes each card's memory", async () => {
    const a = await makeCard(her, examId);
    const b = await makeCard(her, examId);
    const session = await startSession(her, examId, "bite", [a, b], NOW, t.db);
    const batch: ReviewInput[] = [
      { cardId: a, grade: 3, firstTry: true, ms: 4200, at: new Date(NOW.getTime() + 1000) },
      { cardId: b, grade: 1, firstTry: true, ms: 3000, at: new Date(NOW.getTime() + 2000) },
      { cardId: b, grade: 3, firstTry: false, ms: 2500, at: new Date(NOW.getTime() + 70_000) },
    ];

    expect(await recordReviews(her, session.id, batch, t.db)).toEqual({ stored: 3, skipped: 0 });
    const stateAfterFirst = await t.db.select().from(cardStates);
    expect(await recordReviews(her, session.id, batch, t.db)).toEqual({ stored: 0, skipped: 3 });
    // Repeats inside one batch are dropped too.
    expect(await recordReviews(her, session.id, [batch[0], batch[0]], t.db)).toEqual({ stored: 0, skipped: 2 });

    const stored = await t.db.select().from(reviews);
    expect(stored).toHaveLength(3);
    expect(stored.every((r) => r.userId === her && r.sessionId === session.id)).toBe(true);
    expect(await t.db.select().from(cardStates)).toEqual(stateAfterFirst);

    const [stateA] = await t.db.select().from(cardStates).where(eq(cardStates.cardId, a));
    const fsrsA = stateA.fsrs as MemoryState;
    expect(fsrsA.reps).toBe(1);
    expect(stateA.dueAt.getTime()).toBe(fsrsA.dueAt);
    expect(stateA.lastReviewAt?.getTime()).toBe(NOW.getTime() + 1000);

    const [stateB] = await t.db.select().from(cardStates).where(eq(cardStates.cardId, b));
    const fsrsB = stateB.fsrs as MemoryState;
    expect(fsrsB.reps).toBe(2); // both of b's grades applied, in time order
    expect(stateB.lastReviewAt?.getTime()).toBe(NOW.getTime() + 70_000);
    expect(stateB.lapses).toBe(fsrsB.lapses);
  }, DB_TIMEOUT);

  it("counts a lapse when a review card is missed", async () => {
    const a = await makeCard(her, examId);
    const session = await startSession(her, examId, "bite", [a], NOW, t.db);
    // New, then Easy (graduates to review), then Again days later.
    await recordReviews(her, session.id, [{ cardId: a, grade: 4, firstTry: true, ms: 1000, at: NOW }], t.db);
    const [mid] = await t.db.select().from(cardStates);
    expect((mid.fsrs as MemoryState).state).toBe(2);
    await recordReviews(her, session.id, [{ cardId: a, grade: 1, firstTry: true, ms: 1000, at: new Date(mid.dueAt.getTime() + H) }], t.db);
    const [after] = await t.db.select().from(cardStates);
    expect(after.lapses).toBe(1);
  }, DB_TIMEOUT);

  it("refuses another user's card and stores nothing from that batch", async () => {
    const a = await makeCard(her, examId);
    const theirs = await makeCard(other, theirExamId);
    const session = await startSession(her, examId, "bite", [a], NOW, t.db);
    const err = await caught(
      recordReviews(
        her,
        session.id,
        [
          { cardId: a, grade: 3, firstTry: true, ms: 1000, at: NOW },
          { cardId: theirs, grade: 3, firstTry: true, ms: 1000, at: NOW },
        ],
        t.db,
      ),
    );
    expect(err).toBeInstanceOf(StudyNotFound);
    expect((err as Error).message).toContain(theirs);
    expect(await t.db.select().from(reviews)).toHaveLength(0);
    expect(await t.db.select().from(cardStates)).toHaveLength(0);
  }, DB_TIMEOUT);

  it("refuses another user's session and a card from another exam", async () => {
    const a = await makeCard(her, examId);
    const elsewhere = await makeCard(her, otherExamId);
    const theirs = await makeCard(other, theirExamId);
    const theirSession = await startSession(other, theirExamId, "bite", [theirs], NOW, t.db);
    const mine = await startSession(her, examId, "bite", [a], NOW, t.db);
    const one = (cardId: string): ReviewInput[] => [{ cardId, grade: 3, firstTry: true, ms: 1, at: NOW }];

    expect(await caught(recordReviews(her, theirSession.id, one(a), t.db))).toBeInstanceOf(StudyNotFound);
    expect(await caught(recordReviews(her, mine.id, one(elsewhere), t.db))).toBeInstanceOf(StudyNotFound);
    const badGrade = await caught(recordReviews(her, mine.id, [{ ...one(a)[0], grade: 5 as never }], t.db));
    expect((badGrade as Error).message).toContain("grade must be 1 to 4");
    expect(await t.db.select().from(reviews)).toHaveLength(0);
  }, DB_TIMEOUT);
});

describe("flagCard", () => {
  it("takes a card out of the deck and refuses another user's card", async () => {
    const a = await makeCard(her, examId);
    const b = await makeCard(her, examId);
    const theirs = await makeCard(other, theirExamId);
    await flagCard(her, a, "flagged", t.db);
    await flagCard(her, b, "suspended", t.db);

    expect((await loadDeck(her, examId, t.db)).cards).toHaveLength(0);
    const rows = await t.db.select({ id: cards.id, status: cards.status }).from(cards).where(eq(cards.userId, her));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [a]: "flagged", [b]: "suspended" });

    expect(await caught(flagCard(her, theirs, "flagged", t.db))).toBeInstanceOf(StudyNotFound);
    const [still] = await t.db.select().from(cards).where(eq(cards.id, theirs));
    expect(still.status).toBe("active");
  }, DB_TIMEOUT);
});

describe("counts over a hand-built deck", () => {
  // Today in Helsinki is 2026-11-14; it ends at 2026-11-14T22:00Z.
  async function buildDeck(): Promise<void> {
    await makeCard(her, examId); // new, no state
    const newWithState = await makeCard(her, examId);
    await setState(newWithState, 0, NOW); // new, state row from a skipped start
    const learnToday = await makeCard(her, examId);
    await setState(learnToday, 1, new Date(NOW.getTime() + 10 * 60 * 1000));
    const relearnTonight = await makeCard(her, examId);
    await setState(relearnTonight, 3, new Date("2026-11-14T21:59:00Z")); // 23:59 Helsinki
    const learnTomorrow = await makeCard(her, examId);
    await setState(learnTomorrow, 1, new Date("2026-11-14T22:01:00Z")); // 00:01 Helsinki on the 15th
    const overdue = await makeCard(her, examId);
    await setState(overdue, 2, new Date(NOW.getTime() - 3 * D));
    const dueLater = await makeCard(her, examId);
    await setState(dueLater, 2, new Date(NOW.getTime() + 6 * H));
    const inThree = await makeCard(her, examId);
    await setState(inThree, 2, new Date(NOW.getTime() + 3 * D));
    const suspended = await makeCard(her, examId, { status: "suspended" });
    await setState(suspended, 2, new Date(NOW.getTime() - D));
    const otherExam = await makeCard(her, otherExamId);
    await setState(otherExam, 2, new Date(NOW.getTime() - D));
    const theirs = await makeCard(other, theirExamId);
    await setState(theirs, 2, new Date(NOW.getTime() - D));
  }

  it("countsToday: new, learning and due", async () => {
    await buildDeck();
    expect(await countsToday(her, examId, NOW, t.db)).toEqual({ new: 2, learning: 2, due: 2 });
    expect(await caught(countsToday(her, theirExamId, NOW, t.db))).toBeInstanceOf(StudyNotFound);
  }, DB_TIMEOUT);

  it("upcoming: cards per due day, overdue counted today", async () => {
    await buildDeck();
    expect(await upcoming(her, examId, NOW, t.db)).toEqual([
      { day: "2026-11-14", count: 4 },
      { day: "2026-11-15", count: 1 },
      { day: "2026-11-17", count: 1 },
    ]);
  }, DB_TIMEOUT);
});

describe("days", () => {
  async function reviewAt(cardId: string, sessionId: string, at: Date): Promise<void> {
    await recordReviews(her, sessionId, [{ cardId, grade: 3, firstTry: true, ms: 1, at }], t.db);
  }

  it("dayKey uses Helsinki days", () => {
    expect(dayKey(new Date("2026-11-13T21:59:00Z"))).toBe("2026-11-13");
    expect(dayKey(new Date("2026-11-13T22:00:00Z"))).toBe("2026-11-14");
    expect(dayKey(new Date("2026-07-01T21:00:00Z"))).toBe("2026-07-02"); // summer, UTC+3
  });

  it("reviewDays and last14 group reviews by Helsinki day", async () => {
    const a = await makeCard(her, examId);
    const elsewhere = await makeCard(her, otherExamId);
    const s = await startSession(her, examId, "bite", [a], NOW, t.db);
    const s2 = await startSession(her, otherExamId, "bite", [elsewhere], NOW, t.db);
    await reviewAt(a, s.id, new Date(NOW.getTime() - 20 * D)); // too old for last14
    await reviewAt(a, s.id, new Date("2026-11-01T10:00:00Z")); // 13 days ago: first cell
    await reviewAt(a, s.id, new Date("2026-11-12T22:30:00Z")); // 00:30 on the 13th in Helsinki
    await reviewAt(a, s.id, new Date("2026-11-13T08:00:00Z"));
    await reviewAt(a, s.id, new Date("2026-11-14T09:00:00Z"));
    await reviewAt(elsewhere, s2.id, new Date("2026-11-14T09:00:00Z")); // another exam

    expect(await reviewDays(her, new Date("2026-11-01T00:00:00Z"), t.db)).toEqual([
      "2026-11-01",
      "2026-11-13",
      "2026-11-14",
    ]);
    expect(await reviewDays(other, new Date(0), t.db)).toEqual([]);

    const cells = await last14(her, examId, NOW, t.db);
    expect(cells).toHaveLength(14);
    expect(cells[0]).toEqual({ day: "2026-11-01", count: 1 });
    expect(cells[13]).toEqual({ day: "2026-11-14", count: 1 });
    expect(cells[12]).toEqual({ day: "2026-11-13", count: 2 });
    expect(cells.reduce((n, c) => n + c.count, 0)).toBe(4);
    expect(await caught(last14(other, examId, NOW, t.db))).toBeInstanceOf(StudyNotFound);
  }, DB_TIMEOUT);

  it("bitesDoneToday counts bites for this exam that ended today", async () => {
    const finish = async (mode: "bite" | "tile", exam: string, end: Date | null, user = her) => {
      const s = await startSession(user, exam, mode, [], new Date(NOW.getTime() - 2 * D), t.db);
      if (end) await finishSession(user, s.id, {}, end, t.db);
    };
    await finish("bite", examId, new Date("2026-11-13T22:05:00Z")); // 00:05 today
    await finish("bite", examId, new Date(NOW.getTime() - H));
    await finish("bite", examId, null); // not finished
    await finish("tile", examId, new Date(NOW.getTime() - H));
    await finish("bite", examId, new Date("2026-11-13T21:55:00Z")); // 23:55 yesterday
    await finish("bite", otherExamId, new Date(NOW.getTime() - H));
    await finish("bite", theirExamId, new Date(NOW.getTime() - H), other);

    expect(await bitesDoneToday(her, examId, NOW, t.db)).toBe(2);
    expect(await caught(bitesDoneToday(her, theirExamId, NOW, t.db))).toBeInstanceOf(StudyNotFound);
  }, DB_TIMEOUT);
});
