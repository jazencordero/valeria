// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SAMPLE_ALL_RIGHT, sampleDrill, sampleExam } from "@/lib/mock-exams/sample-exam";
import { checkMockExam } from "@/lib/mock-exams/validate";
import type { AttemptView, MockExam } from "@/lib/mock-exams/types";
import { courses } from "@/server/db/schema/courses";
import { lectures } from "@/server/db/schema/learn";
import { mockExamAttempts, mockExams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { applyMockExams } from "./import";
import {
  finishAttempt,
  fittedOrder,
  getAttempt,
  getMockExam,
  getOpenAttempt,
  listAttempts,
  listMockExams,
  MockExamNotFound,
  percentOf,
  saveAnswer,
  setTicks,
  shuffledOrder,
  startAttempt,
  suggestTicks,
  TEXT_ANSWER_MAX,
} from "./index";

// Invented data only: the baking exam of src/lib/mock-exams/sample-exam.ts.
const T = 90_000;
const NO_SUCH = "00000000-0000-4000-8000-000000000000";
const PAGES = { "oven-basics": 1, dough: 2 };

let t: TestDb;
let her: string;
let other: string;
let herCourse: string;
let theirCourse: string;

const file = (exam: MockExam) => ({ file: `mock-exams/${exam.id}.json`, exam });

beforeEach(async () => {
  t = await createTestDb();
  [her, other] = (await t.db.insert(users).values([{}, {}]).returning()).map((u) => u.id);
  [herCourse, theirCourse] = (
    await t.db
      .insert(courses)
      .values([
        { userId: her, moodleId: 1, code: "BAKE-1", name: "Baking", aiStudy: "allowed" },
        { userId: other, moodleId: 1, code: "BAKE-1", name: "Baking" },
      ])
      .returning()
  ).map((c) => c.id);
  await applyMockExams(
    t.db,
    her,
    herCourse,
    [
      file(sampleExam()),
      file(sampleExam({ id: "bake-boss", kind: "boss", order: 1, title: "Boss bake", expectedScore: { low: 14, high: 18 } })),
      file(sampleExam({ id: "bake-0", kind: "teacher", order: 1, title: "Teacher's bake" })),
    ],
    PAGES,
  );
  await applyMockExams(t.db, other, theirCourse, [file(sampleExam({ title: "Their bake" }))], PAGES);
}, T);
afterEach(async () => {
  await t.close();
});

const rowOf = async (attemptId: string) => (await t.db.select().from(mockExamAttempts).where(eq(mockExamAttempts.id, attemptId)))[0];

/** Sits the sample once: every true/false item answered as given, then finished. */
async function sit(userId: string, examId: string, answers: Record<string, boolean | null> = SAMPLE_ALL_RIGHT): Promise<AttemptView> {
  const started = await startAttempt(userId, examId, t.db);
  for (const [item, answer] of Object.entries(answers)) {
    expect(await saveAnswer(userId, started.attempt.id, { kind: "trueFalse", item: Number(item), answer }, undefined, t.db)).toBe(true);
  }
  return finishAttempt(userId, started.attempt.id, 600, t.db);
}

describe("the list and the start screen", () => {
  it(
    "lists her exams in paper order with the boss last, all new",
    async () => {
      const list = await listMockExams(her, t.db);
      expect(list.map((e) => [e.id, e.kind, e.status, e.best, e.latest, e.attempts, e.openAttemptId])).toEqual([
        ["bake-0", "teacher", "new", null, null, 0, null],
        ["bake-1", "mock", "new", null, null, 0, null],
        ["bake-boss", "boss", "new", null, null, 0, null],
      ]);
      expect(list[2].expectedScore).toEqual({ low: 14, high: 18 });
      expect(list[1]).toMatchObject({ title: "Mock bake 1", subtitle: "Bread and cakes", totalPoints: 24, suggestedMinutes: 90 });
      expect(await listMockExams(NO_SUCH, t.db)).toEqual([]);
    },
    T,
  );

  it(
    "shows status, best, latest and the number of finished attempts",
    async () => {
      await sit(her, "bake-1", { "0": true, "1": false, "2": true }); // 3
      await sit(her, "bake-1"); // 6
      const third = await sit(her, "bake-1", { "0": true, "1": false, "2": true, "3": true, "4": true }); // 4 right, 1 wrong: 3
      await setTicks(her, third.attempt.id, "2.0.1", [{ index: 0, fromCheck: false }], false, t.db); // 3.5
      let [, mock] = await listMockExams(her, t.db);
      expect([mock.status, mock.best, mock.latest, mock.attempts, mock.openAttemptId]).toEqual(["done", 6, 3.5, 3, null]);

      // An unfinished one on top: open, and the finished ones still count.
      const open = await startAttempt(her, "bake-1", t.db);
      [, mock] = await listMockExams(her, t.db);
      expect([mock.status, mock.best, mock.latest, mock.attempts, mock.openAttemptId]).toEqual(["open", 6, 3.5, 3, open.attempt.id]);
      expect((await getMockExam(her, "bake-1", t.db))!.listing).toEqual(mock);
      // The other exams are untouched.
      expect((await listMockExams(her, t.db)).map((e) => e.status)).toEqual(["new", "open", "new"]);
    },
    T,
  );

  it(
    "gives the start screen the paper only, and says whether Check my answer may be offered",
    async () => {
      const start = (await getMockExam(her, "bake-1", t.db))!;
      expect(JSON.stringify(start)).not.toContain("KEY-");
      expect(start.exam.questions).toHaveLength(4);
      // Her tutor is off: the checker would say unavailable, so the button is not offered.
      expect(start.checkAllowed).toBe(false);
      await t.db.update(users).set({ settings: { tutor: { enabled: true } } }).where(eq(users.id, her));
      expect((await getMockExam(her, "bake-1", t.db))!.checkAllowed).toBe(true);
      // Her files switch off: not offered either.
      await t.db.update(users).set({ settings: { tutor: { enabled: true }, ai: { useFiles: false } } }).where(eq(users.id, her));
      expect((await getMockExam(her, "bake-1", t.db))!.checkAllowed).toBe(false);
      await t.db.update(users).set({ settings: { tutor: { enabled: true } } }).where(eq(users.id, her));
      // The other user's course has no AI study rule yet: not allowed.
      expect((await getMockExam(other, "bake-1", t.db))!.checkAllowed).toBe(false);
      await t.db.update(courses).set({ aiStudy: "not_allowed" }).where(eq(courses.id, herCourse));
      expect((await getMockExam(her, "bake-1", t.db))!.checkAllowed).toBe(false);
      expect(await getMockExam(her, "no-such-exam", t.db)).toBeNull();
    },
    T,
  );
});

describe("sitting an exam", () => {
  it(
    "starts an attempt with the paper and a shuffled true/false order, and resumes it",
    async () => {
      const started = await startAttempt(her, "bake-1", t.db);
      expect(started.finished).toBe(false);
      expect([...started.attempt.tfOrder].sort()).toEqual([0, 1, 2, 3, 4, 5]);
      expect(started.attempt).toMatchObject({ examId: "bake-1", finishedAt: null, secondsUsed: 0, trueFalse: {}, texts: {}, ticks: {}, edited: false, score: null });

      expect(await saveAnswer(her, started.attempt.id, { kind: "text", part: "2.0.0", text: "Seventy percent." }, 42, t.db)).toBe(true);
      expect(await saveAnswer(her, started.attempt.id, { kind: "trueFalse", item: 3, answer: null }, 50, t.db)).toBe(true);

      // Starting again, or asking for the open one, gives the same attempt with what was saved.
      const again = await startAttempt(her, "bake-1", t.db);
      const open = await getOpenAttempt(her, "bake-1", t.db);
      const byId = await getAttempt(her, started.attempt.id, t.db);
      for (const view of [again, open!, byId!]) {
        expect(view.attempt.id).toBe(started.attempt.id);
        expect(view.attempt.tfOrder).toEqual(started.attempt.tfOrder);
        expect(view.attempt.texts).toEqual({ "2.0.0": "Seventy percent." });
        expect(view.attempt.trueFalse).toEqual({ "3": null });
        expect(view.attempt.secondsUsed).toBe(50);
      }
      expect(await t.db.select().from(mockExamAttempts)).toHaveLength(1);
      expect(await getOpenAttempt(her, "bake-0", t.db)).toBeNull();
    },
    T,
  );

  it(
    "never sends a key with an open attempt",
    async () => {
      const started = await startAttempt(her, "bake-1", t.db);
      await saveAnswer(her, started.attempt.id, { kind: "text", part: "3.0.1", text: "So it tears where I cut." }, 10, t.db);
      const payloads = [
        started,
        await startAttempt(her, "bake-1", t.db),
        await getOpenAttempt(her, "bake-1", t.db),
        await getAttempt(her, started.attempt.id, t.db),
        await getMockExam(her, "bake-1", t.db),
        await listMockExams(her, t.db),
        await listAttempts(her, undefined, t.db),
      ];
      for (const payload of payloads) {
        const text = JSON.stringify(payload);
        expect(text).not.toContain("KEY-");
        for (const name of ["answer", "why", "note", "lectures", "modelAnswer", "commonWrong", "href"]) expect(text).not.toContain(`"${name}":`);
      }
      // And the whole exam is there once it is finished.
      const done = await finishAttempt(her, started.attempt.id, undefined, t.db);
      expect(done.finished).toBe(true);
      expect(JSON.stringify(done.exam)).toContain("KEY-MODEL");
    },
    T,
  );

  it(
    "keeps both texts when two saves for different parts race",
    async () => {
      const { attempt } = await startAttempt(her, "bake-1", t.db);
      const parts = ["2.0.0", "2.0.1", "2.1.0", "3.0.0", "3.0.1", "4.0.0"];
      const saves = [
        ...parts.map((part, i) => saveAnswer(her, attempt.id, { kind: "text", part, text: `Answer to ${part}` }, i, t.db)),
        ...[0, 1, 2, 3, 4, 5].map((item) => saveAnswer(her, attempt.id, { kind: "trueFalse", item, answer: item % 2 === 0 }, undefined, t.db)),
      ];
      expect(await Promise.all(saves)).toEqual(Array(12).fill(true));
      const row = await rowOf(attempt.id);
      expect(row.texts).toEqual(Object.fromEntries(parts.map((p) => [p, `Answer to ${p}`])));
      expect(row.trueFalse).toEqual({ "0": true, "1": false, "2": true, "3": false, "4": true, "5": false });

      // A later save of one part replaces that part only.
      await saveAnswer(her, attempt.id, { kind: "text", part: "2.0.1", text: "" }, undefined, t.db);
      expect((await rowOf(attempt.id)).texts).toEqual({ ...Object.fromEntries(parts.map((p) => [p, `Answer to ${p}`])), "2.0.1": "" });
    },
    T,
  );

  it(
    "saves only answers that fit the exam, and cuts a text that is too long",
    async () => {
      const { attempt } = await startAttempt(her, "bake-1", t.db);
      const save = (answer: unknown, seconds?: number) => saveAnswer(her, attempt.id, answer as never, seconds, t.db);
      expect(await save({ kind: "trueFalse", item: 6, answer: true })).toBe(false);
      expect(await save({ kind: "trueFalse", item: -1, answer: true })).toBe(false);
      expect(await save({ kind: "trueFalse", item: 1.5, answer: true })).toBe(false);
      expect(await save({ kind: "trueFalse", item: 0, answer: "yes" })).toBe(false);
      expect(await save({ kind: "text", part: "2.0.2", text: "x" })).toBe(false);
      expect(await save({ kind: "text", part: "1.0.0", text: "x" })).toBe(false);
      expect(await save({ kind: "text", part: "__proto__", text: "x" })).toBe(false);
      expect(await save({ kind: "text", part: "2.0.0", text: 5 })).toBe(false);
      expect(await save({ kind: "other" })).toBe(false);
      expect(await save(null)).toBe(false);
      expect(await rowOf(attempt.id)).toMatchObject({ texts: {}, trueFalse: {}, secondsUsed: 0 });

      expect(await save({ kind: "text", part: "4.0.0", text: "x".repeat(TEXT_ANSWER_MAX + 500) }, 12.9)).toBe(true);
      const row = await rowOf(attempt.id);
      expect(row.texts["4.0.0"]).toHaveLength(TEXT_ANSWER_MAX);
      expect(row.secondsUsed).toBe(12);
      // A timer that makes no sense is not taken; the answer still is.
      expect(await save({ kind: "trueFalse", item: 0, answer: true }, Number.NaN)).toBe(true);
      expect(await save({ kind: "trueFalse", item: 1, answer: true }, -5)).toBe(true);
      expect((await rowOf(attempt.id)).secondsUsed).toBe(0);
    },
    T,
  );

  it(
    "finishes once: scores question 1, keeps the time, and a second finish changes nothing",
    async () => {
      const { attempt } = await startAttempt(her, "bake-1", t.db);
      await saveAnswer(her, attempt.id, { kind: "trueFalse", item: 0, answer: true }, undefined, t.db);
      await saveAnswer(her, attempt.id, { kind: "trueFalse", item: 1, answer: true }, undefined, t.db); // wrong
      await saveAnswer(her, attempt.id, { kind: "trueFalse", item: 2, answer: true }, undefined, t.db);
      await saveAnswer(her, attempt.id, { kind: "trueFalse", item: 3, answer: true }, undefined, t.db);
      await saveAnswer(her, attempt.id, { kind: "text", part: "2.0.0", text: "Seventy." }, 300, t.db);

      const done = await finishAttempt(her, attempt.id, 321, t.db);
      expect(done.finished).toBe(true);
      expect(done.attempt.finishedAt).not.toBeNull();
      expect(done.attempt.secondsUsed).toBe(321);
      expect(done.attempt.edited).toBe(false);
      expect(done.attempt.score!.total).toBe(2);
      expect(done.attempt.score!.max).toBe(24);
      expect(done.attempt.score!.questions[0]).toEqual({ number: 1, score: 2, max: 6, trueFalse: { right: 3, wrong: 1, blank: 2 } });
      expect(done.attempt.score!.questions.slice(1).map((q) => q.score)).toEqual([0, 0, 0]);

      const before = JSON.stringify(await rowOf(attempt.id));
      const again = await finishAttempt(her, attempt.id, 999, t.db);
      expect(again.attempt).toEqual(done.attempt);
      expect(JSON.stringify(await rowOf(attempt.id))).toBe(before);

      // Nothing is saved on a finished attempt.
      expect(await saveAnswer(her, attempt.id, { kind: "text", part: "2.0.0", text: "Later." }, 1000, t.db)).toBe(false);
      expect(await saveAnswer(her, attempt.id, { kind: "trueFalse", item: 1, answer: false }, undefined, t.db)).toBe(false);
      expect(JSON.stringify(await rowOf(attempt.id))).toBe(before);
      expect(await getOpenAttempt(her, "bake-1", t.db)).toBeNull();
    },
    T,
  );

  it(
    "a retake is a new attempt with another true/false order, and the old one stays byte for byte",
    async () => {
      const first = await sit(her, "bake-1", { "0": true, "1": true });
      await setTicks(her, first.attempt.id, "2.0.0", [{ index: 0, fromCheck: true }], false, t.db);
      const before = JSON.stringify(await rowOf(first.attempt.id));

      let previous = first.attempt;
      for (let i = 0; i < 6; i++) {
        const next = await startAttempt(her, "bake-1", t.db);
        expect(next.attempt.id).not.toBe(previous.id);
        expect(next.finished).toBe(false);
        expect([...next.attempt.tfOrder].sort()).toEqual([0, 1, 2, 3, 4, 5]);
        expect(next.attempt.tfOrder).not.toEqual(previous.tfOrder);
        expect(next.attempt).toMatchObject({ trueFalse: {}, texts: {}, ticks: {}, score: null, edited: false });
        await saveAnswer(her, next.attempt.id, { kind: "text", part: "2.0.0", text: `Try ${i}` }, undefined, t.db);
        previous = (await finishAttempt(her, next.attempt.id, undefined, t.db)).attempt;
      }
      expect(JSON.stringify(await rowOf(first.attempt.id))).toBe(before);
      expect(await t.db.select().from(mockExamAttempts).where(eq(mockExamAttempts.userId, her))).toHaveLength(7);
    },
    T,
  );

  it(
    "two starts at once give one open attempt",
    async () => {
      const views = await Promise.all([startAttempt(her, "bake-1", t.db), startAttempt(her, "bake-1", t.db), startAttempt(her, "bake-1", t.db)]);
      expect(new Set(views.map((v) => v.attempt.id)).size).toBe(1);
      expect(await t.db.select().from(mockExamAttempts)).toHaveLength(1);
    },
    T,
  );

  it("shuffles to another order than the last one", () => {
    expect(shuffledOrder(0)).toEqual([]);
    expect(shuffledOrder(1, [0])).toEqual([0]);
    for (let i = 0; i < 50; i++) expect(shuffledOrder(2, [0, 1])).toEqual([1, 0]);
    // A random source that always gives the same order still ends on another one.
    const stuck = shuffledOrder(4, undefined, () => 0.999);
    expect(shuffledOrder(4, stuck, () => 0.999)).not.toEqual(stuck);
    expect([...shuffledOrder(4, stuck, () => 0.999)].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe("marking", () => {
  it(
    "replaces a part's ticks, rescores, caps at the part's points and keeps where a tick came from",
    async () => {
      const done = await sit(her, "bake-1"); // question 1: 6
      const id = done.attempt.id;
      const before = await rowOf(id);

      let a = await setTicks(her, id, "2.0.0", [{ index: 0, fromCheck: true }, { index: 2, fromCheck: false }], undefined, t.db);
      expect(a.ticks).toEqual({ "2.0.0": [{ index: 0, fromCheck: true }, { index: 2, fromCheck: false }] });
      expect(a.score!.total).toBe(7.5);
      expect(a.score!.questions[1].parts![0]).toEqual({ key: "2.0.0", score: 1.5, max: 2 });
      expect(a.edited).toBe(false);

      // Three ticks of 1 on a part worth 2.5: capped. A tick given twice or not there is dropped.
      a = await setTicks(her, id, "2.1.0", [{ index: 0, fromCheck: false }, { index: 1, fromCheck: false }, { index: 2, fromCheck: false }, { index: 2, fromCheck: true }, { index: 7, fromCheck: false }], false, t.db);
      expect(a.ticks["2.1.0"]).toEqual([{ index: 0, fromCheck: false }, { index: 1, fromCheck: false }, { index: 2, fromCheck: false }]);
      expect(a.score!.questions[1].score).toBe(4);
      expect(a.score!.total).toBe(10);
      expect(a.edited).toBe(false);

      // Her own ticks replace the part's ticks (a suggested one she unticks is gone), marked edited.
      a = await setTicks(her, id, "2.0.0", [{ index: 1, fromCheck: false }], true, t.db);
      expect(a.ticks["2.0.0"]).toEqual([{ index: 1, fromCheck: false }]);
      expect(a.score!.total).toBe(9);
      expect(a.edited).toBe(true);
      // Edited stays, also after a change that is not an edit.
      a = await setTicks(her, id, "2.0.0", [], false, t.db);
      expect(a.edited).toBe(true);
      expect(a.score!.total).toBe(8.5);

      // Stored as returned, and nothing else of the attempt moved.
      const after = await rowOf(id);
      expect(after.score).toEqual(a.score);
      expect(after.total).toBe(8.5);
      expect([after.startedAt, after.finishedAt, after.secondsUsed, after.trueFalse, after.texts, after.tfOrder]).toEqual([
        before.startedAt,
        before.finishedAt,
        before.secondsUsed,
        before.trueFalse,
        before.texts,
        before.tfOrder,
      ]);
      expect((await getAttempt(her, id, t.db))!.attempt).toEqual(a);
    },
    T,
  );

  it(
    "ticks only a finished attempt of hers, and only a part the exam has",
    async () => {
      const open = await startAttempt(her, "bake-1", t.db);
      await expect(setTicks(her, open.attempt.id, "2.0.0", [{ index: 0, fromCheck: false }], false, t.db)).rejects.toBeInstanceOf(MockExamNotFound);
      expect((await rowOf(open.attempt.id)).ticks).toEqual({});
      const done = await finishAttempt(her, open.attempt.id, undefined, t.db);
      await expect(setTicks(her, done.attempt.id, "9.0.0", [], false, t.db)).rejects.toBeInstanceOf(MockExamNotFound);
      await expect(setTicks(her, done.attempt.id, "1.0.0", [], false, t.db)).rejects.toBeInstanceOf(MockExamNotFound);
      await expect(setTicks(her, NO_SUCH, "2.0.0", [], false, t.db)).rejects.toBeInstanceOf(MockExamNotFound);
      await expect(setTicks(her, "not-an-id", "2.0.0", [], false, t.db)).rejects.toBeInstanceOf(MockExamNotFound);
    },
    T,
  );

  it(
    "links each lecture she has in a finished view, and never stores the link",
    async () => {
      await t.db.insert(lectures).values({ userId: her, courseId: herCourse, n: 1, title: "Invented lecture on ovens" });
      const done = await sit(her, "bake-1");
      if (!done.finished) throw new Error("finished");
      const refs = done.exam.questions.flatMap((q) => (q.type === "truefalse" ? q.items.flatMap((i) => i.lectures) : q.sections.flatMap((s) => s.parts.flatMap((p) => p.lectures))));
      const hrefOf = (page: string) => [...new Set(refs.filter((r) => r.page === page).map((r) => r.href))];
      // Lecture 1 is hers: linked. Lecture 2 is named by the bundle but she has no such lecture; the essentials page is no lecture at all.
      expect(hrefOf("oven-basics")).toEqual([`/courses/${herCourse}/lectures/1`]);
      expect(hrefOf("dough")).toEqual([undefined]);
      expect(hrefOf("baking-essentials")).toEqual([undefined]);
      expect(refs.filter((r) => r.page === "dough").every((r) => !("href" in r))).toBe(true);

      // Once she has lecture 2 the same attempt links it too: worked out at read time.
      await t.db.insert(lectures).values({ userId: her, courseId: herCourse, n: 2, title: "Invented lecture on dough" });
      const again = (await getAttempt(her, done.attempt.id, t.db))!;
      expect(JSON.stringify(again.exam)).toContain(`"/courses/${herCourse}/lectures/2"`);
      // The other user's lectures do not count for her, and nothing was written into the content.
      const theirs = await sit(other, "bake-1");
      expect(JSON.stringify(theirs.exam)).not.toContain('"href"');
      for (const row of await t.db.select().from(mockExams)) expect(JSON.stringify(row.content)).not.toContain('"href"');
      // An open attempt has no links (it has no lecture refs at all).
      expect(JSON.stringify(await startAttempt(her, "bake-1", t.db))).not.toContain("/lectures/");
    },
    T,
  );

  it("leaves Check my answer to its own module: the stub says unavailable", async () => {
    expect(await suggestTicks(her, NO_SUCH, "2.0.0")).toEqual({ status: "unavailable" });
  });
});

describe("history", () => {
  it(
    "lists finished attempts oldest first, of one exam or of all",
    async () => {
      const a = await sit(her, "bake-1", { "0": true });
      const b = await sit(her, "bake-boss");
      const c = await sit(her, "bake-1", { "0": true, "1": false });
      await startAttempt(her, "bake-0", t.db); // open: not history
      await setTicks(her, a.attempt.id, "4.0.0", [{ index: 0, fromCheck: false }], true, t.db);

      const all = await listAttempts(her, undefined, t.db);
      expect(all.map((s) => [s.id, s.examId, s.examTitle, s.score.total, s.edited])).toEqual([
        [a.attempt.id, "bake-1", "Mock bake 1", 3, true],
        [b.attempt.id, "bake-boss", "Boss bake", 6, false],
        [c.attempt.id, "bake-1", "Mock bake 1", 2, false],
      ]);
      expect(all[0].secondsUsed).toBe(600);
      expect(all[0].finishedAt >= all[0].startedAt).toBe(true);
      expect((await listAttempts(her, "bake-1", t.db)).map((s) => s.id)).toEqual([a.attempt.id, c.attempt.id]);
      expect(await listAttempts(her, "bake-0", t.db)).toEqual([]);
      expect(await listAttempts(her, "no-such-exam", t.db)).toEqual([]);
    },
    T,
  );
});

describe("two users", () => {
  it(
    "never see or touch each other's exams and attempts",
    async () => {
      const mine = await startAttempt(her, "bake-1", t.db);
      await saveAnswer(her, mine.attempt.id, { kind: "text", part: "2.0.0", text: "Mine." }, 5, t.db);
      const theirs = await startAttempt(other, "bake-1", t.db);
      expect(theirs.attempt.id).not.toBe(mine.attempt.id);
      expect(theirs.exam.title).toBe("Their bake");
      expect(theirs.attempt.texts).toEqual({});

      // Her attempt's id in the other user's hands is as good as no id.
      expect(await getAttempt(other, mine.attempt.id, t.db)).toBeNull();
      expect(await saveAnswer(other, mine.attempt.id, { kind: "text", part: "2.0.0", text: "Theirs." }, 9, t.db)).toBe(false);
      await expect(finishAttempt(other, mine.attempt.id, 9, t.db)).rejects.toBeInstanceOf(MockExamNotFound);
      await expect(setTicks(other, mine.attempt.id, "2.0.0", [], true, t.db)).rejects.toBeInstanceOf(MockExamNotFound);
      expect(await rowOf(mine.attempt.id)).toMatchObject({ texts: { "2.0.0": "Mine." }, secondsUsed: 5, finishedAt: null });

      // An exam only she has does not exist for the other user.
      expect(await getMockExam(other, "bake-boss", t.db)).toBeNull();
      expect(await getOpenAttempt(other, "bake-boss", t.db)).toBeNull();
      await expect(startAttempt(other, "bake-boss", t.db)).rejects.toBeInstanceOf(MockExamNotFound);
      await expect(startAttempt(her, "no-such-exam", t.db)).rejects.toBeInstanceOf(MockExamNotFound);
      expect(await getAttempt(her, NO_SUCH, t.db)).toBeNull();
      expect(await getAttempt(her, "not-an-id", t.db)).toBeNull();

      const done = await finishAttempt(her, mine.attempt.id, 7, t.db);
      await finishAttempt(other, theirs.attempt.id, 8, t.db);
      expect(await getAttempt(other, done.attempt.id, t.db)).toBeNull();
      expect((await listAttempts(her, undefined, t.db)).map((s) => s.id)).toEqual([mine.attempt.id]);
      expect((await listAttempts(other, undefined, t.db)).map((s) => [s.id, s.examTitle])).toEqual([[theirs.attempt.id, "Their bake"]]);
      expect((await listMockExams(other, t.db)).map((e) => [e.id, e.title, e.attempts])).toEqual([["bake-1", "Their bake", 1]]);
      expect((await listMockExams(her, t.db)).map((e) => e.attempts)).toEqual([0, 1, 0]);
    },
    T,
  );
});

describe("a drill set: written problems only, 18 points", () => {
  beforeEach(async () => {
    await applyMockExams(
      t.db,
      her,
      herCourse,
      [file(sampleDrill()), file(sampleDrill({ id: "bake-math-1", kind: "drill-math", order: 11, title: "Math problems 1" }))],
      PAGES,
    );
  }, T);

  it(
    "is listed after the full exams, math sets before figure sets, with its own total",
    async () => {
      const list = await listMockExams(her, t.db);
      expect(list.map((e) => [e.id, e.kind, e.totalPoints, e.order])).toEqual([
        ["bake-0", "teacher", 24, 1],
        ["bake-1", "mock", 24, 2],
        ["bake-boss", "boss", 24, 1],
        ["bake-math-1", "drill-math", 18, 11],
        ["bake-figures-1", "drill-figure", 18, 12],
      ]);
    },
    T,
  );

  it(
    "is sat, finished, marked and retaken like an exam, with no true/false anywhere",
    async () => {
      const started = await startAttempt(her, "bake-figures-1", t.db);
      expect(started.finished).toBe(false);
      expect(started.attempt).toMatchObject({ examId: "bake-figures-1", kind: "drill-figure", totalPoints: 18, tfOrder: [], trueFalse: {}, score: null });
      expect(started.exam.questions.map((q) => q.type)).toEqual(["written", "written", "written"]);
      expect(JSON.stringify(started)).not.toContain("KEY-");
      const id = started.attempt.id;

      // There is no item to answer; a text for a part of question 1 is saved.
      expect(await saveAnswer(her, id, { kind: "trueFalse", item: 0, answer: true }, undefined, t.db)).toBe(false);
      expect(await saveAnswer(her, id, { kind: "text", part: "1.0.1", text: "About 27 minutes." }, 40, t.db)).toBe(true);
      expect(await saveAnswer(her, id, { kind: "text", part: "4.0.0", text: "No such question." }, 41, t.db)).toBe(false);
      expect((await getOpenAttempt(her, "bake-figures-1", t.db))!.attempt.texts).toEqual({ "1.0.1": "About 27 minutes." });

      const done = await finishAttempt(her, id, 55, t.db);
      expect(done.finished).toBe(true);
      expect(done.attempt.score).toMatchObject({ total: 0, max: 18 });
      expect(done.attempt.score!.questions.map((q) => [q.number, q.score, q.max, q.trueFalse, q.parts!.length])).toEqual([
        [1, 0, 6, undefined, 2],
        [2, 0, 6, undefined, 2],
        [3, 0, 6, undefined, 2],
      ]);

      const marked = await setTicks(her, id, "1.0.1", [{ index: 0, fromCheck: false }, { index: 1, fromCheck: true }], false, t.db);
      expect(marked.score!.total).toBe(3.5);
      expect((await setTicks(her, id, "3.0.0", [{ index: 0, fromCheck: false }], false, t.db)).score!.total).toBe(5);
      await expect(setTicks(her, id, "4.0.0", [], false, t.db)).rejects.toBeInstanceOf(MockExamNotFound);

      // A retake: a new attempt, again with no true/false order, and the first one stays.
      const before = JSON.stringify(await rowOf(id));
      const again = await startAttempt(her, "bake-figures-1", t.db);
      expect(again.attempt.id).not.toBe(id);
      expect(again.attempt.tfOrder).toEqual([]);
      await finishAttempt(her, again.attempt.id, 5, t.db);
      expect(JSON.stringify(await rowOf(id))).toBe(before);

      const figures = (await listMockExams(her, t.db)).find((e) => e.id === "bake-figures-1")!;
      expect([figures.status, figures.best, figures.latest, figures.attempts, figures.totalPoints]).toEqual(["done", 5, 0, 2, 18]);
    },
    T,
  );

  it(
    "history carries kind, total and percent, so sets of different size can be compared",
    async () => {
      const exam = await sit(her, "bake-1"); // 6 of 24
      const drill = await startAttempt(her, "bake-figures-1", t.db);
      await finishAttempt(her, drill.attempt.id, 9, t.db);
      await setTicks(her, drill.attempt.id, "2.0.0", [{ index: 0, fromCheck: false }, { index: 1, fromCheck: false }], false, t.db); // 2.5 of 18
      const all = await listAttempts(her, undefined, t.db);
      expect(all.map((s) => [s.id, s.kind, s.totalPoints, s.score.total, s.score.max, s.percent])).toEqual([
        [exam.attempt.id, "mock", 24, 6, 24, 25],
        [drill.attempt.id, "drill-figure", 18, 2.5, 18, 13.9],
      ]);
      expect((await listAttempts(her, "bake-figures-1", t.db)).map((s) => s.percent)).toEqual([13.9]);
      expect((await getAttempt(her, exam.attempt.id, t.db))!.attempt).toMatchObject({ kind: "mock", totalPoints: 24 });
    },
    T,
  );

  it("works out a percent with one decimal, and 0 when there is nothing to score", () => {
    expect(percentOf({ total: 7.5, max: 18 })).toBe(41.7);
    expect(percentOf({ total: 24, max: 24 })).toBe(100);
    expect(percentOf({ total: 0, max: 0 })).toBe(0);
    expect(percentOf({ total: Number.NaN, max: 24 })).toBe(0);
  });
});

describe("a set whose key, ticks or points change after she sat it", () => {
  /** A changed bake-1 that still passes the check. */
  function changed(change: (exam: MockExam) => void): MockExam {
    const exam = sampleExam();
    change(exam);
    expect(checkMockExam(JSON.parse(JSON.stringify(exam))).ok).toBe(true);
    return exam;
  }
  const reupload = async (exam: MockExam) => expect(await applyMockExams(t.db, her, herCourse, [file(exam)], PAGES)).toEqual({ created: 0, skipped: 0, updated: 1 });

  /** One finished and marked attempt (6 + 2 + 1 = 9 of 24) and one open one with answers. */
  async function sitBoth() {
    const done = await sit(her, "bake-1");
    await setTicks(her, done.attempt.id, "2.0.0", [{ index: 0, fromCheck: false }, { index: 1, fromCheck: true }, { index: 2, fromCheck: false }], false, t.db);
    await setTicks(her, done.attempt.id, "4.0.0", [{ index: 3, fromCheck: false }], false, t.db);
    const open = await startAttempt(her, "bake-1", t.db);
    await saveAnswer(her, open.attempt.id, { kind: "trueFalse", item: 5, answer: true }, 20, t.db);
    await saveAnswer(her, open.attempt.id, { kind: "text", part: "4.0.0", text: "Four eggs." }, 30, t.db);
    return { done: done.attempt.id, open: open.attempt.id, rows: JSON.stringify([await rowOf(done.attempt.id), await rowOf(open.attempt.id)]) };
  }
  const rows = async (ids: { done: string; open: string }) => JSON.stringify([await rowOf(ids.done), await rowOf(ids.open)]);

  it(
    "keeps stored attempts as they were and readable when the set loses its true/false question",
    async () => {
      const ids = await sitBoth();
      await reupload(
        changed((exam) => {
          exam.questions.shift();
          exam.totalPoints = 18;
        }),
      );
      expect(await rows(ids)).toBe(ids.rows);

      // The finished one: stored score, answers and ticks as they were; no true/false order to show.
      const done = (await getAttempt(her, ids.done, t.db))!;
      expect(done.finished).toBe(true);
      expect(done.exam.questions).toHaveLength(3);
      expect(done.attempt.tfOrder).toEqual([]);
      expect(done.attempt.trueFalse).toEqual(SAMPLE_ALL_RIGHT);
      expect(done.attempt.score).toMatchObject({ total: 9, max: 24 });
      expect(done.attempt.score!.questions).toHaveLength(4);
      expect(done.attempt.totalPoints).toBe(18);
      // The lists still read: the stored total against the stored maximum.
      expect((await listAttempts(her, "bake-1", t.db)).map((s) => [s.score.total, s.score.max, s.percent, s.totalPoints])).toEqual([[9, 24, 37.5, 18]]);
      const listing = (await listMockExams(her, t.db)).find((e) => e.id === "bake-1")!;
      expect([listing.status, listing.best, listing.latest, listing.totalPoints]).toEqual(["open", 9, 9, 18]);

      // The open one goes on: no item to answer any more, texts still saved, and it is scored as the set is now.
      const open = (await getOpenAttempt(her, "bake-1", t.db))!;
      expect(open.attempt.id).toBe(ids.open);
      expect(open.attempt.tfOrder).toEqual([]);
      expect(open.attempt.texts).toEqual({ "4.0.0": "Four eggs." });
      expect(await saveAnswer(her, ids.open, { kind: "trueFalse", item: 0, answer: true }, undefined, t.db)).toBe(false);
      expect(await saveAnswer(her, ids.open, { kind: "text", part: "3.0.0", text: "It relaxes." }, undefined, t.db)).toBe(true);
      const finished = await finishAttempt(her, ids.open, 60, t.db);
      expect(finished.attempt.score).toMatchObject({ total: 0, max: 18 });
      expect(finished.attempt.score!.questions.map((q) => q.number)).toEqual([2, 3, 4]);

      // Only a new marking of the old attempt scores it again, as the set is now: 2 + 1, no question 1.
      const remarked = await setTicks(her, ids.done, "3.0.0", [], true, t.db);
      expect(remarked.score).toMatchObject({ total: 3, max: 18 });
      expect(remarked.score!.questions).toHaveLength(3);
      expect(remarked.edited).toBe(true);
    },
    T,
  );

  it(
    "reads an attempt whose ticks and parts the set no longer has, and whose true/false question got shorter",
    async () => {
      const ids = await sitBoth();
      await reupload(
        changed((exam) => {
          const [q1, q2] = exam.questions;
          if (q1.type !== "truefalse" || q2.type !== "written") throw new Error("the sample's first two questions");
          q1.items = q1.items.slice(0, 4).map((item, i) => (i === 0 ? { ...item, answer: false } : item)); // two items gone, one key turned
          q1.points = 4;
          q2.sections[0].parts[0].ticks = [{ text: "KEY-TICK the only tick now", points: 2 }]; // ticks 1 and 2 are gone
          exam.questions.pop(); // question 4 and its part are gone
          exam.totalPoints = 16;
        }),
      );
      expect(await rows(ids)).toBe(ids.rows);

      const done = (await getAttempt(her, ids.done, t.db))!;
      // Each item the set has now, once, in the order she had them; the two that are gone are left out.
      expect([...done.attempt.tfOrder].sort()).toEqual([0, 1, 2, 3]);
      const stored = (await rowOf(ids.done)).tfOrder;
      expect(done.attempt.tfOrder).toEqual(stored.filter((i) => i < 4));
      // Her ticks and answers come back as stored, also the ones that point at nothing now.
      expect(done.attempt.ticks).toEqual({
        "2.0.0": [{ index: 0, fromCheck: false }, { index: 1, fromCheck: true }, { index: 2, fromCheck: false }],
        "4.0.0": [{ index: 3, fromCheck: false }],
      });
      expect(done.attempt.score).toMatchObject({ total: 9, max: 24 });
      expect((await listAttempts(her, undefined, t.db)).map((s) => s.score.total)).toEqual([9]);
      expect((await getMockExam(her, "bake-1", t.db))!.listing).toMatchObject({ best: 9, latest: 9, totalPoints: 16 });

      // The part that is gone cannot be ticked; a part that stayed is marked against its ticks of now.
      await expect(setTicks(her, ids.done, "4.0.0", [{ index: 0, fromCheck: false }], true, t.db)).rejects.toBeInstanceOf(MockExamNotFound);
      const remarked = await setTicks(her, ids.done, "2.0.0", [{ index: 0, fromCheck: false }, { index: 1, fromCheck: true }, { index: 2, fromCheck: false }], true, t.db);
      expect(remarked.ticks["2.0.0"]).toEqual([{ index: 0, fromCheck: false }]);
      // Question 1 by the new key: items 1 to 3 right, item 0 wrong now, 4 and 5 gone: 2. Question 2: 2. Her old tick on the gone part counts for nothing.
      expect(remarked.score!.questions.map((q) => [q.number, q.score])).toEqual([[1, 2], [2, 2], [3, 0]]);
      expect(remarked.score).toMatchObject({ total: 4, max: 16 });
      expect(remarked.ticks["4.0.0"]).toEqual([{ index: 3, fromCheck: false }]);

      // The open attempt: its answer to an item that is gone is refused from now on, the rest goes on.
      expect(await saveAnswer(her, ids.open, { kind: "trueFalse", item: 5, answer: false }, undefined, t.db)).toBe(false);
      expect(await saveAnswer(her, ids.open, { kind: "trueFalse", item: 3, answer: true }, undefined, t.db)).toBe(true);
      expect(await saveAnswer(her, ids.open, { kind: "text", part: "4.0.0", text: "Later." }, undefined, t.db)).toBe(false);
      const finished = await finishAttempt(her, ids.open, undefined, t.db);
      expect(finished.attempt.score).toMatchObject({ total: 1, max: 16 });
    },
    T,
  );

  it(
    "shows every item when the true/false question got longer",
    async () => {
      const ids = await sitBoth();
      await reupload(
        changed((exam) => {
          const q1 = exam.questions[0];
          if (q1.type !== "truefalse") throw new Error("the sample's first question");
          q1.items = [...q1.items, { ...q1.items[0], text: "A seventh invented item." }, { ...q1.items[1], text: "An eighth invented item." }];
          q1.points = 8;
          exam.totalPoints = 26;
        }),
      );
      const stored = (await rowOf(ids.done)).tfOrder;
      const done = (await getAttempt(her, ids.done, t.db))!;
      expect(done.attempt.tfOrder).toEqual([...stored, 6, 7]);
      expect(done.attempt.score).toMatchObject({ total: 9, max: 24 });
      const open = (await getOpenAttempt(her, "bake-1", t.db))!;
      expect([...open.attempt.tfOrder].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(await saveAnswer(her, ids.open, { kind: "trueFalse", item: 7, answer: false }, undefined, t.db)).toBe(true);
      // A new attempt shuffles all eight.
      await finishAttempt(her, ids.open, undefined, t.db);
      expect([...(await startAttempt(her, "bake-1", t.db)).attempt.tfOrder].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    },
    T,
  );

  it("fits a stored order to the items there are", () => {
    expect(fittedOrder([3, 1, 0, 2], 4)).toEqual([3, 1, 0, 2]);
    expect(fittedOrder([5, 3, 1, 4, 0, 2], 4)).toEqual([3, 1, 0, 2]);
    expect(fittedOrder([1, 0], 4)).toEqual([1, 0, 2, 3]);
    expect(fittedOrder([2, 2, -1, 1.5, "0", null, 9], 3)).toEqual([2, 0, 1]);
    expect(fittedOrder([4, 2, 0], 0)).toEqual([]);
    expect(fittedOrder(null, 2)).toEqual([0, 1]);
    expect(fittedOrder(undefined, 0)).toEqual([]);
  });
});
