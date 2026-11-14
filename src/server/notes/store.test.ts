// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { lectures, notes } from "@/server/db/schema/learn";
import { exams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import {
  countNotes,
  deleteNote,
  getNote,
  listNotes,
  NoteNotFound,
  notesForLecture,
  saveNote,
  type NoteInput,
} from "./store";

const DB_TIMEOUT = 30_000;
const NOW = new Date("2026-11-14T10:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

let t: TestDb;
let her: string;
let other: string;
let courseId: string;
let otherCourseId: string;
let lectureId: string;
let assignmentId: string;
let examId: string;
let theirCourseId: string;
let theirLectureId: string;

async function makeUser(): Promise<string> {
  const [u] = await t.db.insert(users).values({}).returning();
  return u.id;
}

async function makeCourse(userId: string, moodleId: number, name: string): Promise<string> {
  const [c] = await t.db.insert(courses).values({ userId, moodleId, name }).returning();
  return c.id;
}

async function makeLecture(userId: string, course: string, n: number, title: string): Promise<string> {
  const [l] = await t.db.insert(lectures).values({ userId, courseId: course, n, title }).returning();
  return l.id;
}

async function save(userId: string, note: NoteInput, minutes = 0) {
  return saveNote(userId, note, at(minutes), t.db);
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
  courseId = await makeCourse(her, 1, "Strategic IT Management");
  otherCourseId = await makeCourse(her, 2, "Forecasting Methods");
  lectureId = await makeLecture(her, courseId, 5, "Sourcing and vendors");
  const [a] = await t.db
    .insert(assignments)
    .values({ userId: her, courseId, moodleId: 10, name: "Assignment 3" })
    .returning();
  assignmentId = a.id;
  const [e] = await t.db.insert(exams).values({ userId: her, courseId, title: "Final", at: at(60 * 24 * 6) }).returning();
  examId = e.id;
  theirCourseId = await makeCourse(other, 1, "Someone else's course");
  theirLectureId = await makeLecture(other, theirCourseId, 1, "Theirs");
}, DB_TIMEOUT);

afterEach(async () => {
  await t.close();
}, DB_TIMEOUT);

describe("saveNote", () => {
  it("does not store an empty note", async () => {
    expect(await save(her, { title: "", body: "" })).toBeNull();
    expect(await save(her, { title: "   ", body: "\n\t", quote: "a quote alone" })).toBeNull();
    expect(await save(her, {})).toBeNull();
    expect(await countNotes(her, t.db)).toBe(0);
  }, DB_TIMEOUT);

  it("creates a general note by default and reads it back", async () => {
    const n = await save(her, { title: "Porter", body: "Five forces" });
    expect(n).not.toBeNull();
    expect(n!.attach).toEqual({ kind: "general", id: null });
    expect(n!.courseId).toBeNull();
    expect(n!.highlighted).toBe(false);
    expect(n!.createdAt.getTime()).toBe(NOW.getTime());
    expect(await getNote(her, n!.id, t.db)).toEqual(n);
  }, DB_TIMEOUT);

  it("stores a body-only note with a null title", async () => {
    const n = await save(her, { title: "  ", body: "Just a body" });
    expect(n!.title).toBeNull();
    expect(n!.body).toBe("Just a body");
  }, DB_TIMEOUT);

  it("links each kind and keeps the course of what it is attached to", async () => {
    const lec = await save(her, { body: "l", quote: "Make or buy", attach: { kind: "lecture", id: lectureId } });
    const asg = await save(her, { body: "a", attach: { kind: "assignment", id: assignmentId } });
    const exm = await save(her, { body: "e", attach: { kind: "exam", id: examId } });
    const crs = await save(her, { body: "c", attach: { kind: "course", id: courseId } });
    expect(lec!.attach).toEqual({ kind: "lecture", id: lectureId });
    expect(asg!.attach).toEqual({ kind: "assignment", id: assignmentId });
    expect(exm!.attach).toEqual({ kind: "exam", id: examId });
    expect(crs!.attach).toEqual({ kind: "course", id: courseId });
    for (const n of [lec, asg, exm, crs]) expect(n!.courseId).toBe(courseId);
    expect(lec!.quote).toBe("Make or buy");
  }, DB_TIMEOUT);

  it("updates in place, keeping fields left out, and moves it to the top", async () => {
    const a = await save(her, { title: "A", body: "first", attach: { kind: "lecture", id: lectureId } }, 0);
    await save(her, { title: "B", body: "second" }, 1);
    const updated = await save(her, { id: a!.id, body: "first, edited", highlighted: true }, 2);
    expect(updated).toMatchObject({ id: a!.id, title: "A", body: "first, edited", highlighted: true });
    expect(updated!.attach).toEqual({ kind: "lecture", id: lectureId });
    expect(updated!.createdAt.getTime()).toBe(at(0).getTime());
    expect(updated!.updatedAt.getTime()).toBe(at(2).getTime());
    expect((await listNotes(her, {}, t.db)).map((n) => n.title)).toEqual(["A", "B"]);
  }, DB_TIMEOUT);

  it("re-attaches when attach is given", async () => {
    const a = await save(her, { body: "x", attach: { kind: "lecture", id: lectureId } });
    const moved = await save(her, { id: a!.id, attach: { kind: "general" } });
    expect(moved!.attach).toEqual({ kind: "general", id: null });
    expect(moved!.courseId).toBeNull();
    expect(await notesForLecture(her, lectureId, t.db)).toEqual([]);
  }, DB_TIMEOUT);

  it("deletes a note saved as empty and returns null", async () => {
    const a = await save(her, { title: "Gone soon", body: "text" });
    expect(await save(her, { id: a!.id, title: "", body: "" })).toBeNull();
    expect(await getNote(her, a!.id, t.db)).toBeNull();
    expect(await countNotes(her, t.db)).toBe(0);
  }, DB_TIMEOUT);

  it("refuses another user's note and things that are not hers", async () => {
    const theirs = await save(other, { body: "their note" });
    const err = await caught(save(her, { id: theirs!.id, body: "hijack" }));
    expect(err).toBeInstanceOf(NoteNotFound);
    expect((await getNote(other, theirs!.id, t.db))!.body).toBe("their note");

    expect(await caught(save(her, { body: "x", attach: { kind: "lecture", id: theirLectureId } }))).toBeInstanceOf(NoteNotFound);
    expect(await caught(save(her, { body: "x", attach: { kind: "course", id: theirCourseId } }))).toBeInstanceOf(NoteNotFound);
    expect(await caught(save(her, { body: "x", attach: { kind: "exam", id: "not-a-uuid" } }))).toBeInstanceOf(NoteNotFound);
    expect(await caught(save(her, { body: "x", attach: { kind: "assignment" } }))).toBeInstanceOf(NoteNotFound);
    expect(await caught(save(her, { id: "nope", body: "x" }))).toBeInstanceOf(NoteNotFound);
    expect(await countNotes(her, t.db)).toBe(0);
  }, DB_TIMEOUT);
});

describe("listNotes", () => {
  beforeEach(async () => {
    await save(her, { title: "Oldest general", body: "nothing here" }, 0);
    await save(her, { title: "Lecture note", body: "vendors", quote: "Total cost of OWNERSHIP matters", attach: { kind: "lecture", id: lectureId } }, 1);
    await save(her, { title: "Exam prep", body: "Ask about 100% weighting", attach: { kind: "exam", id: examId } }, 2);
    await save(her, { title: "Forecast", body: "Holt_Winters", attach: { kind: "course", id: otherCourseId } }, 3);
    await save(her, { title: "Newest general", body: "remember" }, 4);
    await save(other, { title: "Their ownership note", body: "ownership" }, 5);
  }, DB_TIMEOUT);

  it("lists all of hers, newest first", async () => {
    expect((await listNotes(her, {}, t.db)).map((n) => n.title)).toEqual([
      "Newest general",
      "Forecast",
      "Exam prep",
      "Lecture note",
      "Oldest general",
    ]);
    expect((await listNotes(her, { courseId: null }, t.db)).length).toBe(5);
  }, DB_TIMEOUT);

  it("filters by course, including its lectures and exams", async () => {
    expect((await listNotes(her, { courseId }, t.db)).map((n) => n.title)).toEqual(["Exam prep", "Lecture note"]);
    expect((await listNotes(her, { courseId: otherCourseId }, t.db)).map((n) => n.title)).toEqual(["Forecast"]);
    expect(await listNotes(her, { courseId: theirCourseId }, t.db)).toEqual([]);
    expect(await listNotes(her, { courseId: "not-a-uuid" }, t.db)).toEqual([]);
  }, DB_TIMEOUT);

  it("filters to general", async () => {
    expect((await listNotes(her, { courseId: "general" }, t.db)).map((n) => n.title)).toEqual([
      "Newest general",
      "Oldest general",
    ]);
  }, DB_TIMEOUT);

  it("finds a word in the quote, ignoring case", async () => {
    expect((await listNotes(her, { query: "ownership" }, t.db)).map((n) => n.title)).toEqual(["Lecture note"]);
    expect((await listNotes(her, { query: "  VENDORS " }, t.db)).map((n) => n.title)).toEqual(["Lecture note"]);
    expect((await listNotes(her, { query: "newest" }, t.db)).map((n) => n.title)).toEqual(["Newest general"]);
  }, DB_TIMEOUT);

  it("treats % and _ literally and combines search with the course filter", async () => {
    expect((await listNotes(her, { query: "100%" }, t.db)).map((n) => n.title)).toEqual(["Exam prep"]);
    expect((await listNotes(her, { query: "%" }, t.db)).map((n) => n.title)).toEqual(["Exam prep"]);
    expect((await listNotes(her, { query: "t_w" }, t.db)).map((n) => n.title)).toEqual(["Forecast"]);
    expect((await listNotes(her, { query: "_" }, t.db)).map((n) => n.title)).toEqual(["Forecast"]);
    expect(await listNotes(her, { query: "ownership", courseId: otherCourseId }, t.db)).toEqual([]);
    expect((await listNotes(her, { query: "", courseId: "general" }, t.db)).length).toBe(2);
  }, DB_TIMEOUT);

  it("never shows another user's notes", async () => {
    const all = await listNotes(her, { query: "ownership" }, t.db);
    expect(all.every((n) => !n.title?.startsWith("Their"))).toBe(true);
    expect((await listNotes(other, {}, t.db)).map((n) => n.title)).toEqual(["Their ownership note"]);
    expect(await countNotes(her, t.db)).toBe(5);
    expect(await countNotes(other, t.db)).toBe(1);
  }, DB_TIMEOUT);
});

describe("notesForLecture, getNote, deleteNote", () => {
  it("returns only that lecture's notes, newest first", async () => {
    const lecture2 = await makeLecture(her, courseId, 6, "Contracts");
    await save(her, { title: "one", body: "x", attach: { kind: "lecture", id: lectureId } }, 0);
    await save(her, { title: "two", body: "x", attach: { kind: "lecture", id: lectureId } }, 1);
    await save(her, { title: "other lecture", body: "x", attach: { kind: "lecture", id: lecture2 } }, 2);
    await save(her, { title: "course", body: "x", attach: { kind: "course", id: courseId } }, 3);
    expect((await notesForLecture(her, lectureId, t.db)).map((n) => n.title)).toEqual(["two", "one"]);
    expect(await notesForLecture(other, lectureId, t.db)).toEqual([]);
  }, DB_TIMEOUT);

  it("keeps a note when its lecture is deleted, under the same course", async () => {
    const n = await save(her, { body: "survives", attach: { kind: "lecture", id: lectureId } });
    await t.db.delete(lectures).where(eq(lectures.id, lectureId));
    const after = await getNote(her, n!.id, t.db);
    expect(after!.attach).toEqual({ kind: "lecture", id: null });
    expect(after!.courseId).toBe(courseId);
    expect((await listNotes(her, { courseId }, t.db)).map((x) => x.id)).toEqual([n!.id]);
  }, DB_TIMEOUT);

  it("never reads or deletes another user's note", async () => {
    const theirs = await save(other, { body: "keep me" });
    expect(await getNote(her, theirs!.id, t.db)).toBeNull();
    expect(await deleteNote(her, theirs!.id, t.db)).toBe(false);
    expect(await getNote(other, theirs!.id, t.db)).not.toBeNull();

    const mine = await save(her, { body: "mine" });
    expect(await deleteNote(her, mine!.id, t.db)).toBe(true);
    expect(await deleteNote(her, mine!.id, t.db)).toBe(false);
    expect(await getNote(her, "not-a-uuid", t.db)).toBeNull();
    expect(await t.db.select().from(notes)).toHaveLength(1);
  }, DB_TIMEOUT);
});
