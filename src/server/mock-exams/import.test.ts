// @vitest-environment node
import { cp, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sampleDrill, sampleExam } from "@/lib/mock-exams/sample-exam";
import type { MockExam } from "@/lib/mock-exams/types";
import { mockExamAttempts, mockExams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import {
  applyAccountPart,
  applyBundlePart,
  applySeed,
  bundlePartsOf,
  combineAnswers,
  loadSeed,
  planSeed,
  readSeedPart,
  seedPartsOf,
  serialisePart,
  UPLOAD_MAX_BYTES,
  type ExamBundlePart,
  type SeedAnswer,
} from "@/server/study/seed-account";
import { run } from "../../../scripts/study/seed-account";
import { checkMockExamFiles, lecturePagesOf, loadMockExams, readMockExamIndex } from "./import";
import { finishAttempt, getAttempt, listMockExams, saveAnswer, setTicks, startAttempt } from "./index";

// Invented data only: the sample account and bundle of tests/fixtures/study, and the baking exam.
const ACCOUNT = path.join(process.cwd(), "tests/fixtures/study/sample-account");
const BUNDLE = path.join(process.cwd(), "tests/fixtures/study/sample-bundle");
const NOW = new Date("2026-11-15T10:00:00Z");
const T = 90_000;
const CODE = "TST-E0001";

const write = (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2));

let tmp: string;
let bundles: string;
let mockDir: string;

/** The folder as her bundle has it: an index, three exams, and two files that are not exams. */
async function writeExams(exams: MockExam[] = [sampleExam(), sampleExam({ id: "bake-boss", kind: "boss", order: 9, title: "Boss bake" }), sampleExam({ id: "bake-0", kind: "teacher", order: 1, title: "Teacher's bake" })]) {
  await rm(mockDir, { recursive: true, force: true });
  await mkdir(mockDir, { recursive: true });
  await write(path.join(mockDir, "index.json"), { course: "Baking for Beginners", exams: exams.map((e) => ({ id: e.id, order: e.order, kind: e.kind, title: e.title, file: `${e.id}.json` })) });
  for (const e of exams) await write(path.join(mockDir, `${e.id}.json`), e);
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "mock-exams-"));
  bundles = path.join(tmp, "bundles");
  await cp(BUNDLE, path.join(bundles, CODE), { recursive: true });
  mockDir = path.join(bundles, CODE, "mock-exams");
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  await writeExams();
}, T);
afterEach(async () => {
  await t.close();
});

const seed = async (dryRun = false) => applySeed(t.db, planSeed(await loadSeed(ACCOUNT, bundles)), { dryRun, name: "Testi", now: NOW });
const mockCount = (r: { imports: { courseCode: string; counts: object }[] }) => (r.imports.find((i) => i.courseCode === CODE)!.counts as { mockExams?: unknown }).mockExams;

