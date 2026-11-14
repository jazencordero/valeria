// @vitest-environment node
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { aiCache, jobs } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { drain, enqueue } from "@/server/jobs/queue";
import { POST } from "@/app/api/cron/estimate/route";
import { startFakeAi, type FakeAi } from "../../../../tests/fake-ai/server";
import { PROVIDERS } from "../providers.config";
import { createRouter } from "../router";
import {
  briefText,
  ESTIMATE_AI_JOB,
  ESTIMATE_KIND,
  estimateJob,
  estimateMinutes,
  parseMinutes,
  type EstimateTally,
} from "./estimate";

// A real free entry from the config, so the allow-list check passes; its URL points at the fake.
const GROQ = PROVIDERS.small.find((e) => e.provider === "groq")!;
// Made-up key for tests only.
const ENV = { GROQ_API_KEY: "fake-groq-key" };
const NOW = new Date("2026-11-15T10:00:00.000Z");
const BRIEF = "PRIVATE-BRIEF-5c1e: write a 2000-word essay on photosynthesis";
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

function runText() {
  return createRouter({
    providers: { small: [GROQ], medium: [GROQ], large: [GROQ] },
    env: ENV,
    database: t.db,
    now: () => NOW,
    baseUrlFor: (entry) => `${ai.url}/${entry.provider}/v1`,
  }).runText;
}

let moodleIds = 1;

/** A user, one course with the given AI policy, and one assignment in it with a brief and one attached file. */
async function assignment(opts: { aiPolicy?: "unknown" | "allowed" | "not_allowed"; intro?: string; files?: string[] } = {}) {
  const [user] = await t.db.insert(users).values({}).returning({ id: users.id });
  const [course] = await t.db
    .insert(courses)
    .values({ userId: user.id, moodleId: moodleIds++, name: "Biology 101", aiPolicy: opts.aiPolicy ?? "allowed" })
    .returning({ id: courses.id });
  const [a] = await t.db
    .insert(assignments)
    .values({ userId: user.id, courseId: course.id, moodleId: moodleIds++, name: "Essay", introHtml: opts.intro ?? `<p>${BRIEF}</p>` })
    .returning({ id: assignments.id });
  for (const name of opts.files ?? ["reading-list.pdf"]) {
    await t.db.insert(courseFiles).values({
      userId: user.id,
      courseId: course.id,
      assignmentId: a.id,
      moodleRef: `ref-${moodleIds++}`,
      name,
      url: "https://example.invalid/file",
    });
  }
  return { userId: user.id, assignmentId: a.id };
}

async function estimateOf(assignmentId: string) {
  const [row] = await t.db.select({ m: assignments.estimateMin }).from(assignments).where(eq(assignments.id, assignmentId));
  return row.m;
}

async function estimateJobs() {
  return t.db.select().from(jobs).where(eq(jobs.kind, ESTIMATE_KIND)).orderBy(asc(jobs.createdAt));
}

/** Queues one estimate job for the assignment and drains the queue once. */
async function runJob(assignmentId: string, userId: string) {
  await enqueue(ESTIMATE_KIND, { assignmentId }, { userId, dedupeKey: assignmentId, db: t.db, now: () => NOW });
  const tally: EstimateTally = { estimated: 0, skipped: 0, noNumber: 0 };
  const result = await drain(ESTIMATE_KIND, estimateJob({ tally, db: t.db, runText: runText() }), { db: t.db, now: () => NOW });
  return { result, tally };
}

describe("parseMinutes", () => {
  it("takes the first whole number, rounds it to 15 and holds it to 15..600", () => {
    expect(parseMinutes("47")).toBe(45);
    expect(parseMinutes("9999")).toBe(600);
    expect(parseMinutes("53")).toBe(60);
    expect(parseMinutes("3")).toBe(15);
    expect(parseMinutes("0")).toBe(15);
    expect(parseMinutes("About 120 minutes, maybe 180")).toBe(120);
    expect(parseMinutes("9".repeat(400))).toBe(600);
  });

  it("gives null when the reply has no number", () => {
    expect(parseMinutes("about an hour")).toBeNull();
    expect(parseMinutes("")).toBeNull();
  });
});

describe("briefText", () => {
  it("drops tags, decodes entities and collapses white space", () => {
    expect(briefText("<p>Read &amp; summarise</p>\n<ul><li>Part&nbsp;1</li><li>Part 2</li></ul><script>x()</script>")).toBe(
      "Read & summarise\nPart 1\nPart 2",
    );
    expect(briefText(null)).toBe("");
  });
});

