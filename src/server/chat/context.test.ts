// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { courseFiles, courses, filePages } from "@/server/db/schema/courses";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import {
  BRIEF_ATTACHMENT_MAX,
  buildContext,
  cleanBrief,
  HISTORY_BUDGET_CHARS,
  NOT_SHARED_ERROR,
  READ_PAGES_MAX,
  REPLY_RESERVE_CHARS,
  SYSTEM_BUDGET_CHARS,
  TOTAL_BUDGET_CHARS,
  type AiPolicy,
} from "./context";
import { ChatNotFound } from "./store";

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

let refs = 0;

const BRIEF_HTML =
  "<p>Write a <b>1500-word</b> essay on osmosis in plant cells.</p><p>Use at least three sources &amp; cite them.</p>";
const BRIEF_MARK = "1500-word essay on osmosis";
const NOW = new Date("2026-11-15T10:00:00Z");

async function seed(policy: AiPolicy, name = "Student A") {
  const [user] = await t.db.insert(users).values({ displayName: name }).returning();
  const [course] = await t.db
    .insert(courses)
    .values({ userId: user.id, moodleId: ++refs, name: "Plant Biology", aiPolicy: policy })
    .returning();
  const [assignment] = await t.db
    .insert(assignments)
    .values({
      userId: user.id,
      courseId: course.id,
      moodleId: ++refs,
      name: "Essay 1: Osmosis",
      introHtml: BRIEF_HTML,
      dueAt: new Date("2026-11-20T21:59:00Z"),
    })
    .returning();
  return { user, course, assignment };
}

async function file(
  userId: string,
  courseId: string,
  assignmentId: string | null,
  name: string,
  pages: string[],
) {
  const [f] = await t.db
    .insert(courseFiles)
    .values({ userId, courseId, assignmentId, moodleRef: `ref-${++refs}`, name, url: "https://example.test/f" })
    .returning();
  for (let i = 0; i < pages.length; i += 50) {
    await t.db
      .insert(filePages)
      .values(pages.slice(i, i + 50).map((text, j) => ({ fileId: f.id, page: i + j + 1, text })));
  }
  return f;
}

const opts = () => ({ db: t.db, now: NOW });

describe("cleanBrief", () => {
  it("turns the brief HTML into plain text", () => {
    expect(cleanBrief(BRIEF_HTML)).toBe(
      "Write a 1500-word essay on osmosis in plant cells.\nUse at least three sources & cite them.",
    );
    expect(cleanBrief(null)).toBe("");
    expect(cleanBrief("<script>alert(1)</script><p>Hi&nbsp;there</p>")).toBe("Hi there");
  });
});

