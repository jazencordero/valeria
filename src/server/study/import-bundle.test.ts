// @vitest-environment node
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contentHash, parseCard } from "@/lib/study/card-schema";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courses } from "@/server/db/schema/courses";
import { lectureConcepts, lectureContent, lectures } from "@/server/db/schema/learn";
import { moodleConnections } from "@/server/db/schema/moodle";
import { cardConcepts, cards, cardStates, concepts, exams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { parseArgs, run } from "../../../scripts/study/import-bundle";
import {
  applyImport,
  BundleInvalid,
  ImportFailed,
  loadBundle,
  planImport,
  type CourseBundle,
  type ImportPlan,
} from "./import-bundle";

const FIXTURE = path.join(process.cwd(), "tests/fixtures/study/sample-bundle");
const NOW = new Date("2026-11-15T10:00:00Z");
/** startNewOn 2026-11-24 at 00:00 in Helsinki (UTC+2 in November). */
const START = new Date("2026-11-23T22:00:00Z");
const T = 90_000;

let t: TestDb;
let her: string;
let other: string;
let herCourse: string;
let otherCourse: string;
let course: CourseBundle;
let plan: ImportPlan;

async function addUserWithCourse(moodleId: number): Promise<[string, string]> {
  const [u] = await t.db.insert(users).values({}).returning();
  const [c] = await t.db
    .insert(courses)
    .values({ userId: u.id, moodleId, code: "TST-E0001", name: "Intro to Forecasting" })
    .returning();
  return [u.id, c.id];
}

const TABLES = { courses, exams, concepts, cards, cardConcepts, cardStates, lectures, lectureContent, lectureConcepts };

async function rowCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, table] of Object.entries(TABLES)) {
    const [row] = await t.db.select({ n: sql<number>`count(*)::int` }).from(table);
    out[name] = row.n;
  }
  return out;
}

const write = (file: string, value: unknown) =>
  writeFile(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));

// A multi-course root, built from the fixture at test time:
//   <root>/account.json
//   <root>/TST-E0001/{seed.json, deck-1.json, page-1.json, map.json, exam/...}
//   <root>/TST-E0002/seed.json   (not ready: its seed is invalid)
let root: string;
const MAP = {
  prerequisites: { "error-measures": ["moving-average"], "trend-season": ["moving-average"] },
  threads: [{ name: "Accuracy", concepts: ["moving-average", "error-measures"] }],
  studyOrder: [
    { lecture: 1, concepts: ["trend-season", "moving-average"] },
    { name: "Exam essentials", concepts: ["error-measures"] },
  ],
};

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bundle-root-"));
  const one = path.join(root, "TST-E0001");
  await cp(FIXTURE, one, { recursive: true });
  const seed = JSON.parse(await readFile(path.join(one, "seed.json"), "utf8"));
  await write(path.join(one, "seed.json"), { ...seed, map: "map.json" });
  await write(path.join(one, "map.json"), MAP);
  await mkdir(path.join(one, "exam"));
  await write(path.join(one, "exam", "past-paper.pdf"), "%PDF-1.4\n% invented\n");
  await write(path.join(one, "exam", "essentials.md"), "# Exam essentials\n\nInvented text.\n");
  await write(path.join(one, "exam", "broken.json"), "{ nope");
  await mkdir(path.join(root, "TST-E0002"));
  await write(path.join(root, "TST-E0002", "seed.json"), { exam: { courseCode: "TST-E0002", title: "" }, concepts: [] });
  await write(path.join(root, "account.json"), {
    courses: { "TST-E0001": { aiAllowed: false, scope: "assignments" }, "TST-E0002": { aiAllowed: true } },
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  t = await createTestDb();
  [her, herCourse] = await addUserWithCourse(1001);
  [other, otherCourse] = await addUserWithCourse(2002);
  [course] = (await loadBundle(FIXTURE)).courses;
  plan = planImport(course);
}, T);

