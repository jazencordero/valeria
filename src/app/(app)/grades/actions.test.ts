// @vitest-environment node
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, newToken } from "@/server/auth/session";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { gradeItems } from "@/server/db/schema/grades";
import { ALLOWED_SITES, connectWithKey } from "@/server/moodle/connect";
import { DEMO_KEY } from "@/server/moodle/fake-inline";
import type { GradeItemRow } from "@/server/moodle/read/grades";
import { syncCourses } from "@/server/sync/courses";
import { syncGrades, type SyncGradesDeps } from "@/server/sync/grades";
import { saveWeightsFor } from "./actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Made-up values for tests only. The fake Moodle accepts DEMO_KEY and nothing else.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const AALTO = ALLOWED_SITES[0];
// The machine can be busy; a fresh database per test takes a while.
const SLOW = 90_000;

const item = (id: number, name: string, fields: Partial<GradeItemRow> = {}): GradeItemRow => ({
  moodleRef: `gradeitem:${id}`,
  name,
  kind: "assign",
  max: 20,
  score: null,
  percent: null,
  weight: null,
  gradedAt: null,
  hidden: false,
  ...fields,
});

/** Moodle's grade items for course 3101: no weights at all. */
const NO_WEIGHTS = (): GradeItemRow[] => [item(6101, "Assignment 1", { score: 17 }), item(6102, "Week 3 quiz", { max: 10 })];

const fake = (answer: () => GradeItemRow[]): SyncGradesDeps => ({
  getGradeItems: async (_conn, course) => (course === 3101 ? answer() : []),
});