describe("buildContext, course allows AI", () => {
  it("puts the brief, the file list with page counts and the start of the attachment in the prompt", async () => {
    const { user, course, assignment } = await seed("allowed");
    const brief = await file(user.id, course.id, assignment.id, "Brief.pdf", [
      "Grading: structure counts for forty percent",
      "Hand in as a PDF",
    ]);
    await file(user.id, course.id, assignment.id, "Template.docx", []);

    const ctx = await buildContext(user.id, assignment.id, opts());

    expect(ctx.materialShared).toBe(true);
    expect(ctx.aiPolicy).toBe("allowed");
    expect(ctx.system).toContain("Assignment: Essay 1: Osmosis");
    expect(ctx.system).toContain("Course: Plant Biology");
    expect(ctx.system).toContain("Due: Friday 20 November 2026 at 23:59 (Europe/Helsinki)");
    expect(ctx.system).toContain(BRIEF_MARK);
    expect(ctx.system).not.toContain("<p>");
    expect(ctx.system).toContain(`- Brief.pdf (2 pages, fileId ${brief.id})`);
    expect(ctx.system).toContain("- Template.docx (no readable text)");
    expect(ctx.system).toContain("[p. 1]\nGrading: structure counts for forty percent");
    expect(ctx.system).toContain("[p. 2]\nHand in as a PDF");
    // The rules.
    expect(ctx.system).toContain("[file, p. N]");
    expect(ctx.system).toContain("say so plainly");
    expect(ctx.system).toContain("Never claim to have run calculations");
    expect(ctx.system).toContain("You draft with her, never for her");
    expect(ctx.system).not.toContain("Do not write hand-in text");
    // The tools, in the shape the AI SDK takes.
    expect(Object.keys(ctx.tools).sort()).toEqual(["read_pages", "search_material"]);
    for (const tool of Object.values(ctx.tools)) {
      expect(typeof tool.description).toBe("string");
      expect(typeof tool.inputSchema.safeParse).toBe("function");
      expect(typeof tool.execute).toBe("function");
    }
    expect(ctx.tools.read_pages!.inputSchema.safeParse({ fileId: brief.id, from: 0 }).success).toBe(false);
    expect(ctx.tools.search_material!.inputSchema.safeParse({}).success).toBe(false);
  });

  it("stays under the budget with a 200-page file attached", async () => {
    const { user, course, assignment } = await seed("allowed");
    const page = (n: number) => `page ${n} marker${n} ` + "lorem ipsum dolor sit amet ".repeat(110); // about 3,000 characters
    const big = await file(
      user.id,
      course.id,
      assignment.id,
      "Reader.pdf",
      Array.from({ length: 200 }, (_, i) => page(i + 1)),
    );
    await t.db
      .update(assignments)
      .set({ introHtml: `<p>${"A very long brief sentence. ".repeat(2000)}</p>` })
      .where(eq(assignments.id, assignment.id));

    const ctx = await buildContext(user.id, assignment.id, opts());

    expect(ctx.system.length).toBeLessThanOrEqual(SYSTEM_BUDGET_CHARS);
    expect(SYSTEM_BUDGET_CHARS + HISTORY_BUDGET_CHARS + REPLY_RESERVE_CHARS).toBeLessThanOrEqual(
      TOTAL_BUDGET_CHARS,
    );
    expect(ctx.system).toContain(`- Reader.pdf (200 pages, fileId ${big.id})`);
    expect(ctx.system).toContain("marker1 ");
    expect(ctx.system).not.toContain("marker6 ");
    expect(ctx.system).toContain("Use read_pages for the rest (200 pages in all).");
    expect(ctx.system).toContain("Assignment brief (start only)");
    const start = ctx.system.indexOf("Start of Reader.pdf");
    expect(ctx.system.length - start).toBeLessThanOrEqual(BRIEF_ATTACHMENT_MAX + 400);

    // One read never returns more than the cap, however many pages are asked for.
    const out = await ctx.tools.read_pages!.execute({ fileId: big.id, from: 1, to: 200 });
    if ("error" in out) throw new Error(out.error);
    expect(out.pageCount).toBe(200);
    expect(out.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(out.pages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(READ_PAGES_MAX);
    const later = await ctx.tools.read_pages!.execute({ fileId: big.id, from: 150 });
    if ("error" in later) throw new Error(later.error);
    expect(later.pages[0].page).toBe(150);
  });

  it("searches this course only and reads this course's files only", async () => {
    const { user, course, assignment } = await seed("allowed");
    const mine = await file(user.id, course.id, null, "Lecture 2.pdf", [
      "intro",
      "turgor pressure keeps the cell rigid",
    ]);
    const [other] = await t.db
      .insert(courses)
      .values({ userId: user.id, moodleId: ++refs, name: "Other course" })
      .returning();
    const elsewhere = await file(user.id, other.id, null, "Elsewhere.pdf", ["turgor turgor turgor"]);

    const { tools } = await buildContext(user.id, assignment.id, opts());

    const found = await tools.search_material!.execute({ query: "turgor" });
    expect(found).toEqual({
      hits: [expect.objectContaining({ fileId: mine.id, fileName: "Lecture 2.pdf", page: 2 })],
    });

    const read = await tools.read_pages!.execute({ fileId: mine.id, from: 2, to: 2 });
    expect(read).toMatchObject({ fileName: "Lecture 2.pdf", pageCount: 2, pages: [{ page: 2 }] });

    expect(await tools.read_pages!.execute({ fileId: elsewhere.id, from: 1 })).toHaveProperty("error");
    expect(await tools.read_pages!.execute({ fileId: "not-a-uuid", from: 1 })).toHaveProperty("error");
  });
});

describe("buildContext, course does not allow AI or has not said", () => {
  it("'not_allowed': no brief text, no file text, no tools, and the no-drafting rule", async () => {
    const { user, course, assignment } = await seed("not_allowed");
    const f = await file(user.id, course.id, assignment.id, "Brief.pdf", ["Grading: structure counts"]);

    const ctx = await buildContext(user.id, assignment.id, opts());

    expect(ctx.materialShared).toBe(false);
    expect(ctx.aiPolicy).toBe("not_allowed");
    expect(ctx.tools).toEqual({});
    expect(ctx.system).toContain("Assignment: Essay 1: Osmosis");
    expect(ctx.system).toContain("Course: Plant Biology");
    expect(ctx.system).toContain("Due: Friday 20 November 2026 at 23:59");
    expect(ctx.system).toContain("- Brief.pdf");
    expect(ctx.system).not.toContain(BRIEF_MARK);
    expect(ctx.system).not.toContain("osmosis in plant cells");
    expect(ctx.system).not.toContain("Grading: structure counts");
    expect(ctx.system).not.toContain(f.id);
    expect(ctx.system).toContain("this course has not allowed AI help");
    expect(ctx.system).toContain("Do not guess what the brief or any file says");
    expect(ctx.system).toContain("Do not write hand-in text");
    expect(ctx.system).toContain("Explain concepts and give feedback");
    expect(ctx.system).not.toContain("search_material");
  });

  it("'unknown': no brief text and no tools, and says she has not said yet", async () => {
    const { user, course, assignment } = await seed("unknown");
    await file(user.id, course.id, assignment.id, "Brief.pdf", ["Grading: structure counts"]);

    const ctx = await buildContext(user.id, assignment.id, opts());

    expect(ctx.materialShared).toBe(false);
    expect(ctx.aiPolicy).toBe("unknown");
    expect(ctx.tools).toEqual({});
    expect(ctx.system).toContain("- Brief.pdf");
    expect(ctx.system).not.toContain(BRIEF_MARK);
    expect(ctx.system).not.toContain("Grading: structure counts");
    expect(ctx.system).toContain("she has not yet said whether this course allows AI help");
    expect(ctx.system).toContain("Do not guess what the brief or any file says");
    expect(ctx.system).toContain("give feedback on text she writes or pastes herself");
    expect(ctx.system).not.toContain("Do not write hand-in text");
    expect(ctx.system.length).toBeLessThanOrEqual(SYSTEM_BUDGET_CHARS);
  });
});

describe("ownership", () => {
  it("refuses another user's assignment, an unknown one and a malformed id", async () => {
    const a = await seed("allowed", "Student A");
    const b = await seed("allowed", "Student B");

    await expect(buildContext(b.user.id, a.assignment.id, opts())).rejects.toBeInstanceOf(ChatNotFound);
    await expect(
      buildContext(a.user.id, "00000000-0000-4000-8000-000000000000", opts()),
    ).rejects.toBeInstanceOf(ChatNotFound);
    await expect(buildContext(a.user.id, "not-a-uuid", opts())).rejects.toBeInstanceOf(ChatNotFound);
  });

  it("never reads another user's file through the tools", async () => {
    const a = await seed("allowed", "Student A");
    const b = await seed("allowed", "Student B");
    const theirs = await file(b.user.id, b.course.id, b.assignment.id, "Theirs.pdf", ["plasmolysis secret"]);

    const { tools } = await buildContext(a.user.id, a.assignment.id, opts());

    expect(await tools.read_pages!.execute({ fileId: theirs.id, from: 1 })).toHaveProperty("error");
    expect(await tools.search_material!.execute({ query: "plasmolysis" })).toEqual({ hits: [] });
  });

  it("the tools check again when they run: a changed policy or a lost assignment stops them", async () => {
    const { user, course, assignment } = await seed("allowed");
    const f = await file(user.id, course.id, assignment.id, "Brief.pdf", ["plasmolysis explained"]);
    const { tools } = await buildContext(user.id, assignment.id, opts());
    expect(await tools.search_material!.execute({ query: "plasmolysis" })).toHaveProperty("hits");

    await t.db.update(courses).set({ aiPolicy: "not_allowed" }).where(eq(courses.id, course.id));
    expect(await tools.search_material!.execute({ query: "plasmolysis" })).toEqual({ error: NOT_SHARED_ERROR });
    expect(await tools.read_pages!.execute({ fileId: f.id, from: 1 })).toEqual({ error: NOT_SHARED_ERROR });

    await t.db.update(courses).set({ aiPolicy: "allowed" }).where(eq(courses.id, course.id));
    expect(await tools.read_pages!.execute({ fileId: f.id, from: 1 })).toHaveProperty("pages");

    // The assignment is no longer hers (here: it is gone).
    await t.db.delete(assignments).where(eq(assignments.id, assignment.id));
    expect(await tools.search_material!.execute({ query: "plasmolysis" })).toEqual({ error: NOT_SHARED_ERROR });
    expect(await tools.read_pages!.execute({ fileId: f.id, from: 1 })).toEqual({ error: NOT_SHARED_ERROR });
  });
});