afterEach(async () => {
  await t.close();
});

describe("planImport (pure)", () => {
  it("renormalises the weights to sum to 1", () => {
    expect(plan.concepts.map((c) => c.weight)).toEqual([0.5, 0.25, 0.25]);
    expect(plan.concepts.map((c) => c.position)).toEqual([1, 2, 3]);
  });

  it("keeps the valid cards with their ids and reports the unknown slug and the parseCard failure", () => {
    expect(plan.cards.map((c) => c.importId)).toEqual(["tf-1", "tf-2", "tf-3", "tf-4", "tf-5"]);
    expect(plan.problems).toHaveLength(2);
    const [unknown, broken] = plan.problems;
    expect(unknown).toMatchObject({ file: "deck-1.json", lecture: 1, index: 6 });
    expect(unknown.reason).toContain('Unknown concept slug "exponential-smoothing"');
    expect(broken).toMatchObject({ file: "deck-1.json", lecture: 1, index: 7 });
    expect(broken.reason).toContain("exactly one correct option");
    expect(JSON.stringify(plan.problems)).not.toContain("smoothing constant"); // never the card's text
  });

  it("drops the fields M3-49 cannot hold, never failing a card for them, and lists them", () => {
    for (const p of plan.cards) {
      for (const f of ["id", "accept", "first", "beyondSlides", "basis", "quote", "fromFigure"]) expect(p.card).not.toHaveProperty(f);
    }
    const notes = plan.notes.join("\n");
    for (const f of ["accept", "first", "beyondSlides", "basis", "quote", "fromFigure"]) expect(notes).toContain(`"${f}" on 1 card`);
    expect(notes).toContain("body.importId");
  });

  it("turns gradeTarget into target_pct with the M3-13 scale, and startNewOn into Helsinki midnight", () => {
    expect(plan.exam.targetPct).toBe(80);
    expect(plan.startNewAt).toEqual(START);
    expect(plan.notes.join("\n")).toContain("startNewOn 2026-11-24");
  });

  it("reports a repeated card and a repeated id inside the bundle", () => {
    const base = { type: "basic", concept: "moving-average", source: "s" };
    const p = planImport({
      ...course,
      decks: [
        {
          lecture: 1,
          file: "d.json",
          cards: [
            { ...base, id: "a", q: "Q?", a: "A." },
            { ...base, q: "Q?", a: "A.", src: "elsewhere" },
            { ...base, id: "a", q: "Other?", a: "B." },
          ],
        },
      ],
    });
    expect(p.cards).toHaveLength(1);
    expect(p.problems).toEqual([
      { file: "d.json", lecture: 1, index: 2, reason: "Same card as d.json card 1; skipped." },
      { file: "d.json", lecture: 1, index: 3, reason: 'The card id "a" is also used by d.json card 1; skipped.' },
    ]);
  });

  it("takes concept positions from map.studyOrder, checks its slugs and lists what it cannot store", async () => {
    const [mapped] = (await loadBundle(root, { courses: ["tst-e0001"] })).courses;
    const p = planImport(mapped);
    const pos = Object.fromEntries(p.concepts.map((c) => [c.slug, c.position]));
    expect(pos).toEqual({ "trend-season": 1, "moving-average": 2, "error-measures": 3 });
    const notes = p.notes.join("\n");
    expect(notes).toContain("prerequisites (2 links) are not stored");
    expect(notes).toContain("threads (1 thread) are not stored");
    expect(notes).toContain('studyOrder groups (2 groups, such as "Exam essentials")');

    const bad = planImport({ ...mapped, map: { ...mapped.map!, prerequisites: { nope: ["moving-average"] } } });
    expect(bad.problems.some((x) => x.file === "map.json" && x.reason.includes('"nope"'))).toBe(true);
  });

  it("reads the AI permission and the exam documents of a course", async () => {
    const [mapped] = (await loadBundle(root, { courses: ["TST-E0001"] })).courses;
    const p = planImport(mapped);
    expect(p.aiPolicy).toBe("not_allowed");
    const notes = p.notes.join("\n");
    expect(notes).toContain('AI scope "assignments" is not stored');
    expect(notes).toContain("exam/ holds 2 valid documents (1 pdf, 1 text), not imported: no table holds exam documents");
    expect(p.problems).toContainEqual({ file: "exam/broken.json", reason: "is not valid JSON." });
  });
});

