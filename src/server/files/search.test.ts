// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { courseFiles, courses, filePages } from "@/server/db/schema/courses";
import { users } from "@/server/db/schema/users";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { MAX_LIMIT, pagesFor, searchPages } from "./search";

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

let refs = 0;

async function user(name: string) {
  const [u] = await t.db.insert(users).values({ displayName: name }).returning();
  return u;
}

async function course(userId: string, name: string) {
  const [c] = await t.db
    .insert(courses)
    .values({ userId, moodleId: ++refs, name })
    .returning();
  return c;
}

async function file(userId: string, courseId: string, name: string, pages: string[]) {
  const [f] = await t.db
    .insert(courseFiles)
    .values({ userId, courseId, moodleRef: `ref-${++refs}`, name, url: "https://example.test/f" })
    .returning();
  if (pages.length) {
    await t.db.insert(filePages).values(pages.map((text, i) => ({ fileId: f.id, page: i + 1, text })));
  }
  return f;
}

describe("searchPages", () => {
  it("finds the page that holds the words, with a plain-text snippet", async () => {
    const me = await user("Student A");
    const bio = await course(me.id, "Biology");
    const f = await file(me.id, bio.id, "Lecture 1.pdf", [
      "Introduction to the course and the reading list",
      "Photosynthesis turns light into sugar inside the chloroplast",
      "Cell walls and membranes",
    ]);

    const hits = await searchPages(me.id, { query: "photosynthesis", db: t.db });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ fileId: f.id, fileName: "Lecture 1.pdf", page: 2 });
    expect(hits[0].snippet).toContain("Photosynthesis turns light into sugar");
    expect(hits[0].snippet).not.toMatch(/<|>/);
  });

  it("reads the query like a search box: phrases and left-out words", async () => {
    const me = await user("Student A");
    const bio = await course(me.id, "Biology");
    await file(me.id, bio.id, "Notes.pdf", [
      "the cell wall is rigid",
      "the wall of the cell is rigid",
      "cell wall and sugar",
    ]);

    const phrase = await searchPages(me.id, { query: '"cell wall" -sugar', db: t.db });
    expect(phrase.map((h) => h.page)).toEqual([1]);
  });

  it("never returns another user's pages", async () => {
    const me = await user("Student A");
    const other = await user("Student B");
    const mine = await course(me.id, "Biology");
    const theirs = await course(other.id, "Biology");
    const myFile = await file(me.id, mine.id, "Mine.pdf", ["mitochondria make energy"]);
    await file(other.id, theirs.id, "Theirs.pdf", ["mitochondria mitochondria mitochondria"]);

    const hits = await searchPages(me.id, { query: "mitochondria", db: t.db });
    expect(hits.map((h) => h.fileId)).toEqual([myFile.id]);

    // Even naming their course gives nothing.
    expect(await searchPages(me.id, { query: "mitochondria", courseId: theirs.id, db: t.db })).toEqual(
      [],
    );
  });

  it("keeps to one course when courseId is given", async () => {
    const me = await user("Student A");
    const bio = await course(me.id, "Biology");
    const chem = await course(me.id, "Chemistry");
    const bioFile = await file(me.id, bio.id, "Bio.pdf", ["enzymes speed up reactions"]);
    const chemFile = await file(me.id, chem.id, "Chem.pdf", ["enzymes and catalysts"]);

    const all = await searchPages(me.id, { query: "enzymes", db: t.db });
    expect(all.map((h) => h.fileId).sort()).toEqual([bioFile.id, chemFile.id].sort());

    const onlyChem = await searchPages(me.id, { query: "enzymes", courseId: chem.id, db: t.db });
    expect(onlyChem.map((h) => h.fileId)).toEqual([chemFile.id]);
  });

  it("ranks the page about the words first, and breaks ties by file name then page", async () => {
    const me = await user("Student A");
    const c = await course(me.id, "Economics");
    const filler = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const b = await file(me.id, c.id, "B.pdf", [
      `inflation ${filler}`, // one mention in a long page
      "inflation and interest rates: inflation rises when interest rates fall", // dense
    ]);
    const a = await file(me.id, c.id, "A.pdf", ["exactly the same text", "exactly the same text"]);

    const ranked = await searchPages(me.id, { query: "inflation interest", db: t.db });
    expect(ranked.map((h) => [h.fileId, h.page])).toEqual([[b.id, 2]]);

    const loose = await searchPages(me.id, { query: "inflation", db: t.db });
    expect(loose.map((h) => h.page)).toEqual([2, 1]);

    // Equal rank: by file name, then page.
    const ties = await searchPages(me.id, { query: "same", db: t.db });
    expect(ties.map((h) => [h.fileId, h.page])).toEqual([
      [a.id, 1],
      [a.id, 2],
    ]);

    const c2 = await file(me.id, c.id, "0 first.pdf", ["exactly the same text"]);
    const ties2 = await searchPages(me.id, { query: "same", db: t.db });
    expect(ties2.map((h) => h.fileId)).toEqual([c2.id, a.id, a.id]);
  });

  it("returns [] for an empty, blank or punctuation-only query, without throwing", async () => {
    const me = await user("Student A");
    const c = await course(me.id, "Biology");
    await file(me.id, c.id, "Lecture.pdf", ["some text ! ? -- here"]);

    for (const query of ["", "   \n\t", "!!! ?? --", '"', "-", "()&|:*'", "or"]) {
      await expect(searchPages(me.id, { query, db: t.db })).resolves.toEqual([]);
    }
  });

  it("defaults to 8 hits and never returns more than 50", async () => {
    const me = await user("Student A");
    const c = await course(me.id, "Biology");
    await file(
      me.id,
      c.id,
      "Big.pdf",
      Array.from({ length: 60 }, (_, i) => `protein page ${i}`),
    );

    expect(await searchPages(me.id, { query: "protein", db: t.db })).toHaveLength(8);
    expect(await searchPages(me.id, { query: "protein", limit: 3, db: t.db })).toHaveLength(3);
    expect(await searchPages(me.id, { query: "protein", limit: 500, db: t.db })).toHaveLength(MAX_LIMIT);
    expect(await searchPages(me.id, { query: "protein", limit: 0, db: t.db })).toHaveLength(1);
  });
});

