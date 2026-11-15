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
import { cardConcepts, cards, cardStates, concepts, examDocuments, exams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { parseArgs, run } from "../../../scripts/study/import-bundle";
import {
  applyImport,
  applyStudyOnly,
  BundleInvalid,
  ImportFailed,
  loadBundle,
  NO_EXAM_DATE,
  planImport,
  planStudyOnly,
  STUDY_ONLY_NO_CODE,
  STUDY_ONLY_WITH_EXAM,
  type CourseBundle,
  type ImportPlan,
} from "./import-bundle";

const FIXTURE = path.join(process.cwd(), "tests/fixtures/study/sample-bundle");
const STUDY_FIXTURE = path.join(process.cwd(), "tests/fixtures/study/sample-study-only");
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

const TABLES = { courses, exams, examDocuments, concepts, cards, cardConcepts, cardStates, lectures, lectureContent, lectureConcepts };

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
//   <root>/TST-E0001/{seed.json, deck-1.json, page-1.json, map.json, exam/...}  (the fixture plus more exam files)
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
  await mkdir(path.join(one, "exam"), { recursive: true });
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
    // Seed order is moving-average, trend-season, error-measures; map.studyOrder swaps the first two.
    expect(plan.concepts.map((c) => c.position)).toEqual([2, 1, 3]);
    const bare = planImport({ ...course, map: null });
    expect(bare.concepts.map((c) => c.position)).toEqual([1, 2, 3]);
    expect(bare.exam.studyMap).toBeNull();
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

  it("keeps the fields M3-49 has no place for as extras, never failing a card for them", () => {
    const extrasOf = (id: string) => plan.cards.find((p) => p.importId === id)!.extras;
    expect(extrasOf("tf-3")).toEqual({ quote: "MAE keeps the units of the series.", fromFigure: "Figure 1.3" });
    expect(extrasOf("tf-5")).toEqual({ beyondSlides: true, basis: "Lecture 1 summary slide" });
    expect(extrasOf("tf-1")).toEqual({});
    const notes = plan.notes.join("\n");
    for (const f of ["beyondSlides", "basis", "quote", "fromFigure", "accept", "first", "core", "importId"]) expect(notes).not.toContain(f);
    // Part of the card format since M3-52: accept (the array shorthand of a one-blank cloze), first and core.
    const tf2 = plan.cards.find((p) => p.importId === "tf-2");
    expect(tf2?.card).toMatchObject({ accept: { seasonality: ["seasonal pattern", "season"] } });
    expect(plan.cards.find((p) => p.importId === "tf-1")?.card).toMatchObject({ first: true, core: true });

    // An extra field of any shape, and a field nobody named, never fail a card.
    const odd = planImport({
      ...course,
      decks: [{ lecture: 1, file: "d.json", cards: [{ type: "basic", concept: "moving-average", source: "s", q: "Q?", a: "A.", quote: { odd: [1] }, basis: null, mystery: 7 }] }],
    });
    expect(odd.problems).toEqual([]);
    expect(odd.cards[0].extras).toEqual({ quote: { odd: [1] } });
  });

  it("turns gradeTarget into target_pct with the M3-13 scale, and startNewOn into Helsinki midnight", () => {
    expect(plan.exam.targetPct).toBe(80);
    expect(plan.exam.gradeTarget).toBe(4);
    expect(plan.exam.startNewOn).toBe("2026-11-24");
    expect(plan.startNewAt).toEqual(START);
  });

  it("plans the map and the Markdown document of the sample", () => {
    expect(plan.exam.studyMap).toEqual(MAP);
    expect(plan.documents).toHaveLength(1);
    expect(plan.documents[0]).toMatchObject({ file: "exam/study-plan.md", slug: "study-plan", title: "Study plan for the forecasting exam", position: 1 });
    expect(plan.documents[0].bodyMd).toContain("## Week 2");
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

  it("takes concept positions from map.studyOrder, checks its slugs and keeps the map as given", async () => {
    const [mapped] = (await loadBundle(root, { courses: ["tst-e0001"] })).courses;
    const p = planImport(mapped);
    const pos = Object.fromEntries(p.concepts.map((c) => [c.slug, c.position]));
    expect(pos).toEqual({ "trend-season": 1, "moving-average": 2, "error-measures": 3 });
    expect(p.exam.studyMap).toEqual(MAP);
    expect(p.notes.join("\n")).not.toContain("are not stored");

    const bad = planImport({ ...mapped, map: { ...mapped.map!, prerequisites: { nope: ["moving-average"] } } });
    expect(bad.problems.some((x) => x.file === "map.json" && x.reason.includes('"nope"'))).toBe(true);
  });

  it("reads the AI permission and the exam documents of a course", async () => {
    const [mapped] = (await loadBundle(root, { courses: ["TST-E0001"] })).courses;
    const p = planImport(mapped);
    expect(p.aiPolicy).toEqual({ aiAssignments: "off", aiStudy: "allowed" });
    expect(p.notes.join("\n")).not.toContain("AI scope");
    expect(p.notStored.join("\n")).toContain("exam/ holds 1 valid file that is not Markdown (1 pdf), not imported");
    // What is stored (the study order) is a note, never under "not stored".
    expect(p.notes.join("\n")).toContain("studyOrder sets the position");
    expect(p.notStored.join("\n")).not.toContain("studyOrder");
    expect(p.problems).toContainEqual({ file: "exam/broken.json", reason: "is not valid JSON." });
    // The seed lists study-plan.md, so it comes first; essentials.md follows in file-name order.
    expect(p.documents.map((d) => [d.slug, d.title, d.position])).toEqual([
      ["study-plan", "Study plan for the forecasting exam", 1],
      ["essentials", "Exam essentials", 2],
    ]);
  });

  it("orders documents by file name without a seed list, titles one without a heading by its file name, and reports a bad list or name clash", () => {
    const doc = (file: string, text: string) => ({ file, kind: "text" as const, bytes: text.length, text });
    const p = planImport({
      ...course,
      seed: { ...course.seed, documents: ["exam/02-plan.md", "missing.md"] },
      examDocs: [doc("exam/01-rules.md", "No heading here.\n"), doc("exam/02-plan.md", "## Plan ##\n"), doc("exam/02 plan.md", "# Twin\n"), { file: "exam/notes.txt", kind: "text", bytes: 3 }],
    });
    expect(p.documents.map((d) => [d.slug, d.title, d.position])).toEqual([
      ["02-plan", "Plan", 1],
      ["01-rules", "01-rules", 2],
    ]);
    expect(p.problems).toContainEqual({ file: "seed.json", reason: "documents names exam/missing.md, which is not a Markdown file in exam/." });
    expect(p.problems).toContainEqual({ file: "exam/02 plan.md", reason: "has the same name as exam/02-plan.md; skipped." });
    expect(p.notStored.join("\n")).toContain("1 valid file that is not Markdown (1 text)");
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

  it("refuses non-positive weights, a bad gradeTarget and a bad start date", async () => {
    const exam = { courseCode: "C", title: "T", kind: "exam", at: "2026-12-10T09:00:00Z" };
    for (const seed of [
      { exam, concepts: [{ slug: "a", name: "A", weight: 0 }], lectures: [] },
      { exam: { ...exam, gradeTarget: 6 }, concepts: [{ slug: "a", name: "A", weight: 1 }], lectures: [] },
      { exam: { ...exam, gradeTarget: { grade: 9 } }, concepts: [{ slug: "a", name: "A", weight: 1 }], lectures: [] },
      { exam: { ...exam, startNewOn: "2026-02-30" }, concepts: [{ slug: "a", name: "A", weight: 1 }], lectures: [] },
    ]) {
      await write(path.join(dir, "seed.json"), seed);
      await expect(loadBundle(dir)).rejects.toBeInstanceOf(BundleInvalid);
    }
  });
});

describe("targets and names as a hand-made bundle writes them", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "bundle-"));
    await cp(FIXTURE, dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const edit = async (change: (seed: { exam: Record<string, unknown>; concepts: Record<string, unknown>[] }) => void) => {
    const seed = JSON.parse(await readFile(path.join(dir, "seed.json"), "utf8"));
    change(seed);
    await write(path.join(dir, "seed.json"), seed);
    return planImport((await loadBundle(dir)).courses[0]);
  };

  it("reads the grade from a gradeTarget object and keeps the object whole", async () => {
    const p = await edit((s) => (s.exam.gradeTarget = { grade: 3, examPointsNeeded: 24, of: 40 }));
    expect(p.exam.targetPct).toBe(70);
    expect(p.exam.gradeTarget).toEqual({ grade: 3, examPointsNeeded: 24, of: 40 });
  });

  it("accepts targetPct beside a gradeTarget that says something else: the percent is the target, both are kept", async () => {
    const p = await edit((s) => Object.assign(s.exam, { targetPct: 66, gradeTarget: { grade: 4 } }));
    expect(p.exam.targetPct).toBe(66);
    expect(p.exam.gradeTarget).toEqual({ grade: 4 });
    expect(p.notes.join("\n")).toContain("exam.targetPct (66%) is used as the target");
  });

  it("keeps a studyOrder of lectures or groups in the map and leaves concepts in the seed's order", async () => {
    await write(path.join(dir, "map.json"), { prerequisites: {}, threads: [], studyOrder: ["lecture-1", "exam-essentials"] });
    const p = await edit(() => {});
    expect(p.problems).toEqual(expect.not.arrayContaining([expect.objectContaining({ file: "map.json" })]));
    expect(p.concepts.map((c) => c.position)).toEqual([1, 2, 3]);
    expect(p.exam.studyMap?.studyOrder).toEqual(["lecture-1", "exam-essentials"]);
    expect(p.notes.join("\n")).toContain("studyOrder orders lectures or groups");
  });

  it("lets two concepts share a name: they are told apart by slug", async () => {
    const p = await edit((s) => s.concepts.push({ slug: "moving-average-2", name: s.concepts[0].name, lecture: 1, position: 9, weight: 1 }));
    expect(p.concepts.filter((c) => c.name === "Moving averages").map((c) => c.slug)).toEqual(["moving-average", "moving-average-2"]);
  });

  it("prefers course folders over a stray seed.json at the root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bundle-root-"));
    try {
      await cp(FIXTURE, path.join(root, "TST-E0001"), { recursive: true });
      await cp(STUDY_FIXTURE, path.join(root, "TST-E0003"), { recursive: true });
      await cp(path.join(FIXTURE, "seed.json"), path.join(root, "seed.json"));
      const bundle = await loadBundle(root);
      expect(bundle.courses.map((c) => c.seed.exam.courseCode)).toEqual(["TST-E0001"]);
      expect(bundle.studyOnly.map((c) => c.courseCode)).toEqual(["TST-E0003"]);

      // The stray copy's map is the only one: the course folder's seed names it, the root holds it.
      await cp(path.join(root, "TST-E0001", "map.json"), path.join(root, "map.json"));
      await rm(path.join(root, "TST-E0001", "map.json"));
      const moved = await loadBundle(root);
      expect(planImport(moved.courses[0]).exam.studyMap).toEqual(planImport(bundle.courses[0]).exam.studyMap);
      expect(planImport(moved.courses[0]).exam.studyMap).not.toBeNull();
      // Without the stray seed the root map belongs to nobody: the missing map is a problem again.
      await rm(path.join(root, "seed.json"));
      await expect(loadBundle(root)).rejects.toBeInstanceOf(BundleInvalid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("a bundle that cannot be imported yet", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "bundle-"));
    await cp(FIXTURE, dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function dryRun(folder: string, extra: string[] = []) {
    const before = await rowCounts();
    const out: string[] = [];
    const err: string[] = [];
    const code = await run([folder, "--user", her, "--dry-run", ...extra], t.db, { out: (l) => out.push(l), err: (l) => err.push(l) });
    expect(await rowCounts()).toEqual(before);
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it(
    "the dry run refuses an exam with no date yet (at: null, atIsPlaceholderTime: true)",
    async () => {
      const seed = JSON.parse(await readFile(path.join(dir, "seed.json"), "utf8"));
      await write(path.join(dir, "seed.json"), { ...seed, exam: { ...seed.exam, at: null, atIsPlaceholderTime: true } });
      const err = await loadBundle(dir).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BundleInvalid);
      expect((err as BundleInvalid).problems).toEqual([`seed.json (at exam.at): ${NO_EXAM_DATE}`]);

      const r = await dryRun(dir);
      expect(r.code).toBe(1);
      expect(r.err).toContain("exam.at is missing: this bundle has no exam date yet. Get the date first; nothing was imported.");
      expect(r.out).toBe("");

      // The same when the key is not there at all; a date that is not one keeps its own message.
      const { at: _at, ...noAt } = seed.exam;
      void _at;
      await write(path.join(dir, "seed.json"), { ...seed, exam: noAt });
      expect(((await loadBundle(dir).catch((e: unknown) => e)) as BundleInvalid).problems).toEqual([`seed.json (at exam.at): ${NO_EXAM_DATE}`]);
      await write(path.join(dir, "seed.json"), { ...seed, exam: { ...seed.exam, at: "soon" } });
      expect(((await loadBundle(dir).catch((e: unknown) => e)) as BundleInvalid).problems[0]).toContain("must be an ISO date and time");
    },
    T,
  );

  it("refuses a seed that is study-only and still has an exam, and a study-only seed with no course code", async () => {
    const seed = JSON.parse(await readFile(path.join(dir, "seed.json"), "utf8"));
    await write(path.join(dir, "seed.json"), { ...seed, studyOnly: true });
    expect(((await loadBundle(dir).catch((e: unknown) => e)) as BundleInvalid).problems).toEqual([`seed.json: ${STUDY_ONLY_WITH_EXAM}`]);
    const { exam: _exam, ...rest } = seed;
    void _exam;
    await write(path.join(dir, "seed.json"), { ...rest, studyOnly: true });
    expect(((await loadBundle(dir).catch((e: unknown) => e)) as BundleInvalid).problems).toEqual([`seed.json: ${STUDY_ONLY_NO_CODE}`]);
  });
});

describe("a study-only course (M3-56)", () => {
  let studyCourse: string;
  const SUMMARY_FIRST = "Study-only course: 1 lecture page imported, 3 cards not imported (cards need an exam)";

  beforeEach(async () => {
    const [c] = await t.db.insert(courses).values({ userId: her, moodleId: 1003, code: "TST-E0003", name: "Intro to Service Sketching" }).returning();
    studyCourse = c.id;
  }, T);

  async function studyPlan() {
    const bundle = await loadBundle(STUDY_FIXTURE);
    expect(bundle.courses).toEqual([]);
    expect(bundle.studyOnly).toHaveLength(1);
    return planStudyOnly(bundle.studyOnly[0]);
  }

  it("plans its lecture and page, and counts the cards and concepts it leaves out", async () => {
    const p = await studyPlan();
    expect(p.courseCode).toBe("TST-E0003");
    expect(p.lectures).toMatchObject([{ n: 1, title: "What a service sketch shows" }]);
    expect(p.lectures[0].pageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.cardsNotImported).toBe(3);
    expect(p.problems).toEqual([]);
    expect(p.notStored).toEqual(["2 concepts not imported (concepts need an exam)."]);
  });

  it(
    "creates its lecture page and no exam, concept or card, and reports the skipped cards",
    async () => {
      const before = await rowCounts();
      const result = await applyStudyOnly(t.db, her, await studyPlan());
      expect(result.summary).toBe(SUMMARY_FIRST);
      expect(result.cardsNotImported).toBe(3);
      expect(result.courseId).toBe(studyCourse);
      expect(result.counts).toEqual({
        lectures: { created: 1, skipped: 0, updated: 0 },
        pages: { created: 1, skipped: 0, updated: 0 },
        aiPolicy: { created: 0, skipped: 0, updated: 0 },
      });
      const after = await rowCounts();
      expect(after).toEqual({ ...before, lectures: before.lectures + 1, lectureContent: before.lectureContent + 1 });
      for (const table of ["exams", "concepts", "cards", "cardStates", "cardConcepts", "lectureConcepts", "examDocuments"]) expect(after[table]).toBe(0);

      const [lecture] = await t.db.select().from(lectures).where(eq(lectures.userId, her));
      expect(lecture).toMatchObject({ courseId: studyCourse, n: 1, title: "What a service sketch shows" });
      const [content] = await t.db.select().from(lectureContent).where(eq(lectureContent.lectureId, lecture.id));
      expect(content).toMatchObject({ minutes: 4 });
      expect(content.sections).toHaveLength(2);
      expect(content.slideTitles).toHaveLength(7);
    },
    T,
  );

  it(
    "a second import adds nothing, and a dry run writes nothing",
    async () => {
      const dry = await applyStudyOnly(t.db, her, await studyPlan(), { dryRun: true });
      expect(dry.dryRun).toBe(true);
      expect(dry.summary).toBe(SUMMARY_FIRST);
      expect(await t.db.select().from(lectures)).toEqual([]);

      await applyStudyOnly(t.db, her, await studyPlan());
      const before = await rowCounts();
      const again = await applyStudyOnly(t.db, her, await studyPlan());
      expect(again.counts).toEqual({
        lectures: { created: 0, skipped: 1, updated: 0 },
        pages: { created: 0, skipped: 1, updated: 0 },
        aiPolicy: { created: 0, skipped: 0, updated: 0 },
      });
      expect(again.summary).toBe("Study-only course: 0 lecture pages imported, 3 cards not imported (cards need an exam)");
      expect(await rowCounts()).toEqual(before);
    },
    T,
  );

  it(
    "through the CLI in a multi-course root: found by its folder name, AI rules applied, a bad deck reported but not fatal",
    async () => {
      const many = await mkdtemp(path.join(os.tmpdir(), "bundle-many-"));
      try {
        await cp(FIXTURE, path.join(many, "TST-E0001"), { recursive: true });
        await cp(STUDY_FIXTURE, path.join(many, "TST-E0003"), { recursive: true });
        const seed = JSON.parse(await readFile(STUDY_FIXTURE + "/seed.json", "utf8"));
        const { courseCode: _code, ...noCode } = seed;
        void _code;
        // No courseCode: the folder's name is the code. A second lecture's deck is missing.
        await write(path.join(many, "TST-E0003", "seed.json"), {
          ...noCode,
          lectures: [...noCode.lectures, { n: 2, title: "Front stage and back stage", deck: "deck-2.json" }],
        });
        await write(path.join(many, "account.json"), { courses: { "TST-E0003": { aiAllowed: false, scope: "assignments" } } });

        const out: string[] = [];
        const err: string[] = [];
        const code = await run([many, "--user", her], t.db, { out: (l) => out.push(l), err: (l) => err.push(l) });
        expect(err).toEqual([]);
        expect(code).toBe(0);
        const text = out.join("\n");
        expect(text).toContain(`Course TST-E0003:\n  ${SUMMARY_FIRST}`);
        expect(text).toMatch(/Lectures\s+2 created/);
        expect(text).toContain("deck-2.json (lecture 2): cannot be read (missing?).");
        expect(text).toContain("Imported 2 course(s).");

        const [row] = await t.db.select().from(courses).where(eq(courses.id, studyCourse));
        expect(row).toMatchObject({ aiAssignments: "off", aiStudy: "allowed" });
        expect(await t.db.select().from(exams).where(eq(exams.courseId, studyCourse))).toEqual([]);
        expect(await t.db.select().from(lectures).where(eq(lectures.courseId, studyCourse))).toHaveLength(2);
        expect(await t.db.select().from(cards).where(eq(cards.userId, her))).toHaveLength(5); // TST-E0001's only
      } finally {
        await rm(many, { recursive: true, force: true });
      }
    },
    T,
  );
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
        documents: { created: 1, skipped: 0, updated: 0 },
        aiPolicy: { created: 0, skipped: 0, updated: 0 },
      });
      expect(result.courseId).toBe(herCourse);

      const examRows = await t.db.select().from(exams).where(eq(exams.userId, her));
      expect(examRows).toHaveLength(1);
      expect(examRows[0]).toMatchObject({ courseId: herCourse, title: "Intro to Forecasting final exam", kind: "exam", targetPct: 80 });
      expect(examRows[0].at.toISOString()).toBe("2026-12-10T07:00:00.000Z");
      // The exam has its map, start date, grade target and one document.
      expect(examRows[0].studyMap).toEqual(MAP);
      expect(examRows[0].startNewOn).toBe("2026-11-24");
      expect(examRows[0].gradeTarget).toBe(4);
      const docs = await t.db.select().from(examDocuments);
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({ userId: her, examId: examRows[0].id, slug: "study-plan", title: "Study plan for the forecasting exam", position: 1 });
      expect(docs[0].bodyMd).toBe(await readFile(path.join(FIXTURE, "exam/study-plan.md"), "utf8"));

      const conceptRows = await t.db.select().from(concepts).where(eq(concepts.examId, examRows[0].id));
      expect(conceptRows).toHaveLength(3);
      expect(conceptRows.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1, 10);
      expect(conceptRows.every((c) => c.lecture === "1" && c.userId === her)).toBe(true);
      expect(Object.fromEntries(conceptRows.map((c) => [c.slug, c.position]))).toEqual({ "trend-season": 1, "moving-average": 2, "error-measures": 3 });

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
      });
      expect(match.importId).toBe("tf-4");
      // A card's accept and first survive the import, and so do core and the extra fields.
      const bodyOf = (id: string) => cardRows.find((c) => c.importId === id)!.body;
      expect(bodyOf("tf-2")).toEqual({
        q: "A pattern that repeats every year at the same time is called {{seasonality}}.",
        accept: { seasonality: ["seasonal pattern", "season"] },
      });
      expect(bodyOf("tf-1")).toMatchObject({ first: true, core: true });
      expect(bodyOf("tf-3")).toMatchObject({ quote: "MAE keeps the units of the series.", fromFigure: "Figure 1.3" });
      expect(bodyOf("tf-5")).toMatchObject({ beyondSlides: true, basis: "Lecture 1 summary slide" });
      expect(cardRows.every((c) => !("importId" in (c.body as object)))).toBe(true);
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
        documents: { created: 0, skipped: 1, updated: 0 },
        aiPolicy: { created: 0, skipped: 0, updated: 0 },
      });
      expect(await rowCounts()).toEqual(before);
    },
    T,
  );

  it(
    "a re-import of cards first imported with body.importId (M3-51) updates them in place and keeps her memory",
    async () => {
      await applyImport(t.db, her, plan, { now: NOW });
      // Put the account back to how M3-51 left it: the id inside the body, no extras, no slugs,
      // nothing on the exam, no documents.
      for (const c of await t.db.select().from(cards).where(eq(cards.userId, her))) {
        const { quote: _q, fromFigure: _f, beyondSlides: _b, basis: _s, ...body } = c.body as Record<string, unknown>;
        void [_q, _f, _b, _s];
        await t.db.update(cards).set({ importId: null, body: { ...body, importId: c.importId } }).where(eq(cards.id, c.id));
      }
      await t.db.update(concepts).set({ slug: null }).where(eq(concepts.userId, her));
      await t.db.update(exams).set({ studyMap: null, startNewOn: null, gradeTarget: null }).where(eq(exams.userId, her));
      await t.db.delete(examDocuments);
      // She has studied tf-1 since.
      const [tf1] = await t.db.select().from(cards).where(sql`${cards.body}->>'importId' = 'tf-1'`);
      const reviewed = new Date("2026-11-25T09:00:00Z");
      await t.db
        .update(cardStates)
        .set({ fsrs: { marker: "her memory" }, dueAt: new Date("2026-11-28T09:00:00Z"), lapses: 2, lastReviewAt: reviewed })
        .where(eq(cardStates.cardId, tf1.id));
      const idsBefore = (await t.db.select({ id: cards.id }).from(cards)).map((r) => r.id).sort();
      const statesBefore = await t.db.select().from(cardStates).orderBy(cardStates.id);
      const linksBefore = await t.db.select().from(cardConcepts);
      const conceptIdsBefore = (await t.db.select({ id: concepts.id }).from(concepts)).map((r) => r.id).sort();

      const again = await applyImport(t.db, her, plan, { now: new Date("2026-11-26T09:00:00Z") });
      expect(again.counts).toMatchObject({
        exam: { created: 0, skipped: 0, updated: 1 },
        concepts: { created: 0, skipped: 0, updated: 3 },
        cards: { created: 0, skipped: 0, updated: 5 },
        documents: { created: 1, skipped: 0, updated: 0 },
      });
      expect(again.problems).toHaveLength(2); // the same two skipped cards, nothing new

      const rows = await t.db.select().from(cards).where(eq(cards.userId, her));
      expect(rows.map((r) => r.id).sort()).toEqual(idsBefore);
      expect(rows.map((r) => r.importId).sort()).toEqual(["tf-1", "tf-2", "tf-3", "tf-4", "tf-5"]);
      expect(rows.every((r) => !("importId" in (r.body as object)))).toBe(true);
      expect(rows.find((r) => r.importId === "tf-3")!.body).toMatchObject({ quote: "MAE keeps the units of the series." });
      // Her memory of every card is the same row with the same content.
      expect(await t.db.select().from(cardStates).orderBy(cardStates.id)).toEqual(statesBefore);
      const [state] = await t.db.select().from(cardStates).where(eq(cardStates.cardId, tf1.id));
      expect(state).toMatchObject({ fsrs: { marker: "her memory" }, lapses: 2, lastReviewAt: reviewed });
      expect((await t.db.select().from(cardConcepts)).map((l) => [l.cardId, l.conceptId]).sort()).toEqual(
        linksBefore.map((l) => [l.cardId, l.conceptId]).sort(),
      );
      // The concepts are the same rows, now with their slugs; the exam has its map again.
      const conceptRows = await t.db.select().from(concepts);
      expect(conceptRows.map((c) => c.id).sort()).toEqual(conceptIdsBefore);
      expect(conceptRows.map((c) => c.slug).sort()).toEqual(["error-measures", "moving-average", "trend-season"]);
      const [exam] = await t.db.select().from(exams).where(eq(exams.userId, her));
      expect(exam).toMatchObject({ studyMap: MAP, startNewOn: "2026-11-24", gradeTarget: 4 });

      const third = await applyImport(t.db, her, plan, { now: NOW });
      expect(third.counts).toMatchObject({
        exam: { created: 0, skipped: 1, updated: 0 },
        concepts: { created: 0, skipped: 3, updated: 0 },
        cards: { created: 0, skipped: 5, updated: 0 },
        documents: { created: 0, skipped: 1, updated: 0 },
      });
    },
    T,
  );

  it(
    "matches a renamed concept by its slug, updates an edited document, and updates a card whose accept changed",
    async () => {
      await applyImport(t.db, her, plan, { now: NOW });
      const before = await rowCounts();
      const edited = planImport({
        ...course,
        seed: { ...course.seed, concepts: course.seed.concepts.map((c) => (c.slug === "trend-season" ? { ...c, name: "Trend and seasons" } : c)) },
        examDocs: course.examDocs.map((d) => (d.text ? { ...d, text: `${d.text}\nOne more line.\n` } : d)),
        decks: course.decks.map((d) => ({
          ...d,
          cards: d.cards.map((c) => ((c as { id?: string }).id === "tf-2" ? { ...(c as object), accept: ["seasonal"] } : c)),
        })),
      });
      const result = await applyImport(t.db, her, edited, { now: NOW });
      expect(result.counts).toMatchObject({
        concepts: { created: 0, skipped: 2, updated: 1 },
        documents: { created: 0, skipped: 0, updated: 1 },
        cards: { created: 0, skipped: 4, updated: 1 },
      });
      expect(await rowCounts()).toEqual(before);
      const [concept] = await t.db.select().from(concepts).where(eq(concepts.slug, "trend-season"));
      expect(concept.name).toBe("Trend and seasons");
      const [tf2] = await t.db.select().from(cards).where(eq(cards.importId, "tf-2"));
      expect((tf2.body as { accept: unknown }).accept).toEqual({ seasonality: ["seasonal"] });
      const [docRow] = await t.db.select().from(examDocuments);
      expect(docRow.bodyMd).toContain("One more line.");
    },
    T,
  );

  it(
    "matches an edited card by its stable id: updated in place, memory kept",
    async () => {
      await applyImport(t.db, her, plan, { now: NOW });
      const [before] = await t.db.select().from(cards).where(eq(cards.importId, "tf-1"));
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
      // aiAllowed false + scope "assignments": no assignment help, studying the slides is fine.
      expect(row).toMatchObject({ aiAssignments: "off", aiStudy: "allowed" });
      expect((await applyImport(t.db, her, p, { now: NOW })).counts.aiPolicy).toEqual({ created: 0, skipped: 1, updated: 0 });
      const [theirs] = await t.db.select().from(courses).where(eq(courses.id, otherCourse));
      expect(theirs).toMatchObject({ aiAssignments: "unknown", aiStudy: "unknown" });
    },
    T,
  );

  it(
    "maps aiAllowed true to both allowed, and never overwrites her answer when it is unknown or missing",
    async () => {
      const [mapped] = (await loadBundle(root, { courses: ["TST-E0001"] })).courses;
      expect(planImport({ ...mapped, account: { aiAllowed: true, other: [] } }).aiPolicy).toEqual({
        aiAssignments: "allowed",
        aiStudy: "allowed",
      });
      expect(planImport({ ...mapped, account: { aiAllowed: false, other: [] } }).aiPolicy).toEqual({
        aiAssignments: "off",
        aiStudy: "not_allowed",
      });

      // She answered herself; an "unknown" or missing aiAllowed leaves it alone.
      await t.db.update(courses).set({ aiAssignments: "explain", aiStudy: "not_allowed" }).where(eq(courses.id, herCourse));
      for (const account of [{ aiAllowed: "unknown" as const, other: [] }, { other: [] }, null]) {
        const p = planImport({ ...mapped, account });
        expect(p.aiPolicy).toBeNull();
        await applyImport(t.db, her, p, { now: NOW });
        const [row] = await t.db.select().from(courses).where(eq(courses.id, herCourse));
        expect(row).toMatchObject({ aiAssignments: "explain", aiStudy: "not_allowed" });
      }
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
      // The documents count, and the headings say what is under them.
      expect(text).toMatch(/Exam documents\s+2 created, 0 already there/);
      const notStoredAt = out.indexOf("  Not stored:");
      const notesAt = out.indexOf("  Notes (how the bundle was read):");
      expect(notStoredAt).toBeGreaterThan(-1);
      expect(notesAt).toBeGreaterThan(notStoredAt);
      expect(out.slice(notStoredAt + 1, notesAt)).toEqual([
        "    - exam/ holds 1 valid file that is not Markdown (1 pdf), not imported: exam_documents holds Markdown only.",
      ]);
      expect(out.slice(notesAt + 1).join("\n")).toContain("studyOrder sets the position of 3 concepts.");
      expect(text).not.toContain("(no field in the schema or the card format)");
      expect(text).toContain("Dry run: nothing was written.");
      expect(text).not.toContain("smoothing constant"); // no card text
      expect(await rowCounts()).toEqual(before);
      const [row] = await t.db.select().from(courses).where(eq(courses.id, herCourse));
      expect(row).toMatchObject({ aiAssignments: "unknown", aiStudy: "unknown" });
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

describe("account.json in the M3-57 shape", () => {
  let newRoot: string;
  beforeAll(async () => {
    newRoot = await mkdtemp(path.join(os.tmpdir(), "bundle-new-account-"));
    // One seed with no exam date, one with no exam at all; account.json holds both exams.
    await cp(FIXTURE, path.join(newRoot, "TST-E0001"), { recursive: true });
    const seed = JSON.parse(await readFile(path.join(newRoot, "TST-E0001", "seed.json"), "utf8"));
    await write(path.join(newRoot, "TST-E0001", "seed.json"), { ...seed, exam: { ...seed.exam, at: null } });
    await cp(FIXTURE, path.join(newRoot, "TST-E0004"), { recursive: true });
    const { exam: _exam, ...noExam } = seed;
    void _exam;
    await write(path.join(newRoot, "TST-E0004", "seed.json"), noExam);
    await write(path.join(newRoot, "account.json"), {
      exams: [
        { courseCode: "TST-E0001", title: "intro to forecasting FINAL exam", kind: "exam", at: "2026-12-12T09:00:00+02:00", source: "invented" },
        { courseCode: "TST-E0004", title: "Invented quiz", kind: "quiz", at: "2026-12-14T10:00:00+02:00" },
        { courseCode: "TST-E0005", title: "Undated", kind: "exam", at: null },
      ],
      gradeWeights: [],
      aiAllowed: [
        { courseCode: "TST-E0001", allowed: false, scope: "assignments" },
        { courseCode: "tst-e0004", allowed: true, extra: 1 },
      ],
      unknown: [],
      noExam: [],
    });
  });
  afterAll(async () => {
    await rm(newRoot, { recursive: true, force: true });
  });

  it("maps the aiAllowed list like the old record, and still reads the old shape", async () => {
    const bundle = await loadBundle(newRoot);
    const one = bundle.courses.find((c) => c.seed.exam.courseCode === "TST-E0001")!;
    const four = bundle.courses.find((c) => c.seed.exam.courseCode === "TST-E0004")!;
    expect(planImport(one).aiPolicy).toEqual({ aiAssignments: "off", aiStudy: "allowed" });
    const p4 = planImport(four);
    expect(p4.aiPolicy).toEqual({ aiAssignments: "allowed", aiStudy: "allowed" });
    expect(p4.notStored.join(" ")).toContain("extra");
    // The old shape (the shared root above) is unchanged.
    const [old] = (await loadBundle(root, { courses: ["TST-E0001"] })).courses;
    expect(planImport(old).aiPolicy).toEqual({ aiAssignments: "off", aiStudy: "allowed" });
  });

  it("fills a seed's missing exam date, or its missing exam, from account.json's exams", async () => {
    const bundle = await loadBundle(newRoot);
    const one = planImport(bundle.courses.find((c) => c.seed.exam.courseCode === "TST-E0001")!);
    expect(one.exam.title).toBe("Intro to Forecasting final exam");
    expect(one.exam.at).toEqual(new Date("2026-12-12T07:00:00Z"));
    expect(one.notes.join(" ")).toMatch(/date is from account\.json/);
    const four = planImport(bundle.courses.find((c) => c.seed.exam.courseCode === "TST-E0004")!);
    expect(four.exam).toMatchObject({ title: "Invented quiz", kind: "quiz", at: new Date("2026-12-14T08:00:00Z") });
  });

  it("still refuses a seed with no date when account.json has none for it either", async () => {
    const lone = await mkdtemp(path.join(os.tmpdir(), "bundle-no-date-"));
    try {
      await cp(path.join(newRoot, "TST-E0001"), path.join(lone, "TST-E0001"), { recursive: true });
      await write(path.join(lone, "account.json"), { exams: [{ courseCode: "TST-E0001", title: "Another exam", at: "2026-12-12T09:00:00Z" }] });
      const err = await loadBundle(lone).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BundleInvalid);
      expect((err as BundleInvalid).problems.join(" ")).toContain(NO_EXAM_DATE);
    } finally {
      await rm(lone, { recursive: true, force: true });
    }
  });
});