describe("reading the mock-exams folder", () => {
  it(
    "with no index.json: reads every exam of the folder in paper order and reports a file that is not an exam without stopping",
    async () => {
      await unlink(path.join(mockDir, "index.json"));
      const { answer: _dropped, ...noKey } = (sampleExam({ id: "bake-broken" }).questions[0] as { items: Record<string, unknown>[] }).items[0];
      void _dropped;
      const broken = sampleExam({ id: "bake-broken" });
      (broken.questions[0] as unknown as { items: unknown[] }).items[0] = noKey;
      await write(path.join(mockDir, "bake-broken.json"), broken);
      await writeFile(path.join(mockDir, "not-json.json"), "{ this is not json");
      await write(path.join(mockDir, "zz-copy.json"), sampleExam({ title: "A copy with the same id" }));
      await writeFile(path.join(mockDir, "notes.txt"), "not an exam file");

      const { exams, problems } = await loadMockExams(path.join(bundles, CODE));
      expect(exams.map((e) => [e.exam.id, e.file])).toEqual([
        ["bake-0", "mock-exams/bake-0.json"],
        ["bake-1", "mock-exams/bake-1.json"],
        ["bake-boss", "mock-exams/bake-boss.json"],
      ]);
      expect(problems.map((p) => p.file)).toEqual(["mock-exams/not-json.json", "mock-exams/bake-broken.json", "mock-exams/zz-copy.json"]);
      expect(problems[1].reason).toContain("questions.0.items.0.answer");
      // A problem names the file and the path, never the exam's text.
      expect(JSON.stringify(problems)).not.toContain("KEY-");
      expect(JSON.stringify(problems)).not.toContain("Yeast");

      // The seed still goes in, with the three good ones, and says what it left out.
      const result = await seed();
      expect(mockCount(result)).toEqual({ created: 3, skipped: 0, updated: 0 });
      expect((await t.db.select().from(mockExams)).map((r) => [r.importId, r.position]).sort()).toEqual([["bake-0", 1], ["bake-1", 2], ["bake-boss", 9]]);
      const lines: string[] = [];
      expect(await run([ACCOUNT, bundles, "--dry-run"], t.db, { out: (l) => lines.push(l), err: (l) => lines.push(l) })).toBe(0);
      expect(lines.filter((l) => l.includes("problem: mock-exams/"))).toHaveLength(3);
    },
    T,
  );

  it(
    "with an index.json: imports the files it lists, in its order, and says which it left out",
    async () => {
      const drill = sampleDrill();
      const math = sampleDrill({ id: "bake-math-1", kind: "drill-math", order: 1, title: "Math problems 1" });
      for (const e of [drill, math, sampleExam({ id: "bake-stray", title: "Not in the index" })]) await write(path.join(mockDir, `${e.id}.json`), e);
      await write(path.join(mockDir, "bake-renamed.json"), sampleExam({ id: "bake-other-id" }));
      await writeFile(path.join(mockDir, "bake-torn.json"), "{ not json");
      const entry = (id: string, more: object = {}) => ({ id, file: `${id}.json`, ...more });
      await write(path.join(mockDir, "index.json"), {
        course: "Baking for Beginners",
        exams: [
          entry("bake-boss", { order: 3, kind: "boss", title: "Boss bake", totalPoints: 24 }),
          entry("bake-1", { order: 2 }),
          entry("bake-gone", { order: 4 }), // listed, not in the folder
          entry("bake-figures-1", { order: 20 }),
          entry("bake-math-1", { order: 10 }),
          entry("bake-renamed", { order: 30 }), // the file carries another id
          entry("bake-torn", { order: 31 }),
          entry("bake-1", { order: 40 }), // listed twice
          { id: "x", file: "../seed.json" }, // not a file of this folder
          { id: "y", file: "index.json" },
          7,
        ],
      });

      const { exams, problems } = await loadMockExams(path.join(bundles, CODE));
      // The index's order wins over the files' own `order`; the kinds and totals are the files'.
      expect(exams.map((e) => [e.exam.id, e.position, e.exam.kind, e.exam.totalPoints])).toEqual([
        ["bake-1", 2, "mock", 24],
        ["bake-boss", 3, "boss", 24],
        ["bake-math-1", 10, "drill-math", 18],
        ["bake-figures-1", 20, "drill-figure", 18],
      ]);
      expect(problems.map((p) => [p.file, p.reason.split(",")[0]])).toEqual([
        ["mock-exams/index.json", "entry 8 names a file an earlier entry already names"],
        ["mock-exams/index.json", "entry 9 names no .json file of this folder"],
        ["mock-exams/index.json", "entry 10 names no .json file of this folder"],
        ["mock-exams/index.json", "entry 11 names no .json file of this folder"],
        ["mock-exams/bake-gone.json", "is listed in index.json but is not in the folder"],
        ["mock-exams/bake-renamed.json", "carries another id than index.json gives it"],
        ["mock-exams/bake-torn.json", "cannot be read or is not valid JSON"],
        ["mock-exams/bake-0.json", "is not listed in index.json"],
        ["mock-exams/bake-stray.json", "is not listed in index.json"],
      ]);
      expect(JSON.stringify(problems)).not.toContain("KEY-");

      // The seed takes the four, at the index's places, and the tool says the rest.
      const result = await seed();
      expect(mockCount(result)).toEqual({ created: 4, skipped: 0, updated: 0 });
      expect((await t.db.select().from(mockExams)).map((r) => [r.importId, r.position]).sort()).toEqual([["bake-1", 2], ["bake-boss", 3], ["bake-figures-1", 20], ["bake-math-1", 10]]);
      expect((await listMockExams(result.userId, t.db)).map((e) => [e.id, e.order, e.totalPoints])).toEqual([
        ["bake-1", 2, 24],
        ["bake-boss", 3, 24],
        ["bake-math-1", 10, 18],
        ["bake-figures-1", 20, 18],
      ]);
      const lines: string[] = [];
      expect(await run([ACCOUNT, bundles, "--upload", "https://ready.example", "--username", "test.student", "--dry-run"], null, { out: (l) => lines.push(l), err: (l) => lines.push(l) })).toBe(0);
      expect(lines.join("\n")).toContain(`Mock exams of ${CODE} (4): bake-1, bake-boss, bake-math-1, bake-figures-1.`);
      expect(lines.filter((l) => l.includes("problem: mock-exams/"))).toHaveLength(9);
    },
    T,
  );

  it(
    "an index.json that is not a list is said so, and the folder is read as if there were none",
    async () => {
      await write(path.join(mockDir, "index.json"), { course: "Baking for Beginners" });
      const { exams, problems } = await loadMockExams(path.join(bundles, CODE));
      expect(exams.map((e) => [e.exam.id, e.position])).toEqual([["bake-0", undefined], ["bake-1", undefined], ["bake-boss", undefined]]);
      expect(problems).toEqual([{ file: "mock-exams/index.json", reason: "is not a list of files; every .json file of the folder was read instead." }]);
      await writeFile(path.join(mockDir, "index.json"), "{ torn");
      expect((await loadMockExams(path.join(bundles, CODE))).exams).toHaveLength(3);
    },
    T,
  );

  it("reads an index as a list under `exams` or a bare list, of entries or file names", () => {
    expect(readMockExamIndex({ exams: [{ id: "a", file: "a.json", order: 2 }, "b.json"] })).toEqual({
      entries: [{ name: "a.json", id: "a", order: 2 }, { name: "b.json", id: null, order: null }],
      problems: [],
    });
    expect(readMockExamIndex(["a.json"])?.entries).toHaveLength(1);
    expect(readMockExamIndex({ exams: [] })).toEqual({ entries: [], problems: [] });
    for (const not of [null, "a.json", 3, {}, { exams: "all" }]) expect(readMockExamIndex(not)).toBeNull();
    for (const bad of ["a/b.json", "..json", ".hidden.json", "a.txt", "index.json", "", "a\\b.json"]) expect(readMockExamIndex([bad])?.entries).toEqual([]);
  });

  it("finds nothing, and no problem, in a course folder without mock exams", async () => {
    expect(await loadMockExams(BUNDLE)).toEqual({ exams: [], problems: [] });
    expect(checkMockExamFiles([])).toEqual({ exams: [], problems: [] });
  });

  it("names a lecture page by its file name", () => {
    expect(lecturePagesOf([{ n: 1, page: "pages/oven-basics.json" }, { n: 2, page: "dough.json" }, { n: 3 }, { n: 4, page: null }, { n: 5, page: "pages/dough.json" }])).toEqual({ "oven-basics": 1, dough: 2 });
  });
});

