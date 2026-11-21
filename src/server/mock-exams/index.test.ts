// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SAMPLE_ALL_RIGHT, sampleExam } from "@/lib/mock-exams/sample-exam";
import type { AttemptView, MockExam } from "@/lib/mock-exams/types";
import { courses } from "@/server/db/schema/courses";
import { lectures } from "@/server/db/schema/learn";
import { mockExamAttempts, mockExams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { applyMockExams } from "./import";
import {
  finishAttempt,
  getAttempt,
  getMockExam,
  getOpenAttempt,
  listAttempts,
  listMockExams,
  MockExamNotFound,
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
      expect(start.checkAllowed).toBe(true);
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
