// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { lectureConcepts, lectures } from "@/server/db/schema/learn";
import { cardConcepts, cards, cardStates, concepts, exams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { saveNote } from "@/server/notes/store";

// The actions read the app database and the signed-in user; point both at this test.
const holder = vi.hoisted(() => ({ db: undefined as unknown, userId: null as string | null }));
vi.mock("@/server/db/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db/client")>();
  const db = new Proxy({} as Db, {
    get(_t, prop) {
      const target = holder.db as Db;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...real, db };
});
vi.mock("@/server/auth/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/auth/session")>();
  return {
    ...real,
    currentUser: async () => {
      if (!holder.userId) throw new real.NotSignedIn();
      return { id: holder.userId };
    },
  };
});
vi.mock("next/cache", () => ({ refresh: vi.fn() }));

const { addCardsFromNote, noteCardExams } = await import("./card-actions");

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const DAY = 24 * 60 * 60_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY);

let t: TestDb;
let her: string;
let other: string;
let courseId: string;
let examId: string;
let laterExamId: string;
let lectureId: string;
let conceptId: string;
let bareCourseId: string;

async function makeUser(): Promise<string> {
  const [u] = await t.db.insert(users).values({}).returning();
  return u.id;
}

async function note(userId: string, attach: { kind: "general" | "course" | "lecture" | "exam"; id?: string }, body = "x") {
  const saved = await saveNote(userId, { title: "N", body, attach }, new Date(), t.db);
  return saved!.id;
}

const TWO = [
  { front: "SLA", back: "the promised service level" },
  { front: "TCO", back: "total cost of ownership" },
];

beforeEach(async () => {
  t = await createTestDb();
  holder.db = t.db;
  her = await makeUser();
  other = await makeUser();
  holder.userId = her;
  const [c] = await t.db
    .insert(courses)
    .values({ userId: her, moodleId: 1, name: "Strategic IT Management, Lecture, 1.9.2026-18.12.2026" })
    .returning();
  courseId = c.id;
  const [bare] = await t.db.insert(courses).values({ userId: her, moodleId: 2, name: "Forecasting Methods" }).returning();
  bareCourseId = bare.id;
  // A past exam, the next one, and a later one: cards go on the next.
  await t.db.insert(exams).values({ userId: her, courseId, title: "Midterm", at: inDays(-10) });
  const [e] = await t.db.insert(exams).values({ userId: her, courseId, title: "Final", at: inDays(6) }).returning();
  examId = e.id;
  const [later] = await t.db.insert(exams).values({ userId: her, courseId, title: "Retake", at: inDays(60) }).returning();
  laterExamId = later.id;
  const [l] = await t.db.insert(lectures).values({ userId: her, courseId, n: 5, title: "Sourcing and vendors" }).returning();
  lectureId = l.id;
  const [k] = await t.db.insert(concepts).values({ userId: her, examId, name: "Vendor risk", position: 2 }).returning();
  conceptId = k.id;
  await t.db.insert(lectureConcepts).values({ lectureId, conceptId });
});

afterEach(async () => {
  holder.userId = null;
  await t.close();
});