describe("loadBundle", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "bundle-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads one course per subfolder, and only the picked ones", async () => {
    const picked = await loadBundle(root, { courses: ["TST-E0001"] });
    expect(picked.courses.map((c) => c.seed.exam.courseCode)).toEqual(["TST-E0001"]);
    // Unpicked, TST-E0002 (not ready) blocks the run.
    const all = await loadBundle(root).catch((e: unknown) => e);
    expect(all).toBeInstanceOf(BundleInvalid);
    expect((all as BundleInvalid).problems.some((p) => p.startsWith("TST-E0002/seed.json"))).toBe(true);
    const missing = await loadBundle(root, { courses: ["TST-E9999"] }).catch((e: unknown) => e);
    expect((missing as BundleInvalid).problems[0]).toContain("No course TST-E9999 in this bundle");
  });

  it("refuses a bundle with a bad seed, a missing deck and a bad page, listing every problem", async () => {
    await write(path.join(dir, "seed.json"), {
      exam: { courseCode: "TST-E0001", title: "T", kind: "exam", at: "2026-12-10T09:00:00Z" },
      concepts: [{ slug: "a", name: "A", weight: 1 }],
      lectures: [{ n: 1, title: "L", deck: "decks/missing.json", page: "page.json" }],
    });
    await write(path.join(dir, "page.json"), { breath: "b", minutes: 3, sections: [] });
    const err = await loadBundle(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BundleInvalid);
    const problems = (err as BundleInvalid).problems;
    expect(problems.some((p) => p.startsWith("decks/missing.json"))).toBe(true);
    expect(problems.some((p) => p.startsWith("page.json") && p.includes("at least one section"))).toBe(true);
  });

  it("refuses non-positive weights, a bad gradeTarget, and targetPct and gradeTarget that disagree", async () => {
    const exam = { courseCode: "C", title: "T", kind: "exam", at: "2026-12-10T09:00:00Z" };
    for (const seed of [
      { exam, concepts: [{ slug: "a", name: "A", weight: 0 }], lectures: [] },
      { exam: { ...exam, gradeTarget: 6 }, concepts: [{ slug: "a", name: "A", weight: 1 }], lectures: [] },
      { exam: { ...exam, gradeTarget: 3, targetPct: 90 }, concepts: [{ slug: "a", name: "A", weight: 1 }], lectures: [] },
      { exam: { ...exam, startNewOn: "2026-02-30" }, concepts: [{ slug: "a", name: "A", weight: 1 }], lectures: [] },
    ]) {
      await write(path.join(dir, "seed.json"), seed);
      await expect(loadBundle(dir)).rejects.toBeInstanceOf(BundleInvalid);
    }
  });
});

