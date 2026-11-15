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

    const first = await beginSession(examId, "bite");
    expect(first).not.toBeNull();
    expect(first!.cards.length).toBe(start.bite!.cards);
    expect(first!.cards[0].body).toMatchObject({ back: "A" });
    // A new card: Missed comes back in a minute, Got it in ten.
    expect(first!.cards[0].intervals[1].ms).toBe(MIN);
    expect(first!.cards[0].intervals[3].ms).toBe(10 * MIN);

    const done1 = await play(first!.cards, first!.sessionId);
    expect(done1.forecastAfter).toBeGreaterThan(done1.forecastBefore);
    expect(done1.forecastBefore).toBe(0);
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
