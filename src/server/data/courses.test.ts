// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { lectureContent, lectures } from "@/server/db/schema/learn";
import { concepts, exams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import {
  coursesLine,
  endDateOf,
  getCoursePage,
  getCoursesList,
  lectureLine,
  numberWord,
  shortNameOf,
} from "./courses";

const DB_TIMEOUT = 30_000;
// Sun 15 Nov 2026, 12:00 in Helsinki.
const NOW = new Date("2026-11-15T10:00:00Z");
const at = (iso: string) => new Date(iso);

let t: TestDb;
let her: string;
let other: string;
let fc: string;

async function addCourse(userId: string, moodleId: number, name: string, extra: Partial<typeof courses.$inferInsert> = {}) {
  const [c] = await t.db
    .insert(courses)
    .values({ userId, moodleId, name, code: `C-${moodleId}`, ...extra })
    .returning();
  return c.id;
}

async function addLectures(userId: string, courseId: string, spec: { read?: boolean; opensAt?: string }[]) {
  const ids: string[] = [];
  for (const [i, s] of spec.entries()) {
    const [row] = await t.db
      .insert(lectures)
      .values({
        userId,
        courseId,
        n: i + 1,
        title: `Topic ${i + 1}`,
        readAt: s.read ? at("2026-11-01T08:00:00Z") : null,
        opensAt: s.opensAt ? at(s.opensAt) : null,
      })
      .returning();
    ids.push(row.id);
  }
  return ids;
}

beforeEach(async () => {
  t = await createTestDb();
  [{ id: her }, { id: other }] = await t.db.insert(users).values([{}, {}]).returning();
  fc = await addCourse(her, 1, "Forecasting Methods, Lecture, 1.9.2026-18.12.2026", { color: "sky" });
}, DB_TIMEOUT);
afterEach(async () => {
  await t.close();
});

describe("words", () => {
  it("uses number words up to twelve, then digits", () => {
    expect(numberWord(4)).toBe("four");
    expect(numberWord(12)).toBe("twelve");
    expect(numberWord(13)).toBe("13");
    expect(coursesLine(4)).toBe("Your four courses this period.");
    expect(coursesLine(1)).toBe("Your one course this period.");
  });

  it("keeps the part of a synced name before the first comma", () => {
    expect(shortNameOf("Forecasting Methods, Lecture, 1.9.2026-18.12.2026")).toBe("Forecasting Methods");
    expect(shortNameOf("Supply Chain Analytics")).toBe("Supply Chain Analytics");
    expect(endDateOf("Forecasting Methods, Lecture, 1.9.2026-18.12.2026")?.toISOString()).toBe("2026-12-18T10:00:00.000Z");
    expect(endDateOf("Supply Chain Analytics")).toBeNull();
  });

  it("names the first lecture not read, or says all are read", () => {
    expect(lectureLine([{ n: 1, state: "done" }, { n: 2, state: "cur" }, { n: 3, state: "up" }])).toBe("Lecture 2 of 3");
    expect(lectureLine([{ n: 1, state: "done" }, { n: 2, state: "done" }])).toBe("All 2 read");
    expect(lectureLine([])).toBe("No lectures found");
  });
});

describe("getCoursesList", () => {
  it("counts her visible courses and gives each its progress text", async () => {
    await addLectures(her, fc, [{ read: true }, { read: true }, { read: true }, {}, {}, { opensAt: "2026-11-23T08:00:00Z" }]);
    const sit = await addCourse(her, 2, "Strategic IT Management, Lecture, 1.9.2026-18.12.2026", { color: "mint" });
    await addLectures(her, sit, [{ read: true }, { read: true }]);
    await addCourse(her, 3, "Digital Service Design");
    await addCourse(her, 4, "Old Course", { hidden: true });
    const theirs = await addCourse(other, 5, "Someone Else's Course");
    await addLectures(other, theirs, [{ read: true }]);

    const list = await getCoursesList(her, { now: NOW }, t.db);
    expect(list.line).toBe("Your three courses this period.");
    expect(list.courses.map((c) => [c.short, c.code, c.lectureLine, c.readLine, c.progress])).toEqual([
      ["Digital Service Design", "C-3", "No lectures found", "", 0],
      ["Forecasting Methods", "C-1", "Lecture 4 of 6", "3 read", 0.5],
      ["Strategic IT Management", "C-2", "All 2 read", "2 read", 1],
    ]);
    expect(list.courses[1].href).toBe(`/courses/${fc}`);
    expect(list.courses[1].color).toBe("sky");
  });

  it("is empty for a user with no courses", async () => {
    const list = await getCoursesList(other, { now: NOW }, t.db);
    expect(list).toEqual({ line: "No courses this period yet.", courses: [] });
  });
});

describe("getCoursePage", () => {
  it("gives the lectures in order with the current stop, flags and a plain finish", async () => {
    const [l1] = await addLectures(her, fc, [{ read: true }, {}, {}, { opensAt: "2026-11-23T08:00:00Z" }]);
    await t.db.insert(lectureContent).values({
      lectureId: l1,
      breath: "Signal, noise and why the past is a guide. Then more detail.",
      sourceHash: "h",
    });
    await t.db.insert(assignments).values([
      { userId: her, courseId: fc, moodleId: 11, name: "Assignment 3", dueAt: at("2026-11-15T19:00:00Z") },
      { userId: her, courseId: fc, moodleId: 12, name: "Case 1", dueAt: at("2026-10-01T19:00:00Z"), state: "submitted" },
      { userId: her, courseId: fc, moodleId: 13, name: "Report", dueAt: null },
    ]);

    const page = await getCoursePage(her, fc, { now: NOW }, t.db);
    expect(page).not.toBeNull();
    expect(page!.name).toBe("Forecasting Methods");
    expect(page!.code).toBe("C-1");
    expect(page!.stats).toEqual(["Lecture 2 of 4"]);
    expect(page!.files).toEqual([]);
    const path = page!.path!;
    expect(path.lectures.map((l) => [l.n, l.state, l.opens])).toEqual([
      [1, "done", null],
      [2, "cur", null],
      [3, "up", null],
      [4, "soon", "Mon 23 Nov"],
    ]);
    expect(path.lectures[0].line).toBe("Signal, noise and why the past is a guide.");
    expect(path.lectures[1].line).toBe("");
    expect(path.lectures[1].href).toBe(`/courses/${fc}/lectures/2`);
    // The last dated deadline is the finish; the rest are flags.
    expect(path.finish).toEqual({ text: "Assignment 3 · due today 21:00", exam: null, tone: "sky", href: null });
    expect(path.flags.map((f) => [f.text, f.tone])).toEqual([
      ["Case 1 · handed in", "mint"],
      ["Report · due date to come", "butter"],
    ]);
  });

  it("shows the exam's forecast in a chip and on the finish when the exam has concepts", async () => {
    await addLectures(her, fc, [{ read: true }, { read: true }]);
    const [exam] = await t.db
      .insert(exams)
      .values({ userId: her, courseId: fc, title: "Exam", kind: "exam", at: at("2026-11-20T07:00:00Z") })
      .returning();

    let page = await getCoursePage(her, fc, { now: NOW }, t.db);
    expect(page!.stats).toEqual(["All 2 read"]);
    expect(page!.path!.finish).toEqual({
      text: "Exam · Fri 20 Nov 09:00",
      exam: null,
      tone: "blush",
      href: `/exams/${exam.id}`,
    });

    await t.db.insert(concepts).values({ userId: her, examId: exam.id, name: "Smoothing" });
    page = await getCoursePage(her, fc, { now: NOW }, t.db);
    expect(page!.stats).toEqual(["All 2 read", "0% forecast for the exam"]);
    expect(page!.path!.finish.exam).toEqual({ id: exam.id, forecast: 0 });
  });

  it("falls back to her course files when no lectures were recognised", async () => {
    const [a] = await t.db
      .insert(assignments)
      .values({ userId: her, courseId: fc, moodleId: 21, name: "Brief", dueAt: null })
      .returning();
    await t.db.insert(courseFiles).values([
      { userId: her, courseId: fc, moodleRef: "r2", name: "week-2.pdf", section: "Week 2", url: "https://x/2" },
      { userId: her, courseId: fc, moodleRef: "r1", name: "week-1.pdf", section: "Week 1", url: "https://x/1" },
      { userId: her, courseId: fc, moodleRef: "r3", name: "brief.pdf", url: "https://x/3", assignmentId: a.id },
    ]);
    const page = await getCoursePage(her, fc, { now: NOW }, t.db);
    expect(page!.path).toBeNull();
    expect(page!.stats).toEqual([]);
    expect(page!.files.map((f) => [f.name, f.section])).toEqual([
      ["week-1.pdf", "Week 1"],
      ["week-2.pdf", "Week 2"],
    ]);
  });

  it("gives null for another user's course, a hidden one, an unknown id and a malformed id", async () => {
    const hidden = await addCourse(her, 9, "Hidden", { hidden: true });
    const theirs = await addCourse(other, 10, "Theirs");
    await addLectures(other, theirs, [{}]);
    expect(await getCoursePage(her, theirs, { now: NOW }, t.db)).toBeNull();
    expect(await getCoursePage(her, hidden, { now: NOW }, t.db)).toBeNull();
    expect(await getCoursePage(her, "00000000-0000-4000-8000-000000000000", { now: NOW }, t.db)).toBeNull();
    expect(await getCoursePage(her, "not-an-id", { now: NOW }, t.db)).toBeNull();
  });
});