describe("the seed", () => {
  it(
    "a dry run lists the mock exams it would import and writes none",
    async () => {
      const lines: string[] = [];
      const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
      expect(await run([ACCOUNT, bundles, "--dry-run"], t.db, io)).toBe(0);
      const text = lines.join("\n");
      expect(text).toMatch(/Mock exams\s+3 created, 0 already there/);
      expect(text).toContain("Mock exams (3): bake-0, bake-1, bake-boss.");
      expect(text).not.toContain("KEY-");
      expect(await t.db.select().from(mockExams)).toHaveLength(0);

      // And the upload's dry run: sends nothing, asks nothing.
      lines.length = 0;
      let asked = 0;
      let sent = 0;
      const upload = {
        ...io,
        askHidden: async () => {
          asked += 1;
          return "";
        },
        fetch: (async () => {
          sent += 1;
          return new Response(null);
        }) as typeof fetch,
      };
      expect(await run([ACCOUNT, bundles, "--upload", "https://ready.example", "--username", "test.student", "--dry-run"], null, upload)).toBe(0);
      expect([asked, sent]).toEqual([0, 0]);
      expect(lines.join("\n")).toContain("3 mock exams");
      expect(lines.join("\n")).toContain(`Mock exams of ${CODE} (3): bake-0, bake-1, bake-boss.`);
      expect(lines.join("\n")).not.toContain("KEY-");
    },
    T,
  );

  it(
    "imports them onto the course, with the lecture pages their links name, and a second run changes nothing",
    async () => {
      const first = await seed();
      expect(mockCount(first)).toEqual({ created: 3, skipped: 0, updated: 0 });
      const rows = await t.db.select().from(mockExams);
      expect(rows.map((r) => [r.importId, r.position]).sort()).toEqual([["bake-0", 1], ["bake-1", 2], ["bake-boss", 9]]);
      expect(new Set(rows.map((r) => r.courseId))).toEqual(new Set([first.imports.find((i) => i.courseCode === CODE)!.courseId]));
      expect(rows.find((r) => r.importId === "bake-1")!.content).toEqual(sampleExam());
      expect(rows[0].lecturePages).toEqual({ "page-1": 1 });
      expect((await listMockExams(first.userId, t.db)).map((e) => e.id)).toEqual(["bake-0", "bake-1", "bake-boss"]);

      const second = await seed();
      expect(mockCount(second)).toEqual({ created: 0, skipped: 3, updated: 0 });
    },
    T,
  );

  it(
    "a new upload of changed content updates the exam in place and keeps every attempt as it was",
    async () => {
      const { userId } = await seed();
      // One finished and marked attempt, one open one with an answer.
      const started = await startAttempt(userId, "bake-1", t.db);
      await saveAnswer(userId, started.attempt.id, { kind: "trueFalse", item: 0, answer: true }, 30, t.db);
      await saveAnswer(userId, started.attempt.id, { kind: "text", part: "2.0.0", text: "Seventy percent." }, 60, t.db);
      const done = await finishAttempt(userId, started.attempt.id, 90, t.db);
      await setTicks(userId, done.attempt.id, "2.0.0", [{ index: 0, fromCheck: false }, { index: 1, fromCheck: true }], false, t.db);
      const open = await startAttempt(userId, "bake-1", t.db);
      await saveAnswer(userId, open.attempt.id, { kind: "text", part: "3.0.0", text: "So it relaxes." }, 15, t.db);
      const attemptsBefore = JSON.stringify(await t.db.select().from(mockExamAttempts).orderBy(mockExamAttempts.createdAt, mockExamAttempts.id));
      const [rowBefore] = await t.db.select().from(mockExams).where(eq(mockExams.importId, "bake-1"));

      // The same exams again, one reworded, one part's ticks worth less, and one exam gone from the folder.
      const changed = sampleExam({ title: "Mock bake 1, second edition" });
      const q2 = changed.questions[1];
      if (q2.type !== "written") throw new Error("question 2 is written");
      q2.sections[0].parts[0].ticks = [{ text: "KEY-TICK one tick now", points: 2 }];
      await writeExams([changed, sampleExam({ id: "bake-0", kind: "teacher", order: 1, title: "Teacher's bake" })]);
      const again = await seed();
      expect(mockCount(again)).toEqual({ created: 0, skipped: 1, updated: 1 });

      // Same row, new content; the exam that left the folder is still hers.
      const [rowAfter] = await t.db.select().from(mockExams).where(eq(mockExams.importId, "bake-1"));
      expect(rowAfter.id).toBe(rowBefore.id);
      expect((rowAfter.content as MockExam).title).toBe("Mock bake 1, second edition");
      expect((await listMockExams(userId, t.db)).map((e) => [e.id, e.title, e.attempts, e.status])).toEqual([
        ["bake-0", "Teacher's bake", 0, "new"],
        ["bake-1", "Mock bake 1, second edition", 1, "open"],
        ["bake-boss", "Boss bake", 0, "new"],
      ]);
      // Every attempt byte for byte: answers, ticks, times and the stored score (1 + 1.5 = 2.5).
      expect(JSON.stringify(await t.db.select().from(mockExamAttempts).orderBy(mockExamAttempts.createdAt, mockExamAttempts.id))).toBe(attemptsBefore);
      const kept = (await getAttempt(userId, done.attempt.id, t.db))!;
      expect(kept.attempt.score!.total).toBe(2.5);
      expect(kept.exam.title).toBe("Mock bake 1, second edition");
      // Only a new marking scores against the new content: tick 1 is gone there, tick 0 is worth 2.
      const remarked = await setTicks(userId, done.attempt.id, "2.0.0", [{ index: 0, fromCheck: false }, { index: 1, fromCheck: true }], true, t.db);
      expect(remarked.ticks["2.0.0"]).toEqual([{ index: 0, fromCheck: false }]);
      expect(remarked.score!.total).toBe(3);
    },
    T,
  );
});

