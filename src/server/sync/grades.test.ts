// @vitest-environment node
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, newToken } from "@/server/auth/session";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { gradeItems } from "@/server/db/schema/grades";
import { NotAllowed } from "@/server/moodle/client";
import { ALLOWED_SITES, connectWithKey } from "@/server/moodle/connect";
import { DEMO_KEY } from "@/server/moodle/fake-inline";
import type { GradeItemRow } from "@/server/moodle/read/grades";
import { NotConnected, syncCourses } from "./courses";
import { coursesForGrades, shortLabel, syncGrades, type SyncGradesDeps } from "./grades";

// Made-up values for tests only. The fake Moodle accepts DEMO_KEY and nothing else.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const AALTO = ALLOWED_SITES[0];
// The machine can be busy; a fresh database per test takes a while.
const SLOW = 90_000;
// The fake Moodle's user id (core_webservice_get_site_info sample).
const MOODLE_USER = 4242;

const NOV_2 = new Date("2026-11-02T10:00:00Z");
const NOV_9 = new Date("2026-11-09T10:00:00Z");

describe("shortLabel", () => {
  it.each([
    ["Assignment 1", "A1"],
    ["Assignment 2", "A2"],
    ["Assignment #3", "A3"],
    ["Assignment 04: Market analysis", "A4"],
    ["Assignment1", "A1"],
    ["Case 1", "C1"],
    ["Case memo 2", "M2"],
    ["Tehtävä 3", "T3"],
    ["Week 4 exercises", "W4"],
    ["Exam", "Exam"],
    ["Final exam", "Exam"],
    ["Exam 2", "Exam 2"],
    ["Exam (tentti) – Strategic IT", "Exam"],
    ["Tentti", "Exam"],
    ["Uusintatentti", "Exam"],
    ["Midterm exam", "Midterm"],
    ["Mid-term test", "Midterm"],
    ["Välitentti 1", "Midterm"],
    ["Quiz", "Quiz"],
    ["Quiz 4: ARIMA basics", "Q4"],
    ["Week 3 quiz", "Q3"],
    ["Quizzes", "Quiz"],
    ["Essay", "Essay"],
    ["Report", "Report"],
    ["Project", "Proj"],
    ["Project: final report", "Proj"],
    ["Presentation", "Pres"],
    ["Service blueprint", "SB"],
    ["Peer feedback forum", "PFF"],
    ["Final concept", "FC"],
    ["Pay attention", "PA"],
  ])("labels %j as %j", (name, label) => {
    expect(shortLabel(name)).toBe(label);
  });

  it("labels a Moodle quiz as a quiz whatever its name", () => {
    expect(shortLabel("ARIMA basics", "quiz")).toBe("Quiz");
    expect(shortLabel("Week 5: ARIMA", "quiz")).toBe("Q5");
    expect(shortLabel("ARIMA basics", "assign")).toBe("AB");
  });

  it("gives an empty name no label", () => {
    expect(shortLabel("")).toBeNull();
    expect(shortLabel("  ")).toBeNull();
    expect(shortLabel("–")).toBeNull();
  });
});

