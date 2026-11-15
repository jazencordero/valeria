// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeMoodle, type FakeMoodle } from "../../../tests/fake-moodle/server";
import { saveWeightsFor } from "@/app/(app)/grades/actions";
import { ensureSessionFor, newToken } from "@/server/auth/session";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { gradeItems } from "@/server/db/schema/grades";
import { ALLOWED_SITES, connectWithKey } from "@/server/moodle/connect";
import { DEMO_KEY } from "@/server/moodle/fake-inline";
import { getGradeItems, type GradeItemRow } from "@/server/moodle/read/grades";
import { syncCourses } from "@/server/sync/courses";
import { syncGrades, type SyncGradesDeps } from "@/server/sync/grades";
import {
  getCourseGrades,
  getGradesList,
  percentOf,
  saveTargetFor,
  statusOf,
  targetOf,
} from "./grades";

// Made-up values for tests only. The fake Moodle accepts DEMO_KEY and nothing else.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const AALTO = ALLOWED_SITES[0];
// The machine can be busy; a fresh database per test takes a while.
const SLOW = 90_000;

describe("statusOf", () => {
  const it3 = (a: number | null, b: number | null, w: number | null = 0.5) => [
    { id: "a", weight: 0.5, score: a },
    { id: "b", weight: w, score: b },
  ];
  it.each([
    ["no items", [], 5, "early"],
    // Nothing graded still has a verdict: about 90% is needed on everything for a 5.
    ["nothing graded", it3(null, null), 5, "within"],
    ["a weight missing", it3(80, null, null), 5, "needs_weights"],
    ["on track", it3(90, null), 5, "on"],
    ["everything graded", it3(90, 70), 5, "on"],
    ["within reach", it3(80, null), 5, "within"],
    ["out of reach", it3(60, null), 5, "out"],
  ] as const)("%s", (_label, items, target, status) => {
    expect(statusOf(items, target)).toBe(status);
  });

  it("reads a score as a percent of its range, and a stored target as a whole grade", () => {
    expect(percentOf(17, 20)).toBe(85);
    expect(percentOf(null, 20)).toBeNull();
    expect(percentOf(3, 0)).toBeNull();
    expect([targetOf(3), targetOf(0), targetOf(7), targetOf(2.5)]).toEqual([3, 5, 5, 5]);
  });
});

