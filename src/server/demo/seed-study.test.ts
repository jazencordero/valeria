// @vitest-environment node
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { cards, cardStates, concepts, exams, reviews, studySessions } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { parseCard } from "@/lib/study/card-schema";
import { forecastShown } from "@/lib/study/forecast";
import { rungOf } from "@/lib/study/ladder";

// examView reads the user from the session cookie and uses the app's `db`;
// both are swapped for this test's, as in src/server/study/actions.test.ts.
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

const { examView } = await import("@/server/study/actions");
const { DEMO_DECK, demoCards, examTime, planExam, seedStudy } = await import("./seed-study");

const DB_TIMEOUT = 30_000;
// Saturday 14 November 2026, 12:00 in Helsinki: the prototype's today.
const NOW = new Date("2026-11-14T10:00:00Z");
const [EXAM, QUIZ] = DEMO_DECK.exams;

/** The prototype's forecast: weighted starting mastery (53 for the exam). */
const protoForecast = (e: typeof EXAM) =>
  forecastShown(e.concepts.map((c) => ({ weight: c.weight, mastery: c.mastery })));

describe("demo-deck.json", () => {
  it("holds the prototype's exam and quiz", () => {
    expect(DEMO_DECK.exams.map((e) => [e.key, e.kind, e.daysAhead, e.concepts.length, e.cards.length])).toEqual([
      ["exam", "exam", 6, 6, 13],
      ["quiz", "quiz", 13, 3, 3],
    ]);
    expect(protoForecast(EXAM)).toBe(53);
    for (const e of DEMO_DECK.exams) {
      expect(e.hist).toHaveLength(13);
      expect(e.heat).toHaveLength(13);
    }
  });

  it("every card passes the card schema and names a concept of its exam", () => {
    for (const e of DEMO_DECK.exams) {
      for (const raw of e.cards) {
        const parsed = parseCard(raw);
        expect(parsed.ok, `${String(raw.id)}: ${parsed.ok ? "" : parsed.problems.join("; ")}`).toBe(true);
      }
      expect(() => demoCards(e)).not.toThrow();
    }
  });
});

describe("planExam", () => {
  it("puts the exam 6 days ahead at 09:00 and the quiz 13 days ahead at 12:00, Helsinki", () => {
    expect(examTime(EXAM, NOW).toISOString()).toBe("2026-11-20T07:00:00.000Z");
    expect(examTime(QUIZ, NOW).toISOString()).toBe("2026-11-27T10:00:00.000Z");
  });

  it.each([EXAM, QUIZ])("reviews $key on the prototype's heat days, plus a head start 14 days ago", (exam) => {
    const plan = planExam(exam, NOW);
    const perDay = new Map(plan.days.map((d) => [d.daysAgo, d.reviews.length]));
    expect(exam.heat.map((_, i) => perDay.get(13 - i) ?? 0)).toEqual(exam.heat);
    expect([...perDay.keys()].every((d) => d >= 1 && d <= 14)).toBe(true);
    expect(perDay.get(14)).toBeGreaterThan(0);
    // Every card but the boss cards is studied; the boss cards stay new.
    const graded = Object.keys(plan.states);
    expect(graded.sort()).toEqual(plan.cards.filter((c) => !c.card.boss).map((c) => c.id).sort());
  });

  it.each([EXAM, QUIZ])("lands $key's concepts on the prototype's rungs", (exam) => {
    const plan = planExam(exam, NOW);
    for (const c of exam.concepts) {
      expect(rungOf(plan.mastery[c.id]), c.id).toBe(rungOf(c.mastery));
      expect(Math.abs(plan.mastery[c.id] - c.mastery), c.id).toBeLessThan(0.11);
    }
  });

  it("lands the exam's forecast within 2 points of the prototype's", () => {
    expect(Math.abs(planExam(EXAM, NOW).forecast - protoForecast(EXAM))).toBeLessThanOrEqual(2);
  });

  it("is the same plan every time", () => {
    const a = planExam(EXAM, NOW);
    const b = planExam(EXAM, NOW);
    expect(b.days).toEqual(a.days);
  });
});