describe("syncGrades", () => {
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

  /** A user with the fake Moodle connected and its four courses (3101-3104) synced. */
  async function connectedUser(): Promise<string> {
    const { user } = await ensureSessionFor(t.db, newToken());
    const result = await connectWithKey(user.id, AALTO, DEMO_KEY, t.db);
    if (!result.ok) throw new Error("the fake Moodle rejected the demo key");
    await syncCourses(result.userId, t.db);
    return result.userId;
  }

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

  /** The sample course: graded, ungraded, a manual exam and a hidden item. */
  const SAMPLE = (): GradeItemRow[] => [
    item(6101, "Assignment 1", { score: 17, weight: 0.2, gradedAt: NOV_2 }),
    item(6102, "Week 3 quiz", { kind: "quiz", max: 10, score: 7.5, weight: 0.1, gradedAt: NOV_9 }),
    item(6103, "Midterm exam", { kind: "manual", max: 100, score: 62, weight: 0.3, gradedAt: NOV_9 }),
    item(6104, "Assignment 3"),
    item(6105, "Peer feedback", { kind: "other", max: 5, hidden: true }),
  ];

  /** Moodle's answers per course, which a test changes between syncs. `asked` records every call. */
  function fakeWith(start: Record<number, GradeItemRow[] | "not-allowed"> = { 3101: SAMPLE() }) {
    const moodle: Record<number, GradeItemRow[] | "not-allowed"> = { ...start };
    const asked: { course: number; user: number }[] = [];
    const deps: SyncGradesDeps = {
      getGradeItems: async (_conn, course, user) => {
        asked.push({ course, user });
        const answer = moodle[course] ?? [];
        if (answer === "not-allowed") throw new NotAllowed("gradereport_user_get_grade_items");
        return structuredClone(answer);
      },
    };
    return { moodle, asked, deps };
  }

  async function rowsOf(userId: string) {
    return t.db.select().from(gradeItems).where(eq(gradeItems.userId, userId)).orderBy(asc(gradeItems.moodleRef));
  }

  async function rowOf(userId: string, moodleRef: string) {
    const rows = await rowsOf(userId);
    const row = rows.find((r) => r.moodleRef === moodleRef);
    if (!row) throw new Error(`no row ${moodleRef}`);
    return row;
  }

  it("adds her items on the first sync, one Moodle call per visible course, hidden items left out", async () => {
    const userId = await connectedUser();
    await t.db.update(courses).set({ hidden: true }).where(eq(courses.moodleId, 3104));
    const { asked, deps } = fakeWith();

    expect(await syncGrades(userId, t.db, deps)).toEqual({ added: 4, updated: 0 });
    expect(asked).toEqual([3101, 3102, 3103].map((course) => ({ course, user: MOODLE_USER })));

    const [course] = await t.db.select().from(courses).where(eq(courses.moodleId, 3101));
    const rows = await rowsOf(userId);
    expect(
      rows.map((r) => [r.moodleRef, r.name, r.short, r.max, r.score, r.gradedAt, r.position, r.weight, r.weightSource]),
    ).toEqual([
      ["gradeitem:6101", "Assignment 1", "A1", 20, 17, NOV_2, 0, 0.2, "moodle"],
      ["gradeitem:6102", "Week 3 quiz", "Q3", 10, 7.5, NOV_9, 1, 0.1, "moodle"],
      ["gradeitem:6103", "Midterm exam", "Midterm", 100, 62, NOV_9, 2, 0.3, "moodle"],
      ["gradeitem:6104", "Assignment 3", "A3", 20, null, null, 3, null, null],
    ]);
    for (const r of rows) expect(r.courseId).toBe(course.id);
  }, SLOW);

  it("changes nothing on a second sync with the same answers", async () => {
    const userId = await connectedUser();
    const { deps } = fakeWith();
    await syncGrades(userId, t.db, deps);
    const before = await rowsOf(userId);

    expect(await syncGrades(userId, t.db, deps)).toEqual({ added: 0, updated: 0 });
    expect(await rowsOf(userId)).toEqual(before);
  }, SLOW);

  it("never overwrites a weight she typed, whatever Moodle says", async () => {
    const userId = await connectedUser();
    const { moodle, deps } = fakeWith();
    await syncGrades(userId, t.db, deps);
    // She types 25 % for Assignment 1 (Moodle says 20 %) and 40 % for Assignment 3 (Moodle has none).
    await t.db.update(gradeItems).set({ weight: 0.25, weightSource: "manual" }).where(eq(gradeItems.moodleRef, "gradeitem:6101"));
    await t.db.update(gradeItems).set({ weight: 0.4, weightSource: "manual" }).where(eq(gradeItems.moodleRef, "gradeitem:6104"));

    // Moodle now gives Assignment 3 a weight and changes Assignment 1's.
    moodle[3101] = SAMPLE().map((i) =>
      i.moodleRef === "gradeitem:6104" ? { ...i, weight: 0.1 } : i.moodleRef === "gradeitem:6101" ? { ...i, weight: 0.3 } : i,
    );
    expect(await syncGrades(userId, t.db, deps)).toEqual({ added: 0, updated: 0 });
    expect(await rowOf(userId, "gradeitem:6101")).toMatchObject({ weight: 0.25, weightSource: "manual" });
    expect(await rowOf(userId, "gradeitem:6104")).toMatchObject({ weight: 0.4, weightSource: "manual" });

    // The rest of the row still follows Moodle.
    moodle[3101] = SAMPLE().map((i) => (i.moodleRef === "gradeitem:6101" ? { ...i, score: 19, weight: null } : i));
    expect(await syncGrades(userId, t.db, deps)).toEqual({ added: 0, updated: 1 });
    expect(await rowOf(userId, "gradeitem:6101")).toMatchObject({ score: 19, weight: 0.25, weightSource: "manual" });
  }, SLOW);

  it("updates the row when she gets a new score", async () => {
    const userId = await connectedUser();
    const { moodle, deps } = fakeWith();
    await syncGrades(userId, t.db, deps);
    const before = await rowOf(userId, "gradeitem:6104");

    moodle[3101] = SAMPLE().map((i) => (i.moodleRef === "gradeitem:6104" ? { ...i, score: 15, gradedAt: NOV_9 } : i));
    expect(await syncGrades(userId, t.db, deps)).toEqual({ added: 0, updated: 1 });
    const after = await rowOf(userId, "gradeitem:6104");
    expect(after).toEqual({ ...before, score: 15, gradedAt: NOV_9 });
  }, SLOW);

  it("sets a weight Moodle starts to give with source 'moodle', and keeps it when Moodle stops sending it", async () => {
    const userId = await connectedUser();
    const { moodle, deps } = fakeWith();
    await syncGrades(userId, t.db, deps);
    expect(await rowOf(userId, "gradeitem:6104")).toMatchObject({ weight: null, weightSource: null });

    moodle[3101] = SAMPLE().map((i) => (i.moodleRef === "gradeitem:6104" ? { ...i, weight: 0.4 } : i));
    expect(await syncGrades(userId, t.db, deps)).toEqual({ added: 0, updated: 1 });
    expect(await rowOf(userId, "gradeitem:6104")).toMatchObject({ weight: 0.4, weightSource: "moodle" });

    // Moodle changes it: the row follows.
    moodle[3101] = SAMPLE().map((i) => (i.moodleRef === "gradeitem:6104" ? { ...i, weight: 0.35 } : i));
    await syncGrades(userId, t.db, deps);
    expect(await rowOf(userId, "gradeitem:6104")).toMatchObject({ weight: 0.35, weightSource: "moodle" });

    // The report stops showing the weight column: the last Moodle weight stays.
    moodle[3101] = SAMPLE().map((i) => ({ ...i, weight: null }));
    await syncGrades(userId, t.db, deps);
    expect(await rowOf(userId, "gradeitem:6104")).toMatchObject({ weight: 0.35, weightSource: "moodle" });
    expect(await rowOf(userId, "gradeitem:6101")).toMatchObject({ weight: 0.2, weightSource: "moodle" });
  }, SLOW);

  it("keeps items Moodle no longer lists or now hides, adds a hidden item once Moodle shows it, and follows Moodle's order", async () => {
    const userId = await connectedUser();
    const { moodle, deps } = fakeWith();
    await syncGrades(userId, t.db, deps);
    const gone = await rowOf(userId, "gradeitem:6103");
    const nowHidden = await rowOf(userId, "gradeitem:6101");

    // The midterm is removed, Assignment 1 is hidden, the peer feedback is shown, the quiz moves last.
    const [a1, quiz, , a3, peer] = SAMPLE();
    moodle[3101] = [{ ...a1, hidden: true, score: 0 }, a3, { ...peer, hidden: false }, quiz];
    expect(await syncGrades(userId, t.db, deps)).toEqual({ added: 1, updated: 2 });

    expect(await rowOf(userId, "gradeitem:6103")).toEqual(gone);
    expect(await rowOf(userId, "gradeitem:6101")).toEqual(nowHidden);
    expect(await rowOf(userId, "gradeitem:6105")).toMatchObject({ short: "PF", max: 5, position: 2 });
    expect((await rowOf(userId, "gradeitem:6104")).position).toBe(1);
    expect((await rowOf(userId, "gradeitem:6102")).position).toBe(3);
  }, SLOW);

  it("leaves a course as it is when her key may not read its grades, and still syncs the others", async () => {
    const userId = await connectedUser();
    const { moodle, deps } = fakeWith({ 3101: SAMPLE(), 3102: [item(6201, "Case 1", { score: 16, weight: 0.5 })] });
    await syncGrades(userId, t.db, deps);
    const before = await rowsOf(userId);
    expect(before).toHaveLength(5);

    moodle[3101] = "not-allowed";
    moodle[3102] = [item(6201, "Case 1", { score: 18, weight: 0.5 })];
    expect(await syncGrades(userId, t.db, deps)).toEqual({ added: 0, updated: 1 });
    const after = await rowsOf(userId);
    expect(after.filter((r) => r.moodleRef.startsWith("gradeitem:61"))).toEqual(
      before.filter((r) => r.moodleRef.startsWith("gradeitem:61")),
    );
    expect(await rowOf(userId, "gradeitem:6201")).toMatchObject({ short: "C1", score: 18 });
  }, SLOW);

  it("does not add an item with no range, and keeps the last range of one it has", async () => {
    const userId = await connectedUser();
    const { moodle, deps } = fakeWith({ 3101: [item(6101, "Assignment 1", { max: null }), item(6104, "Assignment 3")] });
    expect(await syncGrades(userId, t.db, deps)).toEqual({ added: 1, updated: 0 });
    expect((await rowsOf(userId)).map((r) => r.moodleRef)).toEqual(["gradeitem:6104"]);

    moodle[3101] = [item(6104, "Assignment 3", { max: null, score: 12 })];
    await syncGrades(userId, t.db, deps);
    expect(await rowOf(userId, "gradeitem:6104")).toMatchObject({ max: 20, score: 12 });
  }, SLOW);

  it("reads only the courses it is given", async () => {
    const userId = await connectedUser();
    const { asked, deps } = fakeWith({ 3101: SAMPLE(), 3103: [item(6301, "Essay")] });

    expect(await syncGrades(userId, t.db, deps, { courses: [3103] })).toEqual({ added: 1, updated: 0 });
    expect(asked.map((a) => a.course)).toEqual([3103]);
    expect((await rowsOf(userId)).map((r) => r.moodleRef)).toEqual(["gradeitem:6301"]);
    expect(await coursesForGrades(userId, t.db)).toEqual([3101, 3102, 3103, 3104]);
  }, SLOW);

  it("leaves another user's rows alone, even with the same Moodle item id", async () => {
    const userId = await connectedUser();
    // Someone else, on another site, whose grade item has the same Moodle id.
    const { user: other } = await ensureSessionFor(t.db, newToken());
    const [theirCourse] = await t.db
      .insert(courses)
      .values({ userId: other.id, moodleId: 3101, code: "X-1", name: "Their course", shortName: "Theirs", color: "mint" })
      .returning();
    await t.db.insert(gradeItems).values({
      userId: other.id,
      courseId: theirCourse.id,
      moodleRef: "gradeitem:6101",
      name: "Their essay",
      short: "Essay",
      max: 50,
      score: 40,
      weight: 0.9,
      weightSource: "manual",
    });
    const theirs = await rowsOf(other.id);

    const { deps } = fakeWith();
    await syncGrades(userId, t.db, deps);
    expect(await rowsOf(other.id)).toEqual(theirs);
    expect(await rowOf(userId, "gradeitem:6101")).toMatchObject({ name: "Assignment 1", score: 17 });
  }, SLOW);

  it("throws NotConnected for a user with no Moodle connection, without asking Moodle", async () => {
    const { user } = await ensureSessionFor(t.db, newToken());
    const { asked, deps } = fakeWith();
    await expect(syncGrades(user.id, t.db, deps)).rejects.toBeInstanceOf(NotConnected);
    expect(asked).toEqual([]);
  }, SLOW);
});