describe("saveWeightsFor", () => {
  let t: TestDb;
  beforeEach(async () => {
    vi.stubEnv("MOODLE_FAKE", "1");
    vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
    t = await createTestDb();
  }, SLOW);
  afterEach(async () => {
    vi.unstubAllEnvs();
    await t.close();
  });

  /** A user with the fake Moodle connected, courses synced, and course 3101's two items synced without weights. */
  async function setup() {
    const { user } = await ensureSessionFor(t.db, newToken());
    const result = await connectWithKey(user.id, AALTO, DEMO_KEY, t.db);
    if (!result.ok) throw new Error("the fake Moodle rejected the demo key");
    const userId = result.userId;
    await syncCourses(userId, t.db);
    await syncGrades(userId, t.db, fake(NO_WEIGHTS));
    const [course] = await t.db
      .select()
      .from(courses)
      .where(and(eq(courses.userId, userId), eq(courses.moodleId, 3101)));
    const items = await itemsOf(userId, course.id);
    return { userId, courseId: course.id, a1: items[0].id, quiz: items[1].id };
  }

  async function itemsOf(userId: string, courseId: string) {
    return t.db
      .select()
      .from(gradeItems)
      .where(and(eq(gradeItems.userId, userId), eq(gradeItems.courseId, courseId)))
      .orderBy(asc(gradeItems.position));
  }

  /** Another user with one course and one item of her own. */
  async function otherUser() {
    const { user } = await ensureSessionFor(t.db, newToken());
    const [course] = await t.db
      .insert(courses)
      .values({ userId: user.id, moodleId: 9001, name: "Other course" })
      .returning();
    const [row] = await t.db
      .insert(gradeItems)
      .values({ userId: user.id, courseId: course.id, moodleRef: "gradeitem:9901", name: "Essay", max: 10 })
      .returning();
    return { userId: user.id, courseId: course.id, itemId: row.id };
  }

  it(
    "saves her weights as fractions with source manual, and creates the added piece",
    async () => {
      const { userId, courseId, a1, quiz } = await setup();
      const result = await saveWeightsFor(t.db, userId, courseId, [
        { kind: "item", id: a1, percent: 20 },
        { kind: "item", id: quiz, percent: 12.5 },
        { kind: "new", name: "  Final exam ", percent: 67.5 },
      ]);
      expect(result).toEqual({ ok: true });

      const rows = await itemsOf(userId, courseId);
      expect(rows.map((r) => [r.name, r.short, r.weight, r.weightSource, r.max, r.score, r.position])).toEqual([
        ["Assignment 1", "A1", 0.2, "manual", 20, 17, 0],
        ["Week 3 quiz", "Q3", 0.125, "manual", 10, null, 1],
        ["Final exam", "Exam", 0.675, "manual", 100, null, 2],
      ]);
      expect(rows[2].moodleRef).toMatch(/^manual:[0-9a-f-]{36}$/);
    },
    SLOW,
  );

  it(
    "saved weights and the added piece survive syncGrades, even when Moodle sends other weights",
    async () => {
      const { userId, courseId, a1, quiz } = await setup();
      await saveWeightsFor(t.db, userId, courseId, [
        { kind: "item", id: a1, percent: 30 },
        { kind: "item", id: quiz, percent: 10 },
        { kind: "new", name: "Exam", percent: 60 },
      ]);

      const withWeights = () => [
        item(6101, "Assignment 1", { score: 18, weight: 0.5 }),
        item(6102, "Week 3 quiz", { max: 10, score: 9, weight: 0.5 }),
      ];
      await syncGrades(userId, t.db, fake(withWeights));

      const rows = await itemsOf(userId, courseId);
      expect(rows.map((r) => [r.name, r.score, r.weight, r.weightSource])).toEqual([
        ["Assignment 1", 18, 0.3, "manual"],
        ["Week 3 quiz", 9, 0.1, "manual"],
        ["Exam", null, 0.6, "manual"],
      ]);
    },
    SLOW,
  );

  it(
    "refuses a total that is not exactly 100 and saves nothing",
    async () => {
      const { userId, courseId, a1, quiz } = await setup();
      for (const [x, y] of [
        [20, 70],
        [50, 50.1],
        [33.3, 66.6],
      ]) {
        const result = await saveWeightsFor(t.db, userId, courseId, [
          { kind: "item", id: a1, percent: x },
          { kind: "item", id: quiz, percent: y },
        ]);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toContain("need to add up to 100%");
      }
      const rows = await itemsOf(userId, courseId);
      expect(rows.map((r) => [r.weight, r.weightSource])).toEqual([
        [null, null],
        [null, null],
      ]);
    },
    SLOW,
  );

  it(
    "refuses more than one decimal, negatives and empty names",
    async () => {
      const { userId, courseId, a1, quiz } = await setup();
      const bad = [
        [{ kind: "item", id: a1, percent: 20.05 }, { kind: "item", id: quiz, percent: 79.95 }],
        [{ kind: "item", id: a1, percent: -10 }, { kind: "item", id: quiz, percent: 110 }],
        [
          { kind: "item", id: a1, percent: 50 },
          { kind: "item", id: quiz, percent: 0 },
          { kind: "new", name: "  ", percent: 50 },
        ],
        [{ kind: "item", id: a1, percent: 50 }, { kind: "item", id: a1, percent: 50 }],
      ] as const;
      for (const rows of bad) {
        expect(await saveWeightsFor(t.db, userId, courseId, rows)).toEqual({
          ok: false,
          message: "Check the numbers and try again.",
        });
      }
      expect((await itemsOf(userId, courseId)).every((r) => r.weight === null)).toBe(true);
    },
    SLOW,
  );

  it(
    "refuses another user's course and another user's item",
    async () => {
      const { userId, courseId, a1, quiz } = await setup();
      const other = await otherUser();
      const NOT_HERS = { ok: false, message: "That course is not in your list any more." };

      // Her items, someone else's course.
      expect(
        await saveWeightsFor(t.db, userId, other.courseId, [
          { kind: "item", id: a1, percent: 50 },
          { kind: "item", id: quiz, percent: 50 },
        ]),
      ).toEqual(NOT_HERS);
      // Her course, someone else's item in it.
      expect(
        await saveWeightsFor(t.db, userId, courseId, [
          { kind: "item", id: a1, percent: 50 },
          { kind: "item", id: quiz, percent: 25 },
          { kind: "item", id: other.itemId, percent: 25 },
        ]),
      ).toEqual(NOT_HERS);
      // Someone else writing to her course.
      expect(
        await saveWeightsFor(t.db, other.userId, courseId, [
          { kind: "item", id: a1, percent: 50 },
          { kind: "item", id: quiz, percent: 50 },
        ]),
      ).toEqual(NOT_HERS);

      expect((await itemsOf(userId, courseId)).every((r) => r.weight === null)).toBe(true);
      const [theirs] = await t.db.select().from(gradeItems).where(eq(gradeItems.id, other.itemId));
      expect([theirs.weight, theirs.weightSource]).toEqual([null, null]);
    },
    SLOW,
  );

  it(
    "asks her to look again when the course has a piece the form did not list",
    async () => {
      const { userId, courseId, a1 } = await setup();
      const result = await saveWeightsFor(t.db, userId, courseId, [
        { kind: "item", id: a1, percent: 40 },
        { kind: "new", name: "Exam", percent: 60 },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("changed since you opened this");
      expect(await itemsOf(userId, courseId)).toHaveLength(2);
    },
    SLOW,
  );
});