describe("applyImport", () => {
  it(
    "first import creates the exam, concepts, lecture, page and cards",
    async () => {
      const result = await applyImport(t.db, her, plan, { now: NOW });
      expect(result.counts).toEqual({
        exam: { created: 1, skipped: 0, updated: 0 },
        concepts: { created: 3, skipped: 0, updated: 0 },
        lectures: { created: 1, skipped: 0, updated: 0 },
        pages: { created: 1, skipped: 0, updated: 0 },
        lectureConcepts: { created: 3, skipped: 0, updated: 0 },
        cards: { created: 5, skipped: 0, updated: 0 },
        aiPolicy: { created: 0, skipped: 0, updated: 0 },
      });
      expect(result.courseId).toBe(herCourse);

      const examRows = await t.db.select().from(exams).where(eq(exams.userId, her));
      expect(examRows).toHaveLength(1);
      expect(examRows[0]).toMatchObject({ courseId: herCourse, title: "Intro to Forecasting final exam", kind: "exam", targetPct: 80 });
      expect(examRows[0].at.toISOString()).toBe("2026-12-10T07:00:00.000Z");

      const conceptRows = await t.db.select().from(concepts).where(eq(concepts.examId, examRows[0].id));
      expect(conceptRows).toHaveLength(3);
      expect(conceptRows.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1, 10);
      expect(conceptRows.every((c) => c.lecture === "1" && c.userId === her)).toBe(true);

      const lectureRows = await t.db.select().from(lectures).where(eq(lectures.userId, her));
      expect(lectureRows).toMatchObject([{ courseId: herCourse, n: 1, title: "Why forecast at all" }]);
      const [content] = await t.db.select().from(lectureContent).where(eq(lectureContent.lectureId, lectureRows[0].id));
      expect(content.minutes).toBe(6);
      expect(content.sections).toHaveLength(3);
      expect(content.slideTitles).toHaveLength(12);
      expect(content.sourceHash).toMatch(/^[0-9a-f]{64}$/);

      const cardRows = await t.db.select().from(cards).where(eq(cards.userId, her));
      expect(cardRows).toHaveLength(5);
      expect(cardRows.every((c) => c.origin === "manual" && c.examId === examRows[0].id)).toBe(true);
      expect(cardRows.map((c) => c.contentHash).sort()).toEqual(plan.cards.map((p) => contentHash(p.card)).sort());
      const match = cardRows.find((c) => c.type === "match")!;
      expect(match).toMatchObject({ boss: true, source: "Lecture 1, slides 6-8" });
      expect(match.body).toEqual({
        q: "Match each word to its meaning.",
        pairs: [
          ["Trend", "Long-run direction"],
          ["Season", "Repeats each year"],
          ["Noise", "Random variation"],
        ],
        order: [2, 0, 1],
        importId: "tf-4",
      });
      // The stored body plus its columns parses back to the same card.
      const back = parseCard({ type: match.type, ...(match.body as object), concepts: ["x"], source: match.source });
      expect(back.ok && contentHash(back.card)).toBe(match.contentHash);

      const links = await t.db.select().from(cardConcepts);
      expect(links).toHaveLength(6); // the match card trains two concepts
      const nameOf = new Map(conceptRows.map((c) => [c.id, c.name]));
      expect(links.filter((l) => l.cardId === match.id).map((l) => nameOf.get(l.conceptId)).sort()).toEqual([
        "Moving averages",
        "Trend and seasonality",
      ]);

      // New cards are not due before startNewOn (00:00 Helsinki).
      const states = await t.db.select().from(cardStates);
      expect(states).toHaveLength(5);
      expect(states.every((s) => s.dueAt.getTime() === START.getTime() && s.lapses === 0 && s.lastReviewAt === null)).toBe(true);
      expect((states[0].fsrs as { state: number }).state).toBe(0);

      expect(await t.db.select().from(lectureConcepts)).toHaveLength(3);
    },
    T,
  );

  it(
    "new cards are due now when startNewOn has passed",
    async () => {
      const later = new Date("2026-11-30T08:00:00Z");
      await applyImport(t.db, her, plan, { now: later });
      const states = await t.db.select().from(cardStates);
      expect(states.every((s) => s.dueAt.getTime() === later.getTime())).toBe(true);
    },
    T,
  );

  it(
    "a second import adds nothing",
    async () => {
      await applyImport(t.db, her, plan, { now: NOW });
      const before = await rowCounts();
      const again = await applyImport(t.db, her, planImport((await loadBundle(FIXTURE)).courses[0]), { now: NOW });
      expect(again.counts).toEqual({
        exam: { created: 0, skipped: 1, updated: 0 },
        concepts: { created: 0, skipped: 3, updated: 0 },
        lectures: { created: 0, skipped: 1, updated: 0 },
        pages: { created: 0, skipped: 1, updated: 0 },
        lectureConcepts: { created: 0, skipped: 3, updated: 0 },
        cards: { created: 0, skipped: 5, updated: 0 },
        aiPolicy: { created: 0, skipped: 0, updated: 0 },
      });
      expect(await rowCounts()).toEqual(before);
    },
    T,
  );

  it(
    "matches an edited card by its stable id: updated in place, memory kept",
    async () => {
      await applyImport(t.db, her, plan, { now: NOW });
      const [before] = await t.db.select().from(cards).where(sql`${cards.body}->>'importId' = 'tf-1'`);
      const [stateBefore] = await t.db.select().from(cardStates).where(eq(cardStates.cardId, before.id));

      const edited = planImport({
        ...course,
        decks: course.decks.map((d) => ({
          ...d,
          cards: d.cards.map((c) => ((c as { id?: string }).id === "tf-1" ? { ...(c as object), a: "The average of the last three values." } : c)),
        })),
      });
      const result = await applyImport(t.db, her, edited, { now: NOW });
      expect(result.counts.cards).toEqual({ created: 0, skipped: 4, updated: 1 });

      const rows = await t.db.select().from(cards).where(eq(cards.userId, her));
      expect(rows).toHaveLength(5);
      const after = rows.find((c) => c.id === before.id)!;
      expect((after.body as { a: string }).a).toBe("The average of the last three values.");
      expect(after.contentHash).not.toBe(before.contentHash);
      const [stateAfter] = await t.db.select().from(cardStates).where(eq(cardStates.cardId, before.id));
      expect(stateAfter.id).toBe(stateBefore.id);
      expect(await t.db.select().from(cardConcepts).where(eq(cardConcepts.cardId, before.id))).toHaveLength(1);
    },
    T,
  );

  it(
    "reports the unknown slug and the parseCard failure, and skips both",
    async () => {
      const result = await applyImport(t.db, her, plan, { now: NOW });
      expect(result.problems.map((p) => p.index)).toEqual([6, 7]);
      expect(result.problems[0].reason).toContain("exponential-smoothing");
      const sources = (await t.db.select({ s: cards.source }).from(cards)).map((r) => r.s);
      expect(sources).not.toContain("Lecture 1, slide 12");
      expect(sources).not.toContain("Lecture 1, slide 5");
    },
    T,
  );

  it(
    "dry run counts everything and leaves every table unchanged",
    async () => {
      const before = await rowCounts();
      const result = await applyImport(t.db, her, plan, { dryRun: true, now: NOW });
      expect(result.dryRun).toBe(true);
      expect(result.counts.cards.created).toBe(5);
      expect(result.counts.exam.created).toBe(1);
      expect(await rowCounts()).toEqual(before);
    },
    T,
  );

  it(
    "writes the AI policy from account.json, once",
    async () => {
      const [mapped] = (await loadBundle(root, { courses: ["TST-E0001"] })).courses;
      const p = planImport(mapped);
      expect((await applyImport(t.db, her, p, { now: NOW })).counts.aiPolicy).toEqual({ created: 0, skipped: 0, updated: 1 });
      const [row] = await t.db.select().from(courses).where(eq(courses.id, herCourse));
      expect(row.aiPolicy).toBe("not_allowed");
      expect((await applyImport(t.db, her, p, { now: NOW })).counts.aiPolicy).toEqual({ created: 0, skipped: 1, updated: 0 });
      const [theirs] = await t.db.select().from(courses).where(eq(courses.id, otherCourse));
      expect(theirs.aiPolicy).toBe("unknown");
    },
    T,
  );

  it(
    "leaves another user's data alone, even with the same course code and the same card",
    async () => {
      const [theirExam] = await t.db.insert(exams).values({ userId: other, courseId: otherCourse, title: "Theirs", at: NOW }).returning();
      const [theirCard] = await t.db
        .insert(cards)
        .values({ userId: other, examId: theirExam.id, type: "basic", body: { q: "theirs", importId: "tf-1" }, origin: "ai", contentHash: plan.cards[0].hash })
        .returning();

      const result = await applyImport(t.db, her, plan, { now: NOW });
      expect(result.counts.cards.created).toBe(5);
      expect(result.courseId).toBe(herCourse);
      expect(await t.db.select().from(exams).where(eq(exams.userId, other))).toEqual([theirExam]);
      expect(await t.db.select().from(cards).where(eq(cards.userId, other))).toEqual([theirCard]);
      expect(await t.db.select().from(concepts).where(eq(concepts.userId, other))).toEqual([]);
      expect(await t.db.select().from(lectures).where(eq(lectures.userId, other))).toEqual([]);
    },
    T,
  );

  it(
    "keeps a lecture Moodle sync already made, and replaces a different page",
    async () => {
      const [synced] = await t.db.insert(lectures).values({ userId: her, courseId: herCourse, n: 1, title: "Synced title" }).returning();
      await t.db.insert(lectureContent).values({ lectureId: synced.id, breath: "old", sourceHash: "ai-hash" });
      const result = await applyImport(t.db, her, plan, { now: NOW });
      expect(result.counts.lectures).toEqual({ created: 0, skipped: 1, updated: 0 });
      expect(result.counts.pages).toEqual({ created: 0, skipped: 0, updated: 1 });
      const [row] = await t.db.select().from(lectures).where(eq(lectures.id, synced.id));
      expect(row.title).toBe("Synced title");
      const [content] = await t.db.select().from(lectureContent).where(eq(lectureContent.lectureId, synced.id));
      expect(content.minutes).toBe(6);
    },
    T,
  );

  it(
    "fails without writing when she has no course with the code",
    async () => {
      await t.db.delete(courses).where(eq(courses.id, herCourse));
      const before = await rowCounts();
      await expect(applyImport(t.db, her, plan, { now: NOW })).rejects.toBeInstanceOf(ImportFailed);
      expect(await rowCounts()).toEqual(before);
    },
    T,
  );

  it(
    "asks for --course-id when two of her courses share the code",
    async () => {
      const [second] = await t.db
        .insert(courses)
        .values({ userId: her, moodleId: 1002, code: "tst-e0001", name: "Intro to Forecasting (retake)" })
        .returning();
      await expect(applyImport(t.db, her, plan, { now: NOW })).rejects.toThrow(/--course-id/);
      expect((await applyImport(t.db, her, plan, { now: NOW, courseId: second.id })).courseId).toBe(second.id);
    },
    T,
  );

  it(
    "imports about 400 cards in batches",
    async () => {
      const many = Array.from({ length: 400 }, (_, i) => ({
        id: `bulk-${i}`,
        type: "basic",
        concepts: i % 2 ? ["moving-average"] : ["moving-average", "error-measures"],
        q: `Invented question number ${i}?`,
        a: `Answer ${i}.`,
        source: `Lecture 1, slide ${1 + (i % 12)}`,
      }));
      const big = planImport({ ...course, decks: [{ lecture: 1, file: "deck-1.json", cards: many }] });
      const started = Date.now();
      const result = await applyImport(t.db, her, big, { now: NOW });
      expect(result.counts.cards.created).toBe(400);
      expect(await t.db.select({ n: sql<number>`count(*)::int` }).from(cardStates)).toEqual([{ n: 400 }]);
      expect(await t.db.select({ n: sql<number>`count(*)::int` }).from(cardConcepts)).toEqual([{ n: 600 }]);
      expect(Date.now() - started).toBeLessThan(30_000);
      expect((await applyImport(t.db, her, big, { now: NOW })).counts.cards).toEqual({ created: 0, skipped: 400, updated: 0 });
    },
    T,
  );
});

