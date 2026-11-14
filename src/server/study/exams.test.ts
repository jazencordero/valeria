// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { cards, exams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import {
  addExam,
  ExamInvalid,
  ExamNotFound,
  helsinkiToInstant,
  instantToHelsinki,
  listExams,
  parseExamForm,
  removeExam,
  targetGradeForPct,
  targetPctForGrade,
  TARGET_GRADES,
  updateExam,
} from "./exams";

// The machine is shared; in-memory PGlite can be slow when the suite runs in parallel.
const DB_TIMEOUT = 90_000;
const D = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-14T10:00:00Z");

let t: TestDb;
let her: string;
let other: string;
let herCourse: string;
let herOtherCourse: string;
let theirCourse: string;

async function makeUser(): Promise<string> {
  const [u] = await t.db.insert(users).values({}).returning();
  return u.id;
}

async function makeCourse(userId: string, moodleId: number): Promise<string> {
  const [c] = await t.db.insert(courses).values({ userId, moodleId, name: `Course ${moodleId}` }).returning();
  return c.id;
}

const at = (days: number) => new Date(NOW.getTime() + days * D);

beforeEach(async () => {
  t = await createTestDb();
  her = await makeUser();
  other = await makeUser();
  herCourse = await makeCourse(her, 1);
  herOtherCourse = await makeCourse(her, 2);
  theirCourse = await makeCourse(other, 3);
}, DB_TIMEOUT);

afterEach(() => t.close(), DB_TIMEOUT);

describe("addExam", () => {
  it(
    "adds an exam to her course, trimmed, with the default target",
    async () => {
      const exam = await addExam(her, { courseId: herCourse, title: "  Final  ", kind: "exam", at: at(20) }, t.db);
      expect(exam).toMatchObject({ userId: her, courseId: herCourse, title: "Final", kind: "exam", targetPct: 80 });
      expect(exam.at.getTime()).toBe(at(20).getTime());
      expect(exam.eventId).toBeNull();
      const [row] = await t.db.select().from(exams).where(eq(exams.id, exam.id));
      expect(row.title).toBe("Final");
    },
    DB_TIMEOUT,
  );

  it(
    "keeps a given target",
    async () => {
      const exam = await addExam(
        her,
        { courseId: herCourse, title: "Quiz 1", kind: "quiz", at: at(3), targetPct: targetPctForGrade(5) },
        t.db,
      );
      expect(exam).toMatchObject({ kind: "quiz", targetPct: 90 });
    },
    DB_TIMEOUT,
  );

  it(
    "refuses someone else's course and writes nothing",
    async () => {
      await expect(
        addExam(her, { courseId: theirCourse, title: "Final", kind: "exam", at: at(20) }, t.db),
      ).rejects.toBeInstanceOf(ExamNotFound);
      await expect(
        addExam(her, { courseId: "7d1c2f0a-1b2c-4d3e-8f40-5a6b7c8d9e01", title: "Final", kind: "exam", at: at(20) }, t.db),
      ).rejects.toBeInstanceOf(ExamNotFound);
      expect(await t.db.select().from(exams)).toHaveLength(0);
    },
    DB_TIMEOUT,
  );

  it(
    "rejects bad input with the field that is wrong",
    async () => {
      const ok = { courseId: herCourse, title: "Final", kind: "exam" as const, at: at(20) };
      const bad: [object, string][] = [
        [{ ...ok, title: "   " }, "title"],
        [{ ...ok, title: "x".repeat(121) }, "title"],
        [{ ...ok, at: new Date("nope") }, "at"],
        [{ ...ok, at: new Date("2150-01-01T00:00:00Z") }, "at"],
        [{ ...ok, kind: "essay" }, "kind"],
        [{ ...ok, courseId: "not-a-uuid" }, "courseId"],
        [{ ...ok, targetPct: 120 }, "targetPct"],
        [{ ...ok, targetPct: 80.5 }, "targetPct"],
      ];
      for (const [input, field] of bad) {
        const err = await addExam(her, input as never, t.db).catch((e: unknown) => e);
        expect(err, JSON.stringify(input)).toBeInstanceOf(ExamInvalid);
        expect(Object.keys((err as ExamInvalid).fields)).toContain(field);
      }
      expect(await t.db.select().from(exams)).toHaveLength(0);
    },
    DB_TIMEOUT,
  );
});