describe("estimate job, with the fake AI", () => {
  it("writes 45 when the model says 47, sending the brief and the attachment names to the small model", async () => {
    const { userId, assignmentId } = await assignment();
    ai.queue("groq", { text: "47" });

    const { result, tally } = await runJob(assignmentId, userId);

    expect(result).toEqual({ done: 1, retried: 0, failed: 0 });
    expect(tally).toEqual({ estimated: 1, skipped: 0, noNumber: 0 });
    expect(await estimateOf(assignmentId)).toBe(45);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].model).toBe(GROQ.model);
    const sent = JSON.stringify(ai.calls[0].body);
    expect(sent).toContain(BRIEF);
    expect(sent).toContain("reading-list.pdf");
    // The brief, prompt and reply are never logged.
    expect(logs).toEqual([]);
  }, SLOW);

  it("writes 600 when the model says 9999", async () => {
    const { userId, assignmentId } = await assignment();
    ai.queue("groq", { text: "9999" });
    await runJob(assignmentId, userId);
    expect(await estimateOf(assignmentId)).toBe(600);
  }, SLOW);

  it("leaves estimate_min null when the reply is not a number, and the job ends done", async () => {
    const { userId, assignmentId } = await assignment();
    ai.queue("groq", { text: "It depends on the student." });

    const { result, tally } = await runJob(assignmentId, userId);

    expect(result).toEqual({ done: 1, retried: 0, failed: 0 });
    expect(tally).toEqual({ estimated: 0, skipped: 0, noNumber: 1 });
    expect(await estimateOf(assignmentId)).toBeNull();
    expect((await estimateJobs()).map((j) => j.status)).toEqual(["done"]);
  }, SLOW);

  it("throws AiBusy when every provider is limited, so the queue tries again later", async () => {
    const { userId, assignmentId } = await assignment();
    ai.queue("groq", { status: 429, retryAfter: 30 });

    const { result } = await runJob(assignmentId, userId);

    expect(result).toEqual({ done: 0, retried: 1, failed: 0 });
    expect(await estimateOf(assignmentId)).toBeNull();
    const [job] = await estimateJobs();
    expect(job.status).toBe("queued");
    expect(job.lastError).toMatch(/^AiBusy/);
    expect(job.lastError).not.toContain(BRIEF);
    expect(await t.db.select().from(aiCache)).toEqual([]);
  }, SLOW);

  it("makes no AI call for a course not marked as allowing AI", async () => {
    for (const aiPolicy of ["unknown", "not_allowed"] as const) {
      ai.reset();
      const { userId, assignmentId } = await assignment({ aiPolicy });
      ai.setDefault("groq", { text: "60" });

      const { result, tally } = await runJob(assignmentId, userId);

      expect(result).toEqual({ done: 1, retried: 0, failed: 0 });
      expect(tally).toEqual({ estimated: 0, skipped: 1, noNumber: 0 });
      expect(ai.calls).toEqual([]);
      expect(await estimateOf(assignmentId)).toBeNull();
    }
  }, SLOW);

  it("asks nothing for an assignment that already has an estimate, or has no brief and no files", async () => {
    const done = await assignment();
    await t.db.update(assignments).set({ estimateMin: 90 }).where(eq(assignments.id, done.assignmentId));
    const empty = await assignment({ intro: "<p> </p>", files: [] });

    expect((await runJob(done.assignmentId, done.userId)).tally.skipped).toBe(1);
    expect((await runJob(empty.assignmentId, empty.userId)).tally.skipped).toBe(1);
    expect(ai.calls).toEqual([]);
    expect(await estimateOf(done.assignmentId)).toBe(90);
  }, SLOW);

  it("caches by brief and attachment names: the same brief is asked once", async () => {
    ai.setDefault("groq", { text: "100" });
    const r = runText();
    const one = await estimateMinutes({ brief: BRIEF, attachments: ["a.pdf", "b.pdf"] }, { runText: r, db: t.db });
    const two = await estimateMinutes({ brief: BRIEF, attachments: ["b.pdf", "a.pdf"] }, { runText: r, db: t.db });
    const other = await estimateMinutes({ brief: BRIEF, attachments: ["c.pdf"] }, { runText: r, db: t.db });

    expect([one, two, other]).toEqual([105, 105, 105]);
    expect(ai.calls).toHaveLength(2);
    const cachedRows = await t.db.select().from(aiCache);
    expect(cachedRows.map((row) => row.job)).toEqual([ESTIMATE_AI_JOB, ESTIMATE_AI_JOB]);
    // The cache keeps the answer, not the brief.
    expect(JSON.stringify(cachedRows)).not.toContain(BRIEF);
  }, SLOW);
});

describe("POST /api/cron/estimate", () => {
  it("answers 401 without the cron secret, and with a wrong one", async () => {
    vi.stubEnv("CRON_SECRET", "test-only-cron-secret");
    expect((await POST(new Request("http://localhost/api/cron/estimate", { method: "POST" }))).status).toBe(401);
    const wrong = new Request("http://localhost/api/cron/estimate", {
      method: "POST",
      headers: { authorization: "Bearer not-the-secret" },
    });
    expect((await POST(wrong)).status).toBe(401);

    vi.stubEnv("CRON_SECRET", "");
    const none = new Request("http://localhost/api/cron/estimate", { method: "POST", headers: { authorization: "Bearer " } });
    expect((await POST(none)).status).toBe(401);
  });
});
