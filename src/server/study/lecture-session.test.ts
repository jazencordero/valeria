// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { lectureConcepts, lectures } from "@/server/db/schema/learn";
import { cardConcepts, cards, concepts, exams, studySessions } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { beginLectureSession, lectureCards, safeReturn } from "./lecture-session";

// Made-up sample data for tests only.
const DB_TIMEOUT = 30_000;
const NOW = new Date("2026-11-15T10:00:00Z");

let t: TestDb;
let her: string;
let other: string;
let course: string;
let exam: string;
let lecture: string;
let bare: string;
let hash = 0;

async function addExam(userId: string, courseId: string, at: string) {
  const [e] = await t.db.insert(exams).values({ userId, courseId, title: "Exam", at: new Date(at) }).returning();
  return e.id;
}

async function addConcept(userId: string, examId: string, name: string, position = 0) {
  const [c] = await t.db.insert(concepts).values({ userId, examId, name, position }).returning();
  return c.id;
}

async function addCard(
  userId: string,
  examId: string,
  conceptIds: string[],
  extra: Partial<typeof cards.$inferInsert> = {},
) {
  const [c] = await t.db
    .insert(cards)
    .values({
      userId,
      examId,
      type: "basic",
      body: { q: `Question ${hash}`, a: "Answer" },
      origin: "ai",
      contentHash: `h-${hash++}`,
      createdAt: new Date(NOW.getTime() - 100_000 + hash * 1000),
      ...extra,
    })
    .returning();
  for (const conceptId of conceptIds) await t.db.insert(cardConcepts).values({ cardId: c.id, conceptId });
  return c.id;
}

beforeEach(async () => {
  t = await createTestDb();
  [{ id: her }, { id: other }] = await t.db.insert(users).values([{}, {}]).returning();
  const [c] = await t.db.insert(courses).values({ userId: her, moodleId: 1, name: "Systems Thinking" }).returning();
  course = c.id;
  exam = await addExam(her, course, "2026-12-10T08:00:00Z");
  const [l1, l2] = await t.db
    .insert(lectures)
    .values([
      { userId: her, courseId: course, n: 1, title: "Loops" },
      { userId: her, courseId: course, n: 2, title: "Delays" },
    ])
    .returning();
  lecture = l1.id;
  bare = l2.id;
}, DB_TIMEOUT);
afterEach(async () => {
  await t.close();
});

describe("safeReturn", () => {
  it("keeps a path on this site", () => {
    expect(safeReturn("/courses/abc/lectures/5")).toBe("/courses/abc/lectures/5");
    expect(safeReturn("/exams/x?from=3#top")).toBe("/exams/x?from=3#top");
  });

  it.each([
    ["another host", "//evil.example/x"],
    ["a backslash host", "/\\evil.example"],
    ["a backslash anywhere", "/courses\\x"],
    ["a scheme", "https://evil.example"],
    ["javascript", "javascript:alert(1)"],
    ["a data url", "data:text/html,hi"],
    ["a relative path", "courses/x"],
    ["empty", ""],
    ["whitespace", "/a b"],
    ["a newline", "/a\nb"],
    ["a tab before slashes", "/\t/evil.example"],
    ["too long", "/" + "a".repeat(600)],
  ])("refuses %s", (_, value) => {
    expect(safeReturn(value)).toBeNull();
  });

  it("refuses anything that is not a string", () => {
    expect(safeReturn(null)).toBeNull();
    expect(safeReturn(undefined)).toBeNull();
    expect(safeReturn(42)).toBeNull();
    expect(safeReturn(["/x"])).toBeNull();
  });
});

describe("lectureCards", () => {
  it("is every active card tied to the lecture's concepts, each once, boss cards last", async () => {
    const loops = await addConcept(her, exam, "Feedback loops", 0);
    const signs = await addConcept(her, exam, "Counting signs", 1);
    const elsewhere = await addConcept(her, exam, "Leverage", 2);
    await t.db.insert(lectureConcepts).values([
      { lectureId: lecture, conceptId: loops },
      { lectureId: lecture, conceptId: signs },
    ]);
    const boss = await addCard(her, exam, [loops], { boss: true });
    const a = await addCard(her, exam, [loops]);
    const both = await addCard(her, exam, [loops, signs]);
    const b = await addCard(her, exam, [signs]);
    await addCard(her, exam, [loops], { status: "flagged" });
    await addCard(her, exam, [elsewhere]);

    const got = await lectureCards(her, lecture, t.db);
    expect(got.examId).toBe(exam);
    expect(got.cardIds).toEqual([a, both, b, boss]);
  });

  it("has none for a lecture without cards, someone else's lecture or a malformed id", async () => {
    const loops = await addConcept(her, exam, "Feedback loops");
    await t.db.insert(lectureConcepts).values({ lectureId: lecture, conceptId: loops });
    await addCard(her, exam, [loops]);

    expect(await lectureCards(her, bare, t.db)).toEqual({ examId: null, cardIds: [] });
    expect(await lectureCards(other, lecture, t.db)).toEqual({ examId: null, cardIds: [] });
    expect(await lectureCards(her, "not-a-uuid", t.db)).toEqual({ examId: null, cardIds: [] });
  });

  it("uses the exam that holds most of the lecture's cards", async () => {
    const quiz = await addExam(her, course, "2026-11-20T08:00:00Z");
    const inExam = await addConcept(her, exam, "Loops");
    const inQuiz = await addConcept(her, quiz, "Loops, quiz");
    await t.db.insert(lectureConcepts).values([
      { lectureId: lecture, conceptId: inExam },
      { lectureId: lecture, conceptId: inQuiz },
    ]);
    await addCard(her, quiz, [inQuiz]);
    const e1 = await addCard(her, exam, [inExam]);
    const e2 = await addCard(her, exam, [inExam]);

    expect(await lectureCards(her, lecture, t.db)).toEqual({ examId: exam, cardIds: [e1, e2] });
  });
});

describe("beginLectureSession", () => {
  it("starts a concept session with every card and the numbers before", async () => {
    const loops = await addConcept(her, exam, "Feedback loops");
    await t.db.insert(lectureConcepts).values({ lectureId: lecture, conceptId: loops });
    // More than a concept session's four, to show none is left out.
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await addCard(her, exam, [loops]));

    const begun = await beginLectureSession(her, lecture, NOW, t.db);
    expect(begun).toMatchObject({ examId: exam, cards: 6 });
    const [row] = await t.db.select().from(studySessions).where(eq(studySessions.id, begun!.sessionId));
    expect(row.userId).toBe(her);
    expect(row.mode).toBe("concept");
    const summary = row.summary as Record<string, unknown>;
    expect(summary.cardIds).toEqual(ids);
    expect(summary.lectureId).toBe(lecture);
    expect(typeof summary.forecastBefore).toBe("number");
    expect(summary.masteryBefore).toHaveProperty(loops);
  });

  it("writes nothing when there is nothing to practise", async () => {
    expect(await beginLectureSession(her, bare, NOW, t.db)).toBeNull();
    expect(await beginLectureSession(other, lecture, NOW, t.db)).toBeNull();
    expect(await t.db.select().from(studySessions)).toHaveLength(0);
  });
});