describe("listExams", () => {
  it(
    "lists only hers, soonest first",
    async () => {
      const late = await addExam(her, { courseId: herCourse, title: "Final", kind: "exam", at: at(30) }, t.db);
      const soon = await addExam(her, { courseId: herOtherCourse, title: "Quiz", kind: "quiz", at: at(2) }, t.db);
      const mid = await addExam(her, { courseId: herCourse, title: "Midterm", kind: "exam", at: at(10) }, t.db);
      await addExam(other, { courseId: theirCourse, title: "Theirs", kind: "exam", at: at(1) }, t.db);
      expect((await listExams(her, t.db)).map((e) => e.id)).toEqual([soon.id, mid.id, late.id]);
      expect((await listExams(other, t.db)).map((e) => e.title)).toEqual(["Theirs"]);
    },
    DB_TIMEOUT,
  );
});

describe("updateExam", () => {
  it(
    "changes only the given fields, and can move it to another of her courses",
    async () => {
      const exam = await addExam(her, { courseId: herCourse, title: "Final", kind: "exam", at: at(20) }, t.db);
      const moved = await updateExam(
        her,
        exam.id,
        { title: " Final exam ", at: at(21), targetPct: 60, courseId: herOtherCourse },
        t.db,
      );
      expect(moved).toMatchObject({ id: exam.id, title: "Final exam", kind: "exam", targetPct: 60, courseId: herOtherCourse });
      expect(moved.at.getTime()).toBe(at(21).getTime());
      const kindOnly = await updateExam(her, exam.id, { kind: "quiz" }, t.db);
      expect(kindOnly).toMatchObject({ title: "Final exam", kind: "quiz" });
    },
    DB_TIMEOUT,
  );

  it(
    "refuses someone else's exam, and moving hers into someone else's course",
    async () => {
      const mine = await addExam(her, { courseId: herCourse, title: "Final", kind: "exam", at: at(20) }, t.db);
      const theirs = await addExam(other, { courseId: theirCourse, title: "Theirs", kind: "exam", at: at(5) }, t.db);
      await expect(updateExam(her, theirs.id, { title: "Mine now" }, t.db)).rejects.toBeInstanceOf(ExamNotFound);
      await expect(updateExam(her, mine.id, { courseId: theirCourse }, t.db)).rejects.toBeInstanceOf(ExamNotFound);
      await expect(updateExam(her, "not-a-uuid", { title: "x" }, t.db)).rejects.toBeInstanceOf(ExamNotFound);
      const [theirRow] = await t.db.select().from(exams).where(eq(exams.id, theirs.id));
      expect(theirRow.title).toBe("Theirs");
      const [myRow] = await t.db.select().from(exams).where(eq(exams.id, mine.id));
      expect(myRow.courseId).toBe(herCourse);
    },
    DB_TIMEOUT,
  );

  it(
    "rejects bad input and an empty patch",
    async () => {
      const exam = await addExam(her, { courseId: herCourse, title: "Final", kind: "exam", at: at(20) }, t.db);
      await expect(updateExam(her, exam.id, { title: "" }, t.db)).rejects.toBeInstanceOf(ExamInvalid);
      await expect(updateExam(her, exam.id, { at: new Date(Number.NaN) }, t.db)).rejects.toBeInstanceOf(ExamInvalid);
      await expect(updateExam(her, exam.id, {}, t.db)).rejects.toBeInstanceOf(ExamInvalid);
    },
    DB_TIMEOUT,
  );
});