describe("pagesFor", () => {
  async function threePages() {
    const me = await user("Student A");
    const c = await course(me.id, "Biology");
    const f = await file(me.id, c.id, "Lecture.pdf", ["aaaa", "bbbbbb", "cc", "dddd"]);
    return { me, c, f };
  }

  it("returns page text in order, within from and to", async () => {
    const { me, f } = await threePages();
    expect(await pagesFor(me.id, f.id, { db: t.db })).toEqual([
      { page: 1, text: "aaaa" },
      { page: 2, text: "bbbbbb" },
      { page: 3, text: "cc" },
      { page: 4, text: "dddd" },
    ]);
    expect(await pagesFor(me.id, f.id, { from: 2, to: 3, db: t.db })).toEqual([
      { page: 2, text: "bbbbbb" },
      { page: 3, text: "cc" },
    ]);
  });

  it("respects maxChars by stopping at whole pages", async () => {
    const { me, f } = await threePages();
    // 4 + 6 = 10 fits; adding "cc" would make 12.
    const pages = await pagesFor(me.id, f.id, { maxChars: 11, db: t.db });
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    expect(pages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(11);

    // Exactly on the limit keeps the page.
    expect((await pagesFor(me.id, f.id, { maxChars: 12, db: t.db })).map((p) => p.page)).toEqual([
      1, 2, 3,
    ]);
    // It stops at the first page that does not fit; it does not skip ahead to a smaller one.
    expect((await pagesFor(me.id, f.id, { from: 2, maxChars: 7, db: t.db })).map((p) => p.page)).toEqual([2]);
  });

  it("cuts the first page only when it alone is over maxChars", async () => {
    const { me, f } = await threePages();
    expect(await pagesFor(me.id, f.id, { from: 2, maxChars: 3, db: t.db })).toEqual([
      { page: 2, text: "bbb" },
    ]);
    expect(await pagesFor(me.id, f.id, { maxChars: 0, db: t.db })).toEqual([]);
  });

  it("gives nothing for someone else's file", async () => {
    const { f } = await threePages();
    const other = await user("Student B");
    expect(await pagesFor(other.id, f.id, { db: t.db })).toEqual([]);
  });
});