describe("addCardsFromNote", () => {
  it("stores recall cards, origin note, source the note's label, on the course's exam, tied to the lecture's concept, due today", async () => {
    const id = await note(her, { kind: "lecture", id: lectureId });
    const before = Date.now();
    const r = await addCardsFromNote(id, TWO);
    expect(r).toEqual({ ok: true, added: 2, skipped: 0, course: "Strategic IT Management" });

    const stored = await t.db.select().from(cards).where(eq(cards.userId, her));
    expect(stored).toHaveLength(2);
    for (const c of stored) {
      expect(c).toMatchObject({ examId, type: "basic", origin: "note", source: "Lecture 5 · Sourcing and vendors" });
    }
    expect(stored.map((c) => c.body)).toEqual(
      expect.arrayContaining([
        { q: "SLA", a: "the promised service level" },
        { q: "TCO", a: "total cost of ownership" },
      ]),
    );
    const links = await t.db.select().from(cardConcepts);
    expect(links.map((x) => x.conceptId)).toEqual([conceptId, conceptId]);
    const states = await t.db.select().from(cardStates);
    expect(states).toHaveLength(2);
    for (const s of states) {
      expect(s.dueAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(s.dueAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(s.lastReviewAt).toBeNull();
    }
    expect(stored.some((c) => c.examId === laterExamId)).toBe(false);
  });

  it("a course note's cards have no concept and the course name as source", async () => {
    const id = await note(her, { kind: "course", id: courseId });
    const r = await addCardsFromNote(id, TWO.slice(0, 1));
    expect(r).toMatchObject({ ok: true, added: 1 });
    const [c] = await t.db.select().from(cards);
    expect(c.source).toBe("Strategic IT Management");
    expect(await t.db.select().from(cardConcepts)).toHaveLength(0);
  });

  it("skips rows with an empty front (or back)", async () => {
    const id = await note(her, { kind: "course", id: courseId });
    const r = await addCardsFromNote(id, [
      { front: "  ", back: "orphan answer" },
      { front: "SLA", back: "service level" },
      { front: "Heading", back: "" },
    ]);
    expect(r).toMatchObject({ ok: true, added: 1, skipped: 0 });
    const stored = await t.db.select().from(cards);
    expect(stored.map((c) => c.body)).toEqual([{ q: "SLA", a: "service level" }]);

    expect(await addCardsFromNote(id, [{ front: "", back: "x" }])).toEqual({ ok: false, reason: "empty" });
  });

  it("a course with no exam stores nothing and says no exam", async () => {
    const id = await note(her, { kind: "course", id: bareCourseId });
    expect(await addCardsFromNote(id, TWO)).toEqual({ ok: false, reason: "no_exam" });
    expect(await t.db.select().from(cards)).toHaveLength(0);
    expect(await t.db.select().from(cardStates)).toHaveLength(0);
  });

  it("a course whose only exam is past counts as no exam", async () => {
    await t.db.insert(exams).values({ userId: her, courseId: bareCourseId, title: "Old", at: inDays(-3) });
    const id = await note(her, { kind: "course", id: bareCourseId });
    expect(await addCardsFromNote(id, TWO)).toEqual({ ok: false, reason: "no_exam" });
  });

  it("refuses another user's note, and stores nothing", async () => {
    const theirs = await note(other, { kind: "general" });
    expect(await addCardsFromNote(theirs, TWO)).toEqual({ ok: false, reason: "not_found" });
    expect(await t.db.select().from(cards)).toHaveLength(0);
  });

  it("a General note asks which exam, then uses the one she chose", async () => {
    const id = await note(her, { kind: "general" });
    expect(await addCardsFromNote(id, TWO)).toEqual({ ok: false, reason: "choose_exam" });

    const choices = await noteCardExams();
    expect(choices).toEqual({
      ok: true,
      exams: [
        { id: examId, label: "Final · Strategic IT Management" },
        { id: laterExamId, label: "Retake · Strategic IT Management" },
      ],
    });

    const r = await addCardsFromNote(id, TWO, laterExamId);
    expect(r).toEqual({ ok: true, added: 2, skipped: 0, course: "Strategic IT Management" });
    const stored = await t.db.select().from(cards);
    expect(stored.every((c) => c.examId === laterExamId && c.source === "General")).toBe(true);
  });

  it("a General note cannot pick someone else's exam", async () => {
    const [theirCourse] = await t.db.insert(courses).values({ userId: other, moodleId: 1, name: "Theirs" }).returning();
    const [theirExam] = await t.db.insert(exams).values({ userId: other, courseId: theirCourse.id, title: "T", at: inDays(3) }).returning();
    const id = await note(her, { kind: "general" });
    expect(await addCardsFromNote(id, TWO, theirExam.id)).toEqual({ ok: false, reason: "choose_exam" });
    expect(await t.db.select().from(cards)).toHaveLength(0);
  });

  it("a note on an exam uses that exam", async () => {
    const id = await note(her, { kind: "exam", id: laterExamId });
    expect(await addCardsFromNote(id, TWO.slice(0, 1))).toMatchObject({ ok: true, added: 1 });
    const [c] = await t.db.select().from(cards);
    expect(c.examId).toBe(laterExamId);
    expect(c.source).toBe("Exam · Strategic IT Management");
  });

  it("skips cards she already has and says how many", async () => {
    const id = await note(her, { kind: "course", id: courseId });
    await addCardsFromNote(id, TWO.slice(0, 1));
    const r = await addCardsFromNote(id, [...TWO, { front: "TCO", back: "total cost of ownership" }]);
    expect(r).toEqual({ ok: true, added: 1, skipped: 2, course: "Strategic IT Management" });
    expect(await t.db.select().from(cards)).toHaveLength(2);
    expect(await addCardsFromNote(id, TWO)).toMatchObject({ ok: true, added: 0, skipped: 2 });
  });

  it("checks its inputs and the session", async () => {
    const id = await note(her, { kind: "course", id: courseId });
    expect(await addCardsFromNote("nope", TWO)).toEqual({ ok: false, reason: "invalid" });
    expect(await addCardsFromNote(id, [...TWO, ...TWO])).toEqual({ ok: false, reason: "invalid" });
    holder.userId = null;
    expect(await addCardsFromNote(id, TWO)).toEqual({ ok: false, reason: "signed_out" });
    expect(await noteCardExams()).toEqual({ ok: false, reason: "signed_out" });
  });
});