describe("grades data", () => {
  let t: TestDb;
  let moodle: FakeMoodle;

  beforeEach(async () => {
    vi.stubEnv("MOODLE_FAKE", "1");
    vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
    t = await createTestDb();
    moodle = await startFakeMoodle();
  }, SLOW);
  afterEach(async () => {
    vi.unstubAllEnvs();
    await moodle.close();
    await t.close();
  });

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

  /** The other three sample courses, made up so each status shows once (target 5). */
  const OTHERS: Record<number, GradeItemRow[]> = {
    // Strategic IT: 90% on half, so 90% is needed on the rest: on track.
    3102: [item(7201, "Case 1", { score: 18, weight: 0.5 }), item(7202, "Exam", { kind: "manual", max: 100, weight: 0.5 })],
    // Supply Chain: 75% on 40%, so 100% is needed on the rest: within reach.
    3103: [item(7301, "Assignment 1", { score: 15, weight: 0.4 }), item(7302, "Exam", { kind: "manual", max: 100, weight: 0.6 })],
    // Digital Service Design: nothing graded yet: within reach (90% needed on all of it), no number yet.
    3104: [item(7401, "Service blueprint", { weight: 0.5 }), item(7402, "Final concept", { weight: 0.5 })],
  };

  /**
   * A user with the fake Moodle connected, its four courses (3101-3104)
   * synced, and grades synced by `syncGrades`: course 3101 reads the sample
   * (tests/fixtures/moodle-sample) over HTTP through the real reader.
   */
  async function seeded(): Promise<{ userId: string; ids: Record<number, string> }> {
    const { user } = await ensureSessionFor(t.db, newToken());
    const result = await connectWithKey(user.id, AALTO, DEMO_KEY, t.db);
    if (!result.ok) throw new Error("the fake Moodle rejected the demo key");
    await syncCourses(result.userId, t.db);

    vi.stubEnv("MOODLE_FAKE", "0");
    const sample = { siteUrl: moodle.url, token: moodle.token };
    const deps: SyncGradesDeps = {
      getGradeItems: async (_conn, course, moodleUser) =>
        course === 3101 ? getGradeItems(sample, course, moodleUser) : structuredClone(OTHERS[course] ?? []),
    };
    await syncGrades(result.userId, t.db, deps);
    vi.stubEnv("MOODLE_FAKE", "1");

    const rows = await t.db.select({ id: courses.id, moodleId: courses.moodleId }).from(courses).where(eq(courses.userId, result.userId));
    return { userId: result.userId, ids: Object.fromEntries(rows.map((r) => [r.moodleId, r.id])) };
  }

  /** She types the weight the sample leaves out (Assignment 3), as on the weights form. */
  async function fixWeights(userId: string, courseId: string) {
    const page = await getCourseGrades(userId, courseId, t.db);
    const pct: Record<string, number> = { "Assignment 1": 20, "Week 3 quiz": 10, "Midterm exam": 30, "Assignment 3": 40 };
    const saved = await saveWeightsFor(
      t.db,
      userId,
      courseId,
      page!.items.map((it) => ({ kind: "item" as const, id: it.id, percent: pct[it.name] })),
    );
    expect(saved).toEqual({ ok: true });
  }

  it("lists one row per course with its status, and the overall number", async () => {
    const { userId, ids } = await seeded();
    // As synced, the sample course misses a weight: it says so and stays out of the overall.
    let list = await getGradesList(userId, t.db);
    expect(list.courses.map((c) => [c.name, c.status, c.target, c.trajectory])).toEqual([
      ["Digital Service Design", "within", 5, null],
      ["Forecasting Methods", "needs_weights", 5, null],
      ["Strategic IT Management", "on", 5, 5],
      ["Supply Chain Analytics", "within", 5, 3.5],
    ]);
    expect(list.overall).toBeCloseTo((5 + 3.5) / 2, 9);
    expect(list.courses[1]).toMatchObject({ id: ids[3101], href: `/grades/${ids[3101]}`, color: expect.any(String) });

    await fixWeights(userId, ids[3101]);
    list = await getGradesList(userId, t.db);
    const fc = list.courses.find((c) => c.id === ids[3101])!;
    // 85% at 20, 75% at 10, 62% at 30: 71.8% so far, filled in for Assignment 3: 3.18.
    expect(fc.status).toBe("out");
    expect(fc.trajectory).toBeCloseTo(3.1833, 3);
    expect(list.overall).toBeCloseTo((3.18333333 + 5 + 3.5) / 3, 6);
    expect(list.courses.map((c) => c.status)).toEqual(["within", "out", "on", "within"]);
  }, SLOW);

  it("loads one course's items in report order, scores as percents, hidden items left out", async () => {
    const { userId, ids } = await seeded();
    const page = await getCourseGrades(userId, ids[3101], t.db);
    expect(page?.course).toMatchObject({ id: ids[3101], name: "Forecasting Methods", code: expect.any(String), target: 5 });
    expect(page?.items.map((i) => [i.name, i.short, i.score, i.weight])).toEqual([
      ["Assignment 1", "A1", 85, 0.2],
      ["Week 3 quiz", "Q3", 75, 0.1],
      ["Midterm exam", "Midterm", 62, 0.3],
      ["Assignment 3", "A3", null, null],
    ]);
    expect(page?.needsWeights).toBe(true);

    await fixWeights(userId, ids[3101]);
    expect((await getCourseGrades(userId, ids[3101], t.db))?.needsWeights).toBe(false);
    // Another course's items do not leak in.
    expect((await getCourseGrades(userId, ids[3102], t.db))?.items.map((i) => i.name)).toEqual(["Case 1", "Exam"]);
  }, SLOW);

  it("leaves out hidden courses and other users' courses", async () => {
    const { userId, ids } = await seeded();
    await t.db.update(courses).set({ hidden: true }).where(eq(courses.id, ids[3104]));
    const { user: other } = await ensureSessionFor(t.db, newToken());

    expect((await getGradesList(userId, t.db)).courses.map((c) => c.id)).not.toContain(ids[3104]);
    expect(await getCourseGrades(userId, ids[3104], t.db)).toBeNull();
    expect(await getCourseGrades(other.id, ids[3101], t.db)).toBeNull();
    expect(await getCourseGrades(userId, "not-a-uuid", t.db)).toBeNull();
    expect(await getCourseGrades(userId, "00000000-0000-4000-8000-000000000000", t.db)).toBeNull();
    expect(await getGradesList(other.id, t.db)).toEqual({ overall: null, courses: [] });
  }, SLOW);

  it("saves her target per course, and it is there on the next load", async () => {
    const { userId, ids } = await seeded();
    await fixWeights(userId, ids[3101]);

    expect(await saveTargetFor(t.db, userId, ids[3101], 3)).toEqual({ ok: true });
    expect((await getCourseGrades(userId, ids[3101], t.db))?.course.target).toBe(3);
    const row = (await getGradesList(userId, t.db)).courses.find((c) => c.id === ids[3101]);
    // 67% needed on what is left, 71.8% so far: on track for a 3.
    expect(row).toMatchObject({ target: 3, status: "on" });
    // Only that course changed.
    expect((await getCourseGrades(userId, ids[3102], t.db))?.course.target).toBe(5);

    for (const bad of [0, 6, 2.5, Number.NaN]) {
      expect((await saveTargetFor(t.db, userId, ids[3101], bad)).ok).toBe(false);
    }
    const { user: other } = await ensureSessionFor(t.db, newToken());
    expect((await saveTargetFor(t.db, other.id, ids[3101], 1)).ok).toBe(false);
    expect((await saveTargetFor(t.db, userId, "not-a-uuid", 1)).ok).toBe(false);
    expect((await getCourseGrades(userId, ids[3101], t.db))?.course.target).toBe(3);
    // The sync left every grade row alone while she changed targets.
    expect(await t.db.select().from(gradeItems).where(eq(gradeItems.userId, userId))).toHaveLength(10);
  }, SLOW);
  it("works nothing out for a course whose parts were seeded by hand in points", async () => {
    const { userId, ids } = await seeded();
    // The on-track course (3102), as a hand-seeded course would hold it: parts from a syllabus,
    // marked in points (an exam out of 80, exercises out of 30), weights known, nothing graded.
    await t.db.delete(gradeItems).where(eq(gradeItems.courseId, ids[3102]));
    await t.db.insert(gradeItems).values([
      { userId, courseId: ids[3102], moodleRef: "seed:aaaaaaaaaaaaaaaaaaaaaaaa", name: "Invented exam", weight: 0.73, weightSource: "manual", max: 80, position: 1 },
      { userId, courseId: ids[3102], moodleRef: "seed:bbbbbbbbbbbbbbbbbbbbbbbb", name: "Invented exercises", weight: 0.27, weightSource: "manual", max: 30, position: 2 },
    ]);

    const page = await getCourseGrades(userId, ids[3102], t.db);
    expect(page).toMatchObject({ weightsOnly: true, needsWeights: false });
    expect(page!.items.map((it) => [it.name, it.weight])).toEqual([
      ["Invented exam", 0.73],
      ["Invented exercises", 0.27],
    ]);
    const row = (await getGradesList(userId, t.db)).courses.find((c) => c.id === ids[3102])!;
    // Its page offers no target, so the row names none ("aiming for 5" would be a target she never saw).
    expect(row).toMatchObject({ status: "early", trajectory: null, target: null });

    // A hand-seeded course in percent (every part out of 100) and a synced course are worked out as before.
    await t.db.update(gradeItems).set({ max: 100 }).where(eq(gradeItems.courseId, ids[3102]));
    expect((await getCourseGrades(userId, ids[3102], t.db))!.weightsOnly).toBe(false);
    expect((await getCourseGrades(userId, ids[3103], t.db))!.weightsOnly).toBe(false);
  }, SLOW);
});
