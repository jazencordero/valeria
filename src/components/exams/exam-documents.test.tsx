// @vitest-environment node
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadExamDocument, loadExamDocuments } from "@/app/(app)/exams/[id]/documents/[slug]/page";
import { DocumentReader } from "@/components/exams/document-reader";
import { ExamDocuments, readingMinutes, wordCount } from "@/components/exams/exam-documents";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { examDocuments, exams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";

const EXAM = "00000000-0000-4000-8000-000000000054";

describe("ExamDocuments", () => {
  it("renders one row per document, in the order given, with title and minutes", () => {
    const html = renderToStaticMarkup(
      <ExamDocuments
        examId={EXAM}
        documents={[
          { slug: "study-plan", title: "Study plan", minutes: 3 },
          { slug: "exam-day", title: "Exam-day sheet", minutes: 1 },
          { slug: "mock-1", title: "Mock exam 1", minutes: 7 },
        ]}
      />,
    );
    expect(html).toContain("Exam documents");
    const slugs = [...html.matchAll(/data-document="([^"]+)"/g)].map((m) => m[1]);
    expect(slugs).toEqual(["study-plan", "exam-day", "mock-1"]);
    expect(html).toContain(`href="/exams/${EXAM}/documents/mock-1"`);
    expect(html).toContain("7 min");
  });

  it("renders nothing when the exam has no documents", () => {
    expect(renderToStaticMarkup(<ExamDocuments examId={EXAM} documents={[]} />)).toBe("");
  });
});

describe("readingMinutes", () => {
  it("counts words, not Markdown markers", () => {
    expect(wordCount("# Plan\n\n- **Read** `loops` | delays |\n\n1. Week 2's quiz")).toBe(7);
  });

  it("is about 200 words a minute, and never under 1", () => {
    const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    expect(readingMinutes("")).toBe(1);
    expect(readingMinutes(words(50))).toBe(1);
    expect(readingMinutes(words(400))).toBe(2);
    expect(readingMinutes(words(1000))).toBe(5);
    expect(readingMinutes(words(1150))).toBe(6);
  });
});

describe("DocumentReader", () => {
  it("renders headings, lists, bold, code and a table that scrolls inside itself", () => {
    const html = renderToStaticMarkup(
      <DocumentReader
        examId={EXAM}
        title="Mock exam 1"
        minutes={2}
        bodyMd={"# Mock exam 1\n\n## Notes\n\n- **Six** points\n- Units: `days`\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<b>raw</b>"}
      />,
    );
    expect(html.match(/<h1/g)).toHaveLength(1); // the repeated title heading is dropped
    expect(html).toContain("<h2");
    expect(html).toContain("<strong");
    expect(html).toContain("<code");
    expect(html).toMatch(/data-table-scroll="" [^>]*class="[^"]*overflow-x-auto/);
    expect(html).toContain(`href="/exams/${EXAM}"`);
    expect(html).not.toContain("<b>raw</b>"); // Markdown is text, never HTML
  });
});

describe("loading documents", () => {
  // PGlite per test; the machine is shared, so be generous.
  vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  async function seedExam(moodleId: number) {
    const [u] = await t.db.insert(users).values({}).returning();
    const [c] = await t.db.insert(courses).values({ userId: u.id, moodleId, name: `Course ${moodleId}` }).returning();
    const [e] = await t.db
      .insert(exams)
      .values({ userId: u.id, courseId: c.id, title: "Exam", at: new Date("2026-12-10T07:00:00Z") })
      .returning();
    return { userId: u.id, courseId: c.id, examId: e.id };
  }

  it("lists her documents in position order", async () => {
    const her = await seedExam(1);
    await t.db.insert(examDocuments).values([
      { userId: her.userId, examId: her.examId, slug: "mock-1", title: "Mock exam 1", bodyMd: "x", position: 2 },
      { userId: her.userId, examId: her.examId, slug: "study-plan", title: "Study plan", bodyMd: "y", position: 0 },
      { userId: her.userId, examId: her.examId, slug: "exam-day", title: "Exam-day sheet", bodyMd: "z", position: 1 },
    ]);
    const rows = await loadExamDocuments(t.db, her.userId, her.examId);
    expect(rows.map((r) => r.slug)).toEqual(["study-plan", "exam-day", "mock-1"]);
    expect(rows[0]).toEqual({ slug: "study-plan", title: "Study plan", minutes: 1 });
  });

  it("finds her document, and not another user's", async () => {
    const her = await seedExam(1);
    const other = await seedExam(2);
    await t.db.insert(examDocuments).values([
      { userId: her.userId, examId: her.examId, slug: "study-plan", title: "Her plan", bodyMd: "# Her plan\n\nRead." },
      { userId: other.userId, examId: other.examId, slug: "study-plan", title: "Their plan", bodyMd: "Theirs." },
    ]);

    const mine = await loadExamDocument(t.db, her.userId, her.examId, "study-plan");
    expect(mine).toMatchObject({ examId: her.examId, title: "Her plan", minutes: 1 });

    // Their exam id with her user id, and her exam id with theirs: not found.
    expect(await loadExamDocument(t.db, her.userId, other.examId, "study-plan")).toBeNull();
    expect(await loadExamDocuments(t.db, her.userId, other.examId)).toEqual([]);
    expect(await loadExamDocument(t.db, other.userId, her.examId, "study-plan")).toBeNull();
    // Unknown slug, malformed id or slug.
    expect(await loadExamDocument(t.db, her.userId, her.examId, "mock-9")).toBeNull();
    expect(await loadExamDocument(t.db, her.userId, "not-a-uuid", "study-plan")).toBeNull();
    expect(await loadExamDocument(t.db, her.userId, her.examId, "../x")).toBeNull();
  });

  it("hides the documents of a course she has hidden", async () => {
    const her = await seedExam(1);
    await t.db
      .insert(examDocuments)
      .values({ userId: her.userId, examId: her.examId, slug: "study-plan", title: "Plan", bodyMd: "x" });
    await t.db.update(courses).set({ hidden: true }).where(eq(courses.id, her.courseId));
    expect(await loadExamDocument(t.db, her.userId, her.examId, "study-plan")).toBeNull();
    expect(await loadExamDocuments(t.db, her.userId, her.examId)).toEqual([]);
  });
});