describe("the upload", () => {
  const newUser = async () => (await t.db.insert(users).values({}).returning({ id: users.id }))[0].id;

  it(
    "sends each mock exam once, in as many requests as it takes, each inside the size a request may be",
    async () => {
      const input = await loadSeed(ACCOUNT, bundles);
      const exam = input.bundles.find((b) => b.kind === "exam")!;
      const whole = bundlePartsOf(exam) as ExamBundlePart[];
      expect(whole).toHaveLength(1);
      expect(whole[0].mockExams.map((m) => m.file)).toEqual(["mock-exams/bake-0.json", "mock-exams/bake-1.json", "mock-exams/bake-boss.json"]);

      expect(whole[0].mockExams.map((m) => m.position)).toEqual([1, 2, 9]);

      // Requests too small for the three together: they go one after the other, each once and whole, in order.
      const one = Math.max(...whole[0].mockExams.map((m) => Buffer.byteLength(JSON.stringify(m))));
      const size = Buffer.byteLength(serialisePart({ ...whole[0], pages: [], decks: [], mockExams: [] })) + one + 2_000;
      const batches = bundlePartsOf(exam, size) as ExamBundlePart[];
      expect(batches.filter((b) => b.mockExams.length).length).toBeGreaterThanOrEqual(2);
      expect(batches.flatMap((b) => b.mockExams.map((m) => m.file))).toEqual(whole[0].mockExams.map((m) => m.file));
      expect(batches.map((b) => b.batch)).toEqual(batches.map((_, i) => ({ n: i + 1, of: batches.length })));
      for (const b of batches) expect(Buffer.byteLength(serialisePart(b))).toBeLessThanOrEqual(size);
      // Sent that way, the server ends with the same three rows.
      const userId = (await t.db.insert(users).values({}).returning({ id: users.id }))[0].id;
      const answers: SeedAnswer[] = [];
      for (const sent of seedPartsOf(input, size)) {
        const part = readSeedPart(JSON.parse(serialisePart(sent)));
        answers.push(part.part === "account" ? await applyAccountPart(t.db, userId, part, { now: NOW }) : await applyBundlePart(t.db, userId, part, { now: NOW }));
      }
      expect(mockCount(combineAnswers(planSeed(input), answers))).toEqual({ created: 3, skipped: 0, updated: 0 });
      expect((await t.db.select().from(mockExams)).map((r) => [r.importId, r.position]).sort()).toEqual([["bake-0", 1], ["bake-1", 2], ["bake-boss", 9]]);
      for (const p of seedPartsOf(input)) expect(Buffer.byteLength(serialisePart(p))).toBeLessThan(UPLOAD_MAX_BYTES);
      // Too small for one exam alone: said so, by file, never by content.
      const bare = Buffer.byteLength(serialisePart({ ...whole[0], pages: [], decks: [], documents: [], mockExams: [] }));
      expect(() => bundlePartsOf(exam, bare + one - 200)).toThrow(/mock-exams\/bake-[a-z0-9-]+\.json does not fit in one request/);
    },
    T,
  );

  it(
    "writes what a direct run writes, into the signed-in account, and a second upload changes nothing",
    async () => {
      const input = await loadSeed(ACCOUNT, bundles);
      const userId = await newUser();
      const send = async (maxBytes?: number) => {
        const answers: SeedAnswer[] = [];
        for (const sent of seedPartsOf(input, maxBytes)) {
          const part = readSeedPart(JSON.parse(serialisePart(sent)));
          answers.push(part.part === "account" ? await applyAccountPart(t.db, userId, part, { now: NOW }) : await applyBundlePart(t.db, userId, part, { now: NOW }));
        }
        return combineAnswers(planSeed(input), answers);
      };
      const first = await send(40_000);
      expect(mockCount(first)).toEqual({ created: 3, skipped: 0, updated: 0 });
      const rows = await t.db.select().from(mockExams);
      expect(rows.every((r) => r.userId === userId)).toBe(true);
      expect(rows.find((r) => r.importId === "bake-1")!.content).toEqual(sampleExam());
      expect(rows[0].lecturePages).toEqual({ "page-1": 1 });

      const second = await send();
      expect(mockCount(second)).toEqual({ created: 0, skipped: 3, updated: 0 });
      expect(await t.db.select().from(mockExams)).toHaveLength(3);
    },
    T,
  );

  it(
    "checks each exam again on the server: one that is not an exam is left out and reported, the rest goes in",
    async () => {
      const input = await loadSeed(ACCOUNT, bundles);
      const userId = await newUser();
      const [account, bundle] = seedPartsOf(input) as [Parameters<typeof applyAccountPart>[2], ExamBundlePart];
      await applyAccountPart(t.db, userId, readSeedPart(JSON.parse(serialisePart(account))) as typeof account, { now: NOW });
      const tampered = JSON.parse(serialisePart(bundle)) as { mockExams: { file: string; exam: Record<string, unknown> }[] };
      tampered.mockExams[1].exam.kind = "KEY-SECRET";
      tampered.mockExams.push({ file: "mock-exams/extra.json", exam: { id: "x" } });
      const answer = await applyBundlePart(t.db, userId, readSeedPart(tampered) as ExamBundlePart, { now: NOW });
      if (answer.part !== "bundle" || !answer.imported || answer.kind !== "exam") throw new Error("imported");
      expect(answer.counts.mockExams).toEqual({ created: 2, skipped: 0, updated: 0 });
      expect(answer.problems.map((p) => p.file)).toEqual(["mock-exams/bake-1.json", "mock-exams/extra.json"]);
      expect(JSON.stringify(answer)).not.toContain("KEY-");
      expect((await t.db.select().from(mockExams)).map((r) => r.importId).sort()).toEqual(["bake-0", "bake-boss"]);
      // A body where mockExams is not a list of files is refused whole.
      expect(() => readSeedPart({ ...tampered, mockExams: "all of them" })).toThrow();
    },
    T,
  );
});