describe("CLI", () => {
  it("parses its arguments", () => {
    expect(parseArgs(["b", "--moodle-user", "4242", "--dry-run"])).toEqual({
      ok: true,
      args: { folder: path.resolve("b"), user: { kind: "moodle", id: 4242 }, dryRun: true, courses: [] },
    });
    const id = "11111111-2222-3333-4444-555555555555";
    expect(parseArgs(["b", "--user", id, "--course", "tst-e0001", "--course", "TST-E0002"])).toMatchObject({
      ok: true,
      args: { user: { kind: "id", id }, dryRun: false, courses: ["TST-E0001", "TST-E0002"] },
    });
    expect(parseArgs(["b", "--user", id, "--course", "TST-E0001", "--course-id", id])).toMatchObject({ ok: true, args: { courseId: id } });
    expect(parseArgs(["b", "--user", id, "--course-id", id])).toMatchObject({ ok: false, error: expect.stringContaining("exactly one --course") });
    expect(parseArgs(["--help"])).toEqual({ ok: false, help: true });
    expect(parseArgs(["b"])).toMatchObject({ ok: false, error: expect.stringContaining("--user") });
    expect(parseArgs(["b", "--user", id, "--moodle-user", "1"])).toMatchObject({ ok: false, error: expect.stringContaining("not both") });
    expect(parseArgs(["b", "--user", "nope"])).toMatchObject({ ok: false, error: expect.stringContaining("uuid") });
    expect(parseArgs(["b", "--moodle-user", "x"])).toMatchObject({ ok: false });
    expect(parseArgs(["b", "--user"])).toMatchObject({ ok: false });
    expect(parseArgs(["b", "--wat", "--user", id])).toMatchObject({ ok: false, error: "Unknown option --wat." });
  });

  it(
    "dry run on a multi-course root through --moodle-user and --course prints problems, counts and notes, writes nothing",
    async () => {
      await t.db.insert(moodleConnections).values({ userId: her, siteUrl: "https://moodle.test", moodleUserId: 4242, tokenSealed: "x" });
      const before = await rowCounts();
      const out: string[] = [];
      const err: string[] = [];
      const code = await run([root, "--moodle-user", "4242", "--course", "TST-E0001", "--dry-run"], t.db, {
        out: (l) => out.push(l),
        err: (l) => err.push(l),
      });
      expect(err).toEqual([]);
      expect(code).toBe(0);
      const text = out.join("\n");
      expect(text).toContain("Course TST-E0001 (dry run");
      expect(text).toContain("deck-1.json card 6 (lecture 1): Unknown concept slug");
      expect(text).toMatch(/Cards\s+5 created, 0 already there/);
      expect(text).toContain("Not stored");
      expect(text).toContain("Dry run: nothing was written.");
      expect(text).not.toContain("smoothing constant"); // no card text
      expect(await rowCounts()).toEqual(before);
      const [row] = await t.db.select().from(courses).where(eq(courses.id, herCourse));
      expect(row.aiPolicy).toBe("unknown");
    },
    T,
  );

  it(
    "imports through --user and exits 1 for an unknown user, a missing folder or an unready course",
    async () => {
      const io = { out: () => {}, err: () => {} };
      expect(await run([FIXTURE, "--user", her], t.db, io)).toBe(0);
      expect((await t.db.select().from(cards).where(eq(cards.userId, her))).length).toBe(5);
      expect(await run([FIXTURE, "--user", "11111111-2222-3333-4444-555555555555"], t.db, io)).toBe(1);
      expect(await run([FIXTURE, "--moodle-user", "999"], t.db, io)).toBe(1);
      expect(await run([path.join(FIXTURE, "nope"), "--user", her], t.db, io)).toBe(1);
      expect(await run([root, "--user", her], t.db, io)).toBe(1); // TST-E0002 is not ready
    },
    T,
  );
});
