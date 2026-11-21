// @vitest-environment node
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sampleExam } from "@/lib/mock-exams/sample-exam";
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
import { checkMockExamFiles, lecturePagesOf, loadMockExams } from "./import";
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
    "reads every exam in paper order, leaves the index alone, and reports a file that is not an exam without stopping",
    async () => {
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
      const lines: string[] = [];
      expect(await run([ACCOUNT, bundles, "--dry-run"], t.db, { out: (l) => lines.push(l), err: (l) => lines.push(l) })).toBe(0);
      expect(lines.filter((l) => l.includes("problem: mock-exams/"))).toHaveLength(3);
    },
    T,
  );

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
    "sends the mock exams once, in the first batch, inside the size a request may be",
    async () => {
      const input = await loadSeed(ACCOUNT, bundles);
      const exam = input.bundles.find((b) => b.kind === "exam")!;
      const whole = bundlePartsOf(exam) as ExamBundlePart[];
      expect(whole).toHaveLength(1);
      expect(whole[0].mockExams.map((m) => m.file)).toEqual(["mock-exams/bake-0.json", "mock-exams/bake-1.json", "mock-exams/bake-boss.json"]);

      // Small requests: the exams stay together in batch 1 and every batch is within the size.
      const size = Buffer.byteLength(serialisePart(whole[0])) - 800;
      const batches = bundlePartsOf(exam, size) as ExamBundlePart[];
      expect(batches.length).toBeGreaterThan(1);
      expect(batches.map((b) => b.mockExams.length)).toEqual([3, ...batches.slice(1).map(() => 0)]);
      for (const b of batches) expect(Buffer.byteLength(serialisePart(b))).toBeLessThanOrEqual(size);
      for (const p of seedPartsOf(input)) expect(Buffer.byteLength(serialisePart(p))).toBeLessThan(UPLOAD_MAX_BYTES);
      // Too small for the exams at all: said so, by folder, never by content.
      expect(() => bundlePartsOf(exam, 8_000)).toThrow(/does not fit in one request/);
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
