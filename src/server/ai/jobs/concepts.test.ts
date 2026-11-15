// @vitest-environment node
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/cron/concepts/route";
import { ensureSessionFor, newToken } from "@/server/auth/session";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courseFiles, courses, filePages } from "@/server/db/schema/courses";
import { cardConcepts, cards, concepts, exams } from "@/server/db/schema/study";
import { aiCache, jobs } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import { drain } from "@/server/jobs/queue";
import { ALLOWED_SITES, connectWithKey } from "@/server/moodle/connect";
import { DEMO_KEY } from "@/server/moodle/fake-inline";
import { addExam } from "@/server/study/exams";
import { syncCourses } from "@/server/sync/courses";
import { syncEvents, type SyncEventsDeps } from "@/server/sync/events";
import { BROKEN_JSON, startFakeAi, type FakeAi } from "../../../../tests/fake-ai/server";
import { DATA_RULE } from "../as-data";
import { PROVIDERS } from "../providers.config";
import { createRouter } from "../router";
import {
  CONCEPTS_AI_JOB,
  CONCEPTS_KIND,
  conceptIcon,
  conceptsJob,
  sortConcepts,
  weighConcepts,
  type ConceptsTally,
} from "./concepts";

// A real free entry from the config, so the allow-list check passes; its URL points at the fake.
const GROQ = PROVIDERS.small.find((e) => e.provider === "groq")!;
// Made-up values for tests only.
const ENV = { GROQ_API_KEY: "fake-groq-key" };
const FAKE_SECRET = "test-only-seal-secret-not-real";
const NOW = new Date("2026-11-15T10:00:00.000Z");
const SECRET_TEXT = "PRIVATE-SLIDE-7f3a";
const SLOW = 120_000;

let ai: FakeAi;
let t: TestDb;
let logs: unknown[][];

beforeAll(async () => {
  ai = await startFakeAi();
});
afterAll(async () => {
  await ai.close();
});
beforeEach(async () => {
  ai.reset();
  t = await createTestDb();
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
  }
}, SLOW);
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await t.close();
});

function runObject() {
  return createRouter({
    providers: { small: [GROQ], medium: [GROQ], large: [GROQ] },
    env: ENV,
    database: t.db,
    now: () => NOW,
    baseUrlFor: (entry) => `${ai.url}/${entry.provider}/v1`,
  }).runObject;
}

let moodleIds = 1;

type Lecture = { section: string; name: string; pages: string[]; assignment?: boolean; status?: "done" | "queued" };

const LECTURES: Lecture[] = [
  // Inserted out of order: lecture order comes from the section names.
  { section: "Week 2", name: "Stationarity.pdf", pages: ["Weak stationarity", "Unit roots", "ADF test"] },
  { section: "Week 1", name: "Intro.pdf", pages: [`${SECRET_TEXT} Time series basics`] },
  { section: "Week 10", name: "Forecasting.pdf", pages: ["ARIMA", "Forecast errors", "Intervals", "Back-testing", "Summary", "Q&A"] },
];

/** A user, a course with the given study rule, its lecture files and pages, and an exam on it. */
async function course(opts: { aiStudy?: "unknown" | "allowed" | "not_allowed"; useFiles?: boolean; lectures?: Lecture[] } = {}) {
  const [user] = await t.db
    .insert(users)
    .values({ settings: opts.useFiles === false ? { ai: { useFiles: false } } : {} })
    .returning({ id: users.id });
  const [c] = await t.db
    .insert(courses)
    .values({ userId: user.id, moodleId: moodleIds++, name: "Time Series", aiStudy: opts.aiStudy ?? "allowed" })
    .returning({ id: courses.id });
  await addFiles(user.id, c.id, opts.lectures ?? LECTURES);
  const [exam] = await t.db
    .insert(exams)
    .values({ userId: user.id, courseId: c.id, title: "Final exam", at: new Date("2026-12-15T09:00:00Z") })
    .returning({ id: exams.id });
  return { userId: user.id, courseId: c.id, examId: exam.id };
}