describe("removeExam", () => {
  it(
    "removes hers with its cards, and refuses someone else's",
    async () => {
      const mine = await addExam(her, { courseId: herCourse, title: "Final", kind: "exam", at: at(20) }, t.db);
      const theirs = await addExam(other, { courseId: theirCourse, title: "Theirs", kind: "exam", at: at(5) }, t.db);
      await t.db.insert(cards).values({
        userId: her,
        examId: mine.id,
        type: "basic",
        body: { front: "a", back: "b" },
        origin: "manual",
        contentHash: "h1",
      });

      await expect(removeExam(her, theirs.id, t.db)).rejects.toBeInstanceOf(ExamNotFound);
      expect(await listExams(other, t.db)).toHaveLength(1);

      await removeExam(her, mine.id, t.db);
      expect(await listExams(her, t.db)).toHaveLength(0);
      expect(await t.db.select().from(cards)).toHaveLength(0);
      await expect(removeExam(her, mine.id, t.db)).rejects.toBeInstanceOf(ExamNotFound);
      await expect(removeExam(her, "nope", t.db)).rejects.toBeInstanceOf(ExamNotFound);
    },
    DB_TIMEOUT,
  );
});

describe("target grade", () => {
  it("maps grades 1..5 to 50..90 percent and back", () => {
    expect(TARGET_GRADES.map(targetPctForGrade)).toEqual([50, 60, 70, 80, 90]);
    for (const g of TARGET_GRADES) expect(targetGradeForPct(targetPctForGrade(g))).toBe(g);
    expect(targetGradeForPct(85)).toBe(4);
    expect(targetGradeForPct(30)).toBe(1);
    expect(targetGradeForPct(100)).toBe(5);
  });
});

describe("Helsinki time", () => {
  it("reads a form date and time as Helsinki time, across daylight saving", () => {
    expect(helsinkiToInstant("2026-12-15", "10:00")?.toISOString()).toBe("2026-12-15T08:00:00.000Z"); // UTC+2
    expect(helsinkiToInstant("2027-06-15", "10:00")?.toISOString()).toBe("2027-06-15T07:00:00.000Z"); // UTC+3
    expect(helsinkiToInstant("2027-03-28", "02:30")?.toISOString()).toBe("2027-03-28T00:30:00.000Z"); // before the jump
    expect(helsinkiToInstant("2027-03-28", "05:00")?.toISOString()).toBe("2027-03-28T02:00:00.000Z"); // after it
    expect(helsinkiToInstant("2026-12-31", "23:59")?.toISOString()).toBe("2026-12-31T21:59:00.000Z");
  });

  it("refuses dates and times that do not exist", () => {
    expect(helsinkiToInstant("2026-02-30", "10:00")).toBeNull();
    expect(helsinkiToInstant("2026-13-01", "10:00")).toBeNull();
    expect(helsinkiToInstant("2026-12-15", "24:00")).toBeNull();
    expect(helsinkiToInstant("15.12.2026", "10:00")).toBeNull();
    expect(helsinkiToInstant("2026-12-15", "")).toBeNull();
  });

  it("turns an instant back into the form's strings", () => {
    expect(instantToHelsinki(new Date("2026-12-15T08:00:00Z"))).toEqual({ date: "2026-12-15", time: "10:00" });
    expect(instantToHelsinki(new Date("2026-12-31T22:30:00Z"))).toEqual({ date: "2027-01-01", time: "00:30" });
    expect(instantToHelsinki(new Date("2027-06-15T07:00:00Z"))).toEqual({ date: "2027-06-15", time: "10:00" });
  });
});

describe("parseExamForm", () => {
  const course = "7d1c2f0a-1b2c-4d3e-8f40-5a6b7c8d9e01";
  const ok = { courseId: course, title: " Final ", kind: "exam", date: "2026-12-15", time: "10:00", targetGrade: "3" };

  it("turns the form's strings into store input", () => {
    const parsed = parseExamForm(ok);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input).toEqual({
      courseId: course,
      title: "Final",
      kind: "exam",
      at: new Date("2026-12-15T08:00:00Z"),
      targetPct: 70,
    });
  });

  it("names every bad field", () => {
    const parsed = parseExamForm({ title: "", kind: "essay", date: "tomorrow", time: "25:00", targetGrade: "6" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(Object.keys(parsed.errors).sort()).toEqual(["courseId", "date", "kind", "targetGrade", "time", "title"]);
    const impossible = parseExamForm({ ...ok, date: "2026-02-30" });
    expect(impossible).toEqual({ ok: false, errors: { date: "That date does not exist." } });
    const far = parseExamForm({ ...ok, date: "2150-01-01" });
    expect(far.ok).toBe(false);
  });
});
