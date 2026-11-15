// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { lectureConcepts, lectureContent, lectures } from "@/server/db/schema/learn";
import { concepts, exams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { saveNote } from "@/server/notes/store";
import { getExamTabs } from "./exam-tabs";
import { cardDate } from "./note-cards";

const DB_TIMEOUT = 30_000;
// Sun 15 Nov 2026, 12:00 in Helsinki.
const NOW = new Date("2026-11-15T10:00:00Z");
const at = (iso: string) => new Date(iso);

let t: TestDb;
let her: string;
let other: string;
let course: string;
let exam: string;
let lec: string[];

beforeEach(async () => {
  t = await createTestDb();
  [{ id: her }, { id: other }] = await t.db.insert(users).values([{}, {}]).returning();
  [{ id: course }] = await t.db
    .insert(courses)
    .values({ userId: her, moodleId: 1, name: "Supply Basics, Lecture, 1.9.2026-18.12.2026" })
    .returning();
  const rows = await t.db
    .insert(lectures)
    .values([
      { userId: her, courseId: course, n: 1, title: "Intro", readAt: at("2026-11-01T08:00:00Z") },
      { userId: her, courseId: course, n: 2, title: "Sourcing and vendors" },
      { userId: her, courseId: course, n: 3, title: "Stock" },
      { userId: her, courseId: course, n: 4, title: "Late one", opensAt: at("2026-11-16T08:00:00Z") },
    ])
    .returning();
  lec = rows.sort((a, b) => a.n - b.n).map((r) => r.id);
  await t.db.insert(lectureContent).values([
    { lectureId: lec[0], minutes: 6, sourceHash: "a" },
    { lectureId: lec[1], minutes: 4, sourceHash: "b" },
  ]);
  [{ id: exam }] = await t.db
    .insert(exams)
    .values({ userId: her, courseId: course, title: "Exam", kind: "exam", at: at("2026-11-20T07:00:00Z") })
    .returning();
}, DB_TIMEOUT);

const tabs = (userId = her) =>
  getExamTabs(userId, { examId: exam, courseId: course, courseName: "Supply Basics", now: NOW }, t.db);

describe("getExamTabs: lectures", () => {
  it(
    "lists every lecture of the course while no concept is tied to one",
    async () => {
      const { lectures: l } = await tabs();
      expect(l.courseId).toBe(course);
      expect(l.rows.map((r) => [r.n, r.state])).toEqual([
        [1, "done"],
        [2, "cur"],
        [3, "up"],
        [4, "soon"],
      ]);
      expect(l.rows[0]).toMatchObject({ minutes: 6, concepts: "", opensOn: null });
      expect(l.rows[3]).toMatchObject({ minutes: null, opensOn: "Mon 16 Nov" });
      expect(l.rows[1].href).toBe(`/courses/${course}/lectures/2`);
      expect(l.current).toEqual({ n: 2, href: `/courses/${course}/lectures/2` });
    },
    DB_TIMEOUT,
  );

  it(
    "keeps the lectures this exam's concepts come from, with their names",
    async () => {
      const [, , c] = await t.db
        .insert(concepts)
        .values([
          { userId: her, examId: exam, name: "Vendor choice", lecture: "Lecture 2", position: 0 },
          { userId: her, examId: exam, name: "Contracts", lecture: "Lecture 2", position: 1 },
          { userId: her, examId: exam, name: "Basics", lecture: null, position: 2 },
        ])
        .returning();
      // A link through lecture_concepts counts too.
      await t.db.insert(lectureConcepts).values({ lectureId: lec[0], conceptId: c.id });
      const { lectures: l } = await tabs();
      expect(l.rows.map((r) => [r.n, r.concepts])).toEqual([
        [1, "Basics"],
        [2, "Vendor choice, Contracts"],
      ]);
    },
    DB_TIMEOUT,
  );

  it(
    "never shows another user's lectures or concepts",
    async () => {
      await expect(tabs(other)).rejects.toThrow();
    },
    DB_TIMEOUT,
  );
});

describe("getExamTabs: notes", () => {
  it(
    "has the course's notes and this exam's, newest first, with their pills",
    async () => {
      await saveNote(her, { body: "From lecture 2", attach: { kind: "lecture", id: lec[1] } }, at("2026-11-10T08:00:00Z"), t.db);
      await saveNote(her, { body: "On the exam", attach: { kind: "exam", id: exam } }, NOW, t.db);
      await saveNote(her, { body: "General one" }, NOW, t.db);
      const { notes } = await tabs();
      expect(notes.map((n) => [n.body, n.attachLabel, n.date])).toEqual([
        ["On the exam", "Exam · Supply Basics", "TODAY"],
        ["From lecture 2", "Lecture 2 · Sourcing and vendors", "TUE 10 NOV"],
      ]);
    },
    DB_TIMEOUT,
  );
});

describe("cardDate", () => {
  it("says TODAY or the day in capitals", () => {
    expect(cardDate(NOW, NOW)).toBe("TODAY");
    expect(cardDate(at("2026-11-12T10:00:00Z"), NOW)).toBe("THU 12 NOV");
  });
});