async function addFiles(userId: string, courseId: string, lectures: Lecture[]) {
  for (const l of lectures) {
    const [file] = await t.db
      .insert(courseFiles)
      .values({
        userId,
        courseId,
        moodleRef: `ref-${moodleIds++}`,
        section: l.section,
        name: l.name,
        url: "https://example.invalid/file",
        textStatus: l.status ?? "done",
      })
      .returning({ id: courseFiles.id });
    if (l.pages.length) {
      await t.db.insert(filePages).values(l.pages.map((text, i) => ({ fileId: file.id, page: i + 1, text })));
    }
  }
}

const reply = (items: { name: string; lecture: number; weight: number }[]) => ({ text: JSON.stringify({ concepts: items }) });

const FOUR = [
  { name: "Time series basics", lecture: 1, weight: 1 },
  { name: "Stationarity", lecture: 2, weight: 0.6 },
  { name: "Unit root tests", lecture: 2, weight: 0.4 },
  { name: "ARIMA forecasting", lecture: 3, weight: 1 },
];
const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Concept ${i + 1}`, lecture: 1, weight: 0.1 }));

async function conceptsOf(examId: string) {
  return t.db.select().from(concepts).where(eq(concepts.examId, examId)).orderBy(asc(concepts.position));
}

async function conceptJobs() {
  return t.db.select().from(jobs).where(eq(jobs.kind, CONCEPTS_KIND)).orderBy(asc(jobs.createdAt));
}

/** Queues one concepts job for the exam (as addExam would) and drains the queue once. */
async function runJob(examId: string, userId: string) {
  const { enqueue } = await import("@/server/jobs/queue");
  await enqueue(CONCEPTS_KIND, { examId }, { userId, dedupeKey: `exam:${examId}`, db: t.db, now: () => NOW });
  const tally: ConceptsTally = { made: 0, skipped: 0, kept: 0, badOutput: 0 };
  const result = await drain(CONCEPTS_KIND, conceptsJob({ tally, db: t.db, runObject: runObject() }), {
    db: t.db,
    now: () => NOW,
  });
  return { result, tally };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("weighConcepts", () => {
  it("weights by page share, split inside a lecture by the model's weights, renormalised to 1", () => {
    const files = [
      { n: 1, pages: 1 },
      { n: 2, pages: 3 },
      { n: 3, pages: 6 },
    ];
    const out = weighConcepts(
      [
        { name: "C", lecture: 3, weight: 5 },
        { name: "A", lecture: 1, weight: 2 },
        { name: "B1", lecture: 2, weight: 3 },
        { name: "B2", lecture: 2, weight: 1 },
      ],
      files,
    );
    expect(out.map((c) => c.name)).toEqual(["A", "B1", "B2", "C"]);
    expect(out.map((c) => c.weight)).toEqual([0.1, 0.225, 0.075, 0.6].map((w) => expect.closeTo(w, 10)));
    expect(sum(out.map((c) => c.weight))).toBeCloseTo(1, 10);
  });

  it("falls back to the model's weights, then to equal ones, when there are no pages", () => {
    const noPages = [{ n: 1, pages: 0 }];
    const a = weighConcepts([{ name: "x", lecture: 1, weight: 3 }, { name: "y", lecture: 1, weight: 1 }], noPages);
    expect(a.map((c) => c.weight)).toEqual([0.75, 0.25]);
    const b = weighConcepts([{ name: "x", lecture: 1, weight: 0 }, { name: "y", lecture: 1, weight: 0 }], noPages);
    expect(b.map((c) => c.weight)).toEqual([0.5, 0.5]);
  });
});

describe("conceptIcon", () => {
  it("picks an icon from the prototype set by keyword, and the dot when nothing matches", () => {
    expect(conceptIcon("Data governance")).toBe("governance");
    expect(conceptIcon("Time series data")).toBe("timeSeries");
    expect(conceptIcon("Autocorrelation function")).toBe("chart");
    expect(conceptIcon("Weak stationarity")).toBe("timeSeries");
    expect(conceptIcon("Trend and growth")).toBe("difference");
    expect(conceptIcon("GDPR and privacy")).toBe("governance");
    expect(conceptIcon("Service level agreements")).toBe("contract");
    expect(conceptIcon("Pricing strategy")).toBe("decision");
    expect(conceptIcon("Relational databases")).toBe("data");
    expect(conceptIcon("Mitochondria")).toBe("dot");
  });
});

describe("concepts job, with the fake AI", () => {
  it("writes 4 concepts in lecture order with weights from page share summing to 1, file text inside asData", async () => {
    const { userId, examId } = await course();
    // The model's weights sum to 3; they are renormalised.
    ai.queue("groq", reply([FOUR[3], FOUR[0], FOUR[1], FOUR[2]]));

    const { result, tally } = await runJob(examId, userId);

    expect(result).toEqual({ done: 1, retried: 0, failed: 0 });
    expect(tally).toEqual({ made: 1, skipped: 0, kept: 0, badOutput: 0 });
    const rows = await conceptsOf(examId);
    expect(rows.map((r) => [r.name, r.lecture, r.position])).toEqual([
      ["Time series basics", "1", 0],
      ["Stationarity", "2", 1],
      ["Unit root tests", "2", 2],
      ["ARIMA forecasting", "3", 3],
    ]);
    // Pages: Intro 1, Stationarity 3, Forecasting 6 (of 10).
    expect(rows.map((r) => r.weight)).toEqual([0.1, 0.18, 0.12, 0.6].map((w) => expect.closeTo(w, 6)));
    expect(sum(rows.map((r) => r.weight))).toBeCloseTo(1, 6);
    expect(rows.map((r) => r.icon)).toEqual(["timeSeries", "timeSeries", "dot", "timeSeries"]);

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].model).toBe(GROQ.model);
    const sent = JSON.stringify(ai.calls[0].body);
    // The file text is sent, and only between the course-material markers, under the data rule.
    expect(sent).toContain(JSON.stringify(DATA_RULE).slice(1, -1));
    const userText = (ai.calls[0].body.messages as { role: string; content: unknown }[]).find((m) => m.role === "user")!;
    const content = JSON.stringify(userText.content);
    const at = content.indexOf(SECRET_TEXT);
    expect(at).toBeGreaterThan(-1);
    const open = content.lastIndexOf("<<<COURSE MATERIAL: Lecture 1: Intro.pdf", at);
    const close = content.indexOf("<<<END OF COURSE MATERIAL>>>", at);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(at);
    // Lecture order is by section, numeric: Week 1, Week 2, Week 10.
    expect(content.indexOf("Lecture 2: Stationarity.pdf")).toBeLessThan(content.indexOf("Lecture 3: Forecasting.pdf"));
    // Nothing logged, and the cache holds no file text.
    expect(logs).toEqual([]);
    expect(JSON.stringify(await t.db.select().from(aiCache))).not.toContain(SECRET_TEXT);
  }, SLOW);

  it("rejects 3 concepts and asks once more; the second answer is written", async () => {
    const { userId, examId } = await course();
    ai.queue("groq", reply(FOUR.slice(0, 3)), reply(FOUR));

    const { tally } = await runJob(examId, userId);

    expect(tally.made).toBe(1);
    expect(ai.calls).toHaveLength(2);
    expect(await conceptsOf(examId)).toHaveLength(4);
  }, SLOW);

  it("rejects 30 concepts and asks once more; a second bad answer ends the job done with nothing written", async () => {
    const { userId, examId } = await course();
    ai.queue("groq", reply(many(30)), reply(many(3)));
    ai.setDefault("groq", reply(FOUR));

    const { result, tally } = await runJob(examId, userId);

    expect(result).toEqual({ done: 1, retried: 0, failed: 0 });
    expect(tally).toEqual({ made: 0, skipped: 0, kept: 0, badOutput: 1 });
    // One first answer and one repair, never a third try.
    expect(ai.calls).toHaveLength(2);
    expect(await conceptsOf(examId)).toEqual([]);
    expect(await t.db.select().from(aiCache)).toEqual([]);
    expect((await conceptJobs()).map((j) => j.status)).toEqual(["done"]);
  }, SLOW);

  it("rejects a lecture number that does not exist, and broken JSON, the same way", async () => {
    const { userId, examId } = await course();
    ai.queue("groq", reply([...FOUR.slice(0, 3), { name: "Ghost", lecture: 9, weight: 1 }]), { text: BROKEN_JSON });

    const { tally } = await runJob(examId, userId);

    expect(tally.badOutput).toBe(1);
    expect(ai.calls).toHaveLength(2);
  }, SLOW);

  it("asks the model once for the same input: the answer is cached", async () => {
    ai.setDefault("groq", reply(FOUR));
    const files = [
      { n: 1, name: "Intro.pdf", section: "Week 1", pages: 1, excerpt: "Basics" },
      { n: 2, name: "Stationarity.pdf", section: "Week 2", pages: 3, excerpt: "Unit roots" },
      { n: 3, name: "Forecasting.pdf", section: "Week 10", pages: 6, excerpt: "ARIMA" },
    ];
    const r = runObject();
    const one = await sortConcepts({ files }, { runObject: r, db: t.db });
    const two = await sortConcepts({ files: files.map((f) => ({ ...f })) }, { runObject: r, db: t.db });
    const other = await sortConcepts({ files: [...files.slice(0, 2), { ...files[2], excerpt: "ARIMA, changed" }] }, { runObject: r, db: t.db });

    expect(two).toEqual(one);
    expect(other).toEqual(one);
    expect(ai.calls).toHaveLength(2);
    expect((await t.db.select().from(aiCache)).map((row) => row.job)).toEqual([CONCEPTS_AI_JOB, CONCEPTS_AI_JOB]);
  }, SLOW);

  it("asks nothing when mayUseFiles says no: the course's study rule is not 'allowed', or her switch is off", async () => {
    ai.setDefault("groq", reply(FOUR));
    for (const opts of [{ aiStudy: "unknown" as const }, { aiStudy: "not_allowed" as const }, { useFiles: false }]) {
      const { userId, examId } = await course(opts);
      const { result, tally } = await runJob(examId, userId);
      expect(result).toEqual({ done: 1, retried: 0, failed: 0 });
      expect(tally).toEqual({ made: 0, skipped: 1, kept: 0, badOutput: 0 });
      expect(await conceptsOf(examId)).toEqual([]);
    }
    expect(ai.calls).toEqual([]);
  }, SLOW);

  it("throws AiBusy when every provider is limited, so the queue tries again later", async () => {
    const { userId, examId } = await course();
    ai.queue("groq", { status: 429, retryAfter: 30 });

    const { result } = await runJob(examId, userId);

    expect(result).toEqual({ done: 0, retried: 1, failed: 0 });
    const [job] = await conceptJobs();
    expect(job.status).toBe("queued");
    expect(job.lastError).toMatch(/^AiBusy/);
    expect(job.lastError).not.toContain(SECRET_TEXT);
    expect(await conceptsOf(examId)).toEqual([]);
  }, SLOW);

  it("replaces the exam's concepts on a second run, and keeps them untouched once cards use them", async () => {
    const { userId, examId } = await course();
    ai.queue("groq", reply(FOUR));
    await runJob(examId, userId);
    const first = await conceptsOf(examId);

    // New material, a new answer: the old set is replaced, not added to.
    await addFiles(userId, (await t.db.select().from(exams).where(eq(exams.id, examId)))[0].courseId, [
      { section: "Week 11", name: "Review.pdf", pages: ["Recap"] },
    ]);
    ai.queue("groq", reply([...FOUR, { name: "Exam review", lecture: 4, weight: 1 }]));
    expect((await runJob(examId, userId)).tally.made).toBe(1);
    const second = await conceptsOf(examId);
    expect(second.map((c) => c.name)).toEqual([...FOUR.map((c) => c.name), "Exam review"]);
    expect(second.some((c) => first.some((f) => f.id === c.id))).toBe(false);

    // A card on one of them: the next run asks nothing and changes nothing.
    const [card] = await t.db
      .insert(cards)
      .values({ userId, examId, type: "basic", body: { q: "?", a: "!" }, origin: "ai", contentHash: "h1" })
      .returning({ id: cards.id });
    await t.db.insert(cardConcepts).values({ cardId: card.id, conceptId: second[0].id });
    ai.reset();
    ai.setDefault("groq", reply(FOUR));
    expect((await runJob(examId, userId)).tally).toEqual({ made: 0, skipped: 0, kept: 1, badOutput: 0 });
    expect(ai.calls).toEqual([]);
    expect((await conceptsOf(examId)).map((c) => c.id)).toEqual(second.map((c) => c.id));
  }, SLOW);

  it("skips a course with no extracted lecture files: a file whose text is not read yet does not count", async () => {
    const { userId, examId } = await course({
      lectures: [{ section: "Week 1", name: "Queued.pdf", pages: [], status: "queued" }],
    });
    expect((await runJob(examId, userId)).tally.skipped).toBe(1);
    expect(ai.calls).toEqual([]);
  }, SLOW);
});

describe("queueing: addExam and syncEvents", () => {
  it("addExam queues one concepts job when the course has extracted files, and none when it has not", async () => {
    const { userId, courseId } = await course();
    const exam = await addExam(userId, { courseId, title: "Midterm", kind: "exam", at: new Date("2026-12-20T09:00:00Z") }, t.db);

    const queued = await conceptJobs();
    expect(queued).toHaveLength(1);
    expect(queued[0].userId).toBe(userId);
    expect(queued[0].payload).toMatchObject({ examId: exam.id, _dedupeKey: `exam:${exam.id}` });

    const empty = await course({ lectures: [] });
    await addExam(empty.userId, { courseId: empty.courseId, title: "Quiz", kind: "quiz", at: new Date("2026-12-20T09:00:00Z") }, t.db);
    expect(await conceptJobs()).toHaveLength(1);
  }, SLOW);

  it("syncEvents queues one job per suggested exam whose course has extracted files, deduped across syncs", async () => {
    vi.stubEnv("MOODLE_FAKE", "1");
    vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
    const { user } = await ensureSessionFor(t.db, newToken());
    const connected = await connectWithKey(user.id, ALLOWED_SITES[0], DEMO_KEY, t.db);
    if (!connected.ok) throw new Error("the fake Moodle rejected the demo key");
    const userId = connected.userId;
    await syncCourses(userId, t.db);
    const [withFiles] = await t.db.select().from(courses).where(eq(courses.moodleId, 3101));
    await addFiles(userId, withFiles.id, LECTURES);

    const deps: SyncEventsDeps = {
      now: () => NOW.getTime(),
      getQuizzes: async () => [],
      getUpcoming: async () => [
        { moodleRef: "event:1", courseMoodleId: 3101, title: "Tentti", startsAt: new Date("2026-12-15T09:00:00Z"), module: "other", url: null },
        { moodleRef: "event:2", courseMoodleId: 3102, title: "Final exam", startsAt: new Date("2026-12-16T09:00:00Z"), module: "other", url: null },
      ],
    };
    expect((await syncEvents(userId, t.db, deps)).exams).toBe(2);
    expect((await syncEvents(userId, t.db, deps)).exams).toBe(0);

    const queued = await conceptJobs();
    expect(queued).toHaveLength(1);
    const [exam] = await t.db.select().from(exams).where(eq(exams.courseId, withFiles.id));
    expect(queued[0].payload).toMatchObject({ examId: exam.id });
  }, SLOW);
});

describe("POST /api/cron/concepts", () => {
  it("answers 401 without the cron secret, and with a wrong one", async () => {
    vi.stubEnv("CRON_SECRET", "test-only-cron-secret");
    expect((await POST(new Request("http://localhost/api/cron/concepts", { method: "POST" }))).status).toBe(401);
    const wrong = new Request("http://localhost/api/cron/concepts", {
      method: "POST",
      headers: { authorization: "Bearer not-the-secret" },
    });
    expect((await POST(wrong)).status).toBe(401);

    vi.stubEnv("CRON_SECRET", "");
    const none = new Request("http://localhost/api/cron/concepts", { method: "POST", headers: { authorization: "Bearer " } });
    expect((await POST(none)).status).toBe(401);
  });
});
