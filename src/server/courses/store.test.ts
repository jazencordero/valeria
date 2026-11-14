// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { lectureConcepts, lectures } from "@/server/db/schema/learn";
import { cardConcepts, cards, concepts, exams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { CourseNotFound, courseView, listCourses, markRead } from "./store";

const DB_TIMEOUT = 30_000;
const NOW = new Date("2026-11-15T10:00:00Z");
const at = (iso: string) => new Date(iso);

let t: TestDb;
let her: string;
let other: string;
let course: string;
/** Lecture ids by number. */
let L: Record<number, string>;

beforeEach(async () => {
  t = await createTestDb();
  [{ id: her }, { id: other }] = await t.db.insert(users).values([{}, {}]).returning();
  [{ id: course }] = await t.db
    .insert(courses)
    .values({ userId: her, moodleId: 3101, name: "Forecasting Methods", code: "FC-101", color: "sky" })
    .returning();

  // Lectures 1-4 posted a week apart (the file's modified time); 5 opens after NOW.
  L = {};
  for (const [n, posted] of [
    [1, "2026-09-02T08:00:00Z"],
    [2, "2026-09-09T08:00:00Z"],
    [3, "2026-09-16T08:00:00Z"],
    [4, "2026-09-23T08:00:00Z"],
  ] as const) {
    const [file] = await t.db
      .insert(courseFiles)
      .values({
        userId: her,
        courseId: course,
        moodleRef: `cm:71${n}1:lecture-0${n}.pdf`,
        name: `lecture-0${n}.pdf`,
        url: `https://moodle.example.edu/${n}.pdf`,
        modifiedAt: at(posted),
      })
      .returning();
    const [row] = await t.db
      .insert(lectures)
      .values({ userId: her, courseId: course, n, title: `Topic ${n}`, fileId: file.id })
      .returning();
    L[n] = row.id;
  }
  const [five] = await t.db
    .insert(lectures)
    .values({ userId: her, courseId: course, n: 5, title: "Topic 5", opensAt: at("2026-11-20T08:00:00Z") })
    .returning();
  L[5] = five.id;
}, DB_TIMEOUT);
afterEach(async () => {
  await t.close();
});

async function addAssignment(name: string, dueAt: Date | null, moodleId: number, state: "open" | "graded" = "open") {
  const [a] = await t.db
    .insert(assignments)
    .values({ userId: her, courseId: course, moodleId, name, dueAt, state })
    .returning();
  return a.id;
}

describe("courseView", () => {
  it("gives each lecture its state; marking the current one read makes the next one current", async () => {
    let view = await courseView(her, course, t.db, NOW);
    expect(view.course).toEqual({ id: course, name: "Forecasting Methods", code: "FC-101", shortName: null, color: "sky" });
    expect(view.lectures.map((l) => [l.n, l.title, l.state])).toEqual([
      [1, "Topic 1", "cur"],
      [2, "Topic 2", "up"],
      [3, "Topic 3", "up"],
      [4, "Topic 4", "up"],
      [5, "Topic 5", "soon"],
    ]);
    expect(view.lectures[0].postedAt).toEqual(at("2026-09-02T08:00:00Z"));
    expect(view.lectures[4].postedAt).toEqual(at("2026-11-20T08:00:00Z"));

    const first = await markRead(her, L[1], t.db, NOW);
    expect(first).toEqual({ id: L[1], readAt: NOW });
    view = await courseView(her, course, t.db, NOW);
    expect(view.lectures.map((l) => l.state)).toEqual(["done", "cur", "up", "up", "soon"]);
    expect(view.lectures[0].readAt).toEqual(NOW);

    // Reading lecture 3 out of order: 2 stays current.
    await markRead(her, L[3], t.db, NOW);
    view = await courseView(her, course, t.db, NOW);
    expect(view.lectures.map((l) => l.state)).toEqual(["done", "cur", "done", "up", "soon"]);

    // Once lecture 5 opens it joins the path.
    view = await courseView(her, course, t.db, at("2026-11-21T08:00:00Z"));
    expect(view.lectures.map((l) => l.state)).toEqual(["done", "cur", "done", "up", "up"]);
  }, DB_TIMEOUT);

  it("places each deadline after the last lecture posted by its due date, and finishes at the exam", async () => {
    const early = await addAssignment("Warm-up quiz", at("2026-09-01T20:00:00Z"), 9001);
    const a1 = await addAssignment("Assignment 1", at("2026-09-10T20:00:00Z"), 9002, "graded");
    const sameDay = await addAssignment("Assignment 2", at("2026-09-23T08:00:00Z"), 9003);
    const late = await addAssignment("Assignment 3", at("2026-12-01T20:00:00Z"), 9004);
    const undated = await addAssignment("Project", null, 9005);
    const [final] = await t.db
      .insert(exams)
      .values({ userId: her, courseId: course, title: "Final exam", at: at("2026-12-10T09:00:00Z") })
      .returning();
    await t.db
      .insert(exams)
      .values({ userId: her, courseId: course, title: "Quiz 2", kind: "quiz", at: at("2026-10-10T09:00:00Z") });

    const view = await courseView(her, course, t.db, NOW);
    expect(view.flags.map((f) => [f.after, f.assignmentId])).toEqual([
      // Due before any lecture was posted: after the first one.
      [1, early],
      // Lecture 2 was posted on 9 Sep, lecture 3 only on 16 Sep.
      [2, a1],
      // Lecture 4 was posted the moment it was due: that counts.
      [4, sameDay],
      // Due after lecture 5 opens: after 5. No due date: after the last lecture, behind the dated one.
      [5, late],
      [5, undated],
    ]);
    expect(view.flags[1]).toEqual({
      after: 2,
      kind: "deadline",
      assignmentId: a1,
      title: "Assignment 1",
      dueAt: at("2026-09-10T20:00:00Z"),
      state: "graded",
    });
    expect(view.finish).toEqual({
      kind: "exam",
      examId: final.id,
      title: "Final exam",
      examKind: "exam",
      at: at("2026-12-10T09:00:00Z"),
    });
  }, DB_TIMEOUT);

  it("with no exam, finishes at the last dated deadline and leaves it out of the flags", async () => {
    const a1 = await addAssignment("Assignment 1", at("2026-09-10T20:00:00Z"), 9002);
    const last = await addAssignment("Project", at("2026-12-01T20:00:00Z"), 9003);
    const view = await courseView(her, course, t.db, NOW);
    expect(view.flags.map((f) => [f.after, f.assignmentId])).toEqual([[2, a1]]);
    expect(view.finish).toEqual({
      kind: "deadline",
      assignmentId: last,
      title: "Project",
      at: at("2026-12-01T20:00:00Z"),
      state: "open",
    });

    await t.db.delete(assignments);
    expect((await courseView(her, course, t.db, NOW)).finish).toBeNull();
  }, DB_TIMEOUT);

  it("counts each lecture's active cards once, through its concepts", async () => {
    const [exam] = await t.db
      .insert(exams)
      .values({ userId: her, courseId: course, title: "Final", at: at("2026-12-10T09:00:00Z") })
      .returning();
    const [c1, c2] = await t.db
      .insert(concepts)
      .values([
        { userId: her, examId: exam.id, name: "Trend" },
        { userId: her, examId: exam.id, name: "Seasonality" },
      ])
      .returning();
    await t.db.insert(lectureConcepts).values([
      { lectureId: L[1], conceptId: c1.id },
      { lectureId: L[1], conceptId: c2.id },
      { lectureId: L[2], conceptId: c2.id },
    ]);
    const card = async (hash: string, status: "active" | "suspended" = "active") => {
      const [k] = await t.db
        .insert(cards)
        .values({ userId: her, examId: exam.id, type: "basic", body: {}, origin: "ai", contentHash: hash, status })
        .returning();
      return k.id;
    };
    const both = await card("k1");
    const one = await card("k2");
    const off = await card("k3", "suspended");
    await t.db.insert(cardConcepts).values([
      { cardId: both, conceptId: c1.id },
      { cardId: both, conceptId: c2.id },
      { cardId: one, conceptId: c1.id },
      { cardId: off, conceptId: c1.id },
    ]);

    const view = await courseView(her, course, t.db, NOW);
    expect(view.lectures.map((l) => [l.n, l.cards])).toEqual([
      [1, 2],
      [2, 1],
      [3, 0],
      [4, 0],
      [5, 0],
    ]);
  }, DB_TIMEOUT);

  it("refuses another user's course and lecture", async () => {
    await expect(courseView(other, course, t.db, NOW)).rejects.toBeInstanceOf(CourseNotFound);
    await expect(courseView(her, "not-a-uuid", t.db, NOW)).rejects.toBeInstanceOf(CourseNotFound);
    await expect(markRead(other, L[1], t.db, NOW)).rejects.toBeInstanceOf(CourseNotFound);
    await expect(markRead(her, "not-a-uuid", t.db, NOW)).rejects.toBeInstanceOf(CourseNotFound);
    const [row] = await t.db.select().from(lectures).where(eq(lectures.id, L[1]));
    expect(row.readAt).toBeNull();
  }, DB_TIMEOUT);
});

describe("markRead", () => {
  it("keeps the first time she read it", async () => {
    await markRead(her, L[2], t.db, NOW);
    const later = new Date(NOW.getTime() + 60_000);
    expect(await markRead(her, L[2], t.db, later)).toEqual({ id: L[2], readAt: NOW });
  }, DB_TIMEOUT);
});

describe("listCourses", () => {
  it("lists her visible courses by name with read / posted progress", async () => {
    await t.db.insert(courses).values([
      { userId: her, moodleId: 3102, name: "Accounting Basics" },
      { userId: her, moodleId: 3103, name: "Hidden course", hidden: true },
      { userId: other, moodleId: 3101, name: "Their course" },
    ]);
    expect((await listCourses(her, t.db, NOW)).map((c) => [c.name, c.lectures, c.posted, c.read, c.progress])).toEqual([
      ["Accounting Basics", 0, 0, 0, 0],
      ["Forecasting Methods", 5, 4, 0, 0],
    ]);

    await markRead(her, L[1], t.db, NOW);
    const [, forecasting] = await listCourses(her, t.db, NOW);
    expect(forecasting).toMatchObject({ id: course, color: "sky", lectures: 5, posted: 4, read: 1, progress: 0.25 });

    expect((await listCourses(other, t.db, NOW)).map((c) => c.name)).toEqual(["Their course"]);
  }, DB_TIMEOUT);
});