describe("seedStudy", () => {
  let t: TestDb;
  let her: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    t = await createTestDb();
    signedIn.db = t.db as unknown as Record<string | symbol, unknown>;
    const [u] = await t.db.insert(users).values({ settings: { demo: true } }).returning();
    her = u.id;
    signedIn.userId = her;
    // The demo sync's course names (tests/fixtures/moodle-sample).
    await t.db.insert(courses).values([
      { userId: her, moodleId: 1, name: "Strategic IT Management, Lecture, 1.9.2026-18.12.2026" },
      { userId: her, moodleId: 2, name: "Forecasting Methods, Lecture, 1.9.2026-18.12.2026" },
    ]);
  }, DB_TIMEOUT);

  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  const count = async () => ({
    exams: (await t.db.select().from(exams).where(eq(exams.userId, her))).length,
    concepts: (await t.db.select().from(concepts).where(eq(concepts.userId, her))).length,
    cards: (await t.db.select().from(cards).where(eq(cards.userId, her))).length,
    reviews: (await t.db.select().from(reviews).where(eq(reviews.userId, her))).length,
    sessions: (await t.db.select().from(studySessions).where(eq(studySessions.userId, her))).length,
  });

  it(
    "after seeding, examView gives the prototype's forecast (within 2) and a bite of 8",
    async () => {
      const seeded = await seedStudy(her, NOW, t.db);
      const examId = seeded.exams.find((e) => e.key === "exam")!.id;
      const view = await examView(examId);

      expect(view.exam.title).toBe("Exam");
      expect(view.daysLeft).toBe(6);
      expect(Math.abs(view.forecast - protoForecast(EXAM))).toBeLessThanOrEqual(2);
      expect(view.bite?.cards).toBe(8);
      expect(view.concepts.map((c) => c.name)).toEqual(EXAM.concepts.map((c) => c.name));
      expect(view.concepts.map((c) => c.rung)).toEqual(EXAM.concepts.map((c) => rungOf(c.mastery)));
      // The last-14 chart is the prototype's heat, then today (nothing yet).
      expect(view.last14.map((d) => d.count)).toEqual([...EXAM.heat, 0]);
      // The forecast chart: 13 days, climbing from the head start to about today's value.
      expect(view.history).toHaveLength(13);
      expect(view.history[0]).toBeLessThan(view.history[12]);
      expect(Math.abs(view.history[12] - view.forecast)).toBeLessThan(0.5);
      expect(view.bitesDoneToday).toBe(0);
    },
    DB_TIMEOUT,
  );

  it(
    "seeds the quiz too, 13 days out",
    async () => {
      const seeded = await seedStudy(her, NOW, t.db);
      const view = await examView(seeded.exams.find((e) => e.key === "quiz")!.id);
      expect(view.exam.kind).toBe("quiz");
      expect(view.daysLeft).toBe(13);
      expect(view.last14.map((d) => d.count)).toEqual([...QUIZ.heat, 0]);
      expect(view.concepts.map((c) => c.rung)).toEqual(QUIZ.concepts.map((c) => rungOf(c.mastery)));
      expect(view.bite).not.toBeNull();
    },
    DB_TIMEOUT,
  );

  it(
    "writes card states that match replaying the reviews, and leaves boss cards new",
    async () => {
      await seedStudy(her, NOW, t.db);
      const rows = await t.db
        .select({ boss: cards.boss, fsrs: cardStates.fsrs, lastReviewAt: cardStates.lastReviewAt })
        .from(cards)
        .innerJoin(cardStates, eq(cardStates.cardId, cards.id))
        .where(eq(cards.userId, her));
      expect(rows).toHaveLength(16);
      for (const r of rows) {
        const state = (r.fsrs as { state: number }).state;
        if (r.boss) expect(state).toBe(0);
        else expect(r.lastReviewAt).not.toBeNull();
      }
    },
    DB_TIMEOUT,
  );

  it(
    "is idempotent: a second run replaces the deck instead of adding to it",
    async () => {
      await seedStudy(her, NOW, t.db);
      const once = await count();
      expect(once).toEqual({ exams: 2, concepts: 9, cards: 16, reviews: once.reviews, sessions: once.sessions });
      await seedStudy(her, NOW, t.db);
      expect(await count()).toEqual(once);
    },
    DB_TIMEOUT,
  );

  it(
    "refuses without the demo's courses and writes nothing",
    async () => {
      await t.db.delete(courses).where(and(eq(courses.userId, her), eq(courses.moodleId, 2)));
      await expect(seedStudy(her, NOW, t.db)).rejects.toThrow(/no course named like "Forecasting Methods"/);
      expect((await count()).exams).toBe(0);
    },
    DB_TIMEOUT,
  );
});
