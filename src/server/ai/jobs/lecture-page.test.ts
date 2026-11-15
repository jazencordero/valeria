// @vitest-environment node
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/cron/lecture-page/route";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courseFiles, courses, filePages } from "@/server/db/schema/courses";
import { lectureContent, lectures } from "@/server/db/schema/learn";
import { aiCache, jobs } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import { drain, enqueue } from "@/server/jobs/queue";
import { BROKEN_JSON, startFakeAi, type FakeAi } from "../../../../tests/fake-ai/server";
import { DATA_RULE } from "../as-data";
import { PROVIDERS } from "../providers.config";
import { createRouter } from "../router";
import {
  LECTURE_PAGE_AI_JOB,
  LECTURE_PAGE_KIND,
  PROMPT_BUDGET,
  SLIDE_MIN,
  budgetSlides,
  lecturePageJob,
  parseSlides,
  readingMinutes,
  type LecturePageTally,
} from "./lecture-page";

// Real free entries from the config, so the allow-list check passes; their URLs point at the fake.
const SMALL = PROVIDERS.small.find((e) => e.provider === "groq")!;
const MEDIUM = PROVIDERS.medium.find((e) => e.provider === "groq" && e.model !== SMALL.model)!;
// Made-up values for tests only.
const ENV = { GROQ_API_KEY: "fake-groq-key" };
const NOW = new Date("2026-11-15T10:00:00.000Z");
const SECRET_TEXT = "PRIVATE-SLIDE-9c2e";
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
    providers: { small: [SMALL], medium: [MEDIUM], large: [SMALL] },
    env: ENV,
    database: t.db,
    now: () => NOW,
    baseUrlFor: (entry) => `${ai.url}/${entry.provider}/v1`,
  }).runObject;
}

let moodleIds = 1;

const ENGLISH = [
  `${SECRET_TEXT} Why forecast? The course is about forecasting time series and the questions it can answer for a business.`,
  "Stationarity: a series is weakly stationary when its mean and variance do not change over time, which is what the models need.",
  "Unit roots and the ADF test: the test checks whether the series has a unit root, and differencing removes it from the series.",
  "ARIMA models combine autoregression, differencing and moving averages. Forecast errors are measured on data kept out of the fit.",
];

const FINNISH = [
  "Miksi ennustaa? Tämä luento on kurssin ensimmäinen ja se kertoo, mitä aikasarjat ovat ja miten niitä käytetään.",
  "Stationaarisuus: sarja on heikosti stationaarinen, kun sen keskiarvo ja varianssi eivät muutu ajan kanssa, ja se on myös mallien ehto.",
  "Yksikköjuuri ja ADF-testi: testi kertoo, onko sarjassa yksikköjuuri, ja differointi poistaa sen sarjasta niin että malli toimii.",
];

type Spec = { aiStudy?: "unknown" | "allowed" | "not_allowed"; useFiles?: boolean; slides?: string[]; userId?: string };

/** A user, a course with the given study rule, one lecture file with its slide text, and its lecture. */
async function lecture(opts: Spec = {}) {
  let userId = opts.userId;
  if (!userId) {
    const [user] = await t.db
      .insert(users)
      .values({ settings: opts.useFiles === false ? { ai: { useFiles: false } } : {} })
      .returning({ id: users.id });
    userId = user.id;
  }
  const [c] = await t.db
    .insert(courses)
    .values({ userId, moodleId: moodleIds++, name: "Time Series", aiStudy: opts.aiStudy ?? "allowed" })
    .returning({ id: courses.id });
  const slides = opts.slides ?? ENGLISH;
  const [file] = await t.db
    .insert(courseFiles)
    .values({
      userId,
      courseId: c.id,
      moodleRef: `cm:${moodleIds++}:lecture-01.pdf`,
      section: "Week 1",
      name: "lecture-01.pdf",
      url: "https://example.invalid/file",
      textStatus: "done",
    })
    .returning({ id: courseFiles.id });
  if (slides.length) await t.db.insert(filePages).values(slides.map((text, i) => ({ fileId: file.id, page: i + 1, text })));
  const [row] = await t.db
    .insert(lectures)
    .values({ userId, courseId: c.id, n: 1, title: "why forecast", fileId: file.id })
    .returning({ id: lectures.id });
  return { userId, courseId: c.id, fileId: file.id, lectureId: row.id };
}

type Section = { heading: string; blocks: unknown[]; terms: string[]; slides: string };

const SECTIONS: Section[] = [
  // Out of slide order on purpose: the job puts them in order.
  { heading: "ARIMA", blocks: [["ul", ["Autoregression", "Differencing", "Moving averages"]]], terms: ["ARIMA"], slides: "slide 4" },
  { heading: "Why forecast", blocks: [["p", "The course is about forecasting time series."]], terms: ["time series"], slides: "slide 1" },
  {
    heading: "Stationarity and unit roots",
    blocks: [["dl", [["Weak stationarity", "Mean and variance do not change over time."]]], ["p", "Differencing removes a unit root."]],
    terms: ["stationarity", "unit root", "ADF test"],
    slides: "slides 2-3",
  },
];

const page = (sections: Section[] = SECTIONS, extra: Record<string, unknown> = {}) => ({
  text: JSON.stringify({
    breath: "This lecture explains why we forecast, what stationarity is and how ARIMA models work.",
    minutes: 42,
    sections,
    slideTitles: ["Why forecast?", "Stationarity", "Unit roots", "ARIMA", "extra title"],
    ...extra,
  }),
});

async function contentOf(lectureId: string) {
  return t.db.select().from(lectureContent).where(eq(lectureContent.lectureId, lectureId));
}

async function pageJobs() {
  return t.db.select().from(jobs).where(eq(jobs.kind, LECTURE_PAGE_KIND)).orderBy(asc(jobs.createdAt));
}

const emptyTally = (): LecturePageTally => ({ made: 0, thin: 0, skipped: 0, kept: 0, badOutput: 0 });

/** Queues one lecture-page job (as syncLectures would) and drains the queue once. */
async function runJob(lectureId: string, userId: string) {
  await enqueue(LECTURE_PAGE_KIND, { lectureId }, { userId, dedupeKey: `lecture:${lectureId}`, db: t.db, now: () => NOW });
  const tally = emptyTally();
  const result = await drain(LECTURE_PAGE_KIND, lecturePageJob({ tally, db: t.db, runObject: runObject() }), {
    db: t.db,
    now: () => NOW,
  });
  return { result, tally };
}

function userContent(call: number): string {
  const messages = ai.calls[call].body.messages as { role: string; content: unknown }[];
  return JSON.stringify(messages.filter((m) => m.role === "user").map((m) => m.content));
}

/** The whole request body: the system instructions are in it, wherever the SDK puts them. */
function systemText(call: number): string {
  return JSON.stringify(ai.calls[call].body);
}

describe("pure helpers", () => {
  it("reads slide ranges with a hyphen or an en dash, and refuses malformed or reversed ones", () => {
    expect(parseSlides("slides 2–5")).toEqual([2, 5]);
    expect(parseSlides("Slides 2 - 5")).toEqual([2, 5]);
    expect(parseSlides("slide 3")).toEqual([3, 3]);
    expect(parseSlides("pages 2–5")).toBeNull();
    expect(parseSlides("slides 5–2")).toBeNull();
    expect(parseSlides("2–5")).toBeNull();
  });

  it("budgets slide text: each slide cut to its share, and a huge deck sampled evenly with first and last kept", () => {
    const small = budgetSlides([{ page: 1, text: "a".repeat(50_000) }]);
    expect(small.slides[0].text).toHaveLength(2_000);
    expect(small.sampled).toBe(false);

    const count = Math.floor(PROMPT_BUDGET / SLIDE_MIN) * 2;
    const huge = budgetSlides(Array.from({ length: count }, (_, i) => ({ page: i + 1, text: "b".repeat(500) })));
    expect(huge.sampled).toBe(true);
    expect(huge.slides.length).toBeLessThanOrEqual(PROMPT_BUDGET / SLIDE_MIN);
    expect(huge.slides[0].page).toBe(1);
    expect(huge.slides[huge.slides.length - 1].page).toBe(count);
    expect(huge.slides.reduce((sum, s) => sum + s.text.length, 0)).toBeLessThanOrEqual(PROMPT_BUDGET);
  });

  it("counts reading minutes from the written words, at least 1", () => {
    expect(readingMinutes({ breath: "one two", sections: [] })).toBe(1);
    const words = Array.from({ length: 450 }, () => "word").join(" ");
    expect(readingMinutes({ breath: null, sections: [{ heading: "h", blocks: [["p", words]], terms: [], slides: "slide 1" }] })).toBe(3);
  });
});

describe("lecture-page job, with the fake AI", () => {
  it("writes the page in slide order with tidy ranges and counted minutes; slide text only inside asData", async () => {
    const { userId, lectureId } = await lecture();
    ai.queue("groq", page());

    const { result, tally } = await runJob(lectureId, userId);

    expect(result).toEqual({ done: 1, retried: 0, failed: 0 });
    expect(tally).toEqual({ ...emptyTally(), made: 1 });
    const [row] = await contentOf(lectureId);
    expect(row.breath).toMatch(/^This lecture explains/);
    expect((row.sections as Section[]).map((s) => [s.heading, s.slides])).toEqual([
      ["Why forecast", "slide 1"],
      ["Stationarity and unit roots", "slides 2–3"],
      ["ARIMA", "slide 4"],
    ]);
    // Not the model's 42: counted from the page's words.
    expect(row.minutes).toBe(1);
    // Cut to the deck's 4 slides.
    expect(row.slideTitles).toEqual(["Why forecast?", "Stationarity", "Unit roots", "ARIMA"]);
    expect(row.sourceHash).toMatch(/^[0-9a-f]{64}$/);

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].model).toBe(SMALL.model);
    expect(JSON.stringify(ai.calls[0].body)).toContain(JSON.stringify(DATA_RULE).slice(1, -1));
    expect(systemText(0)).toContain("Leave out anything the slides do not say");
    const content = userContent(0);
    const at = content.indexOf(SECRET_TEXT);
    expect(at).toBeGreaterThan(-1);
    const open = content.lastIndexOf("<<<COURSE MATERIAL: Lecture 1: why forecast", at);
    const close = content.indexOf("<<<END OF COURSE MATERIAL>>>", at);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(at);
    // Every slide's text sits between those markers.
    for (const slide of ENGLISH.slice(1)) {
      const i = content.indexOf(slide.slice(0, 30));
      expect(i).toBeGreaterThan(open);
      expect(i).toBeLessThan(close);
    }
    expect(logs).toEqual([]);
    expect(JSON.stringify(await t.db.select().from(aiCache))).not.toContain(SECRET_TEXT);
  }, SLOW);

  it("rejects a section citing a slide the file does not have, and asks once more; the second answer is written", async () => {
    const { userId, lectureId } = await lecture();
    const ghost = [...SECTIONS.slice(0, 2), { ...SECTIONS[2], slides: "slides 3–9" }];
    ai.queue("groq", page(ghost), page());

    const { tally } = await runJob(lectureId, userId);

    expect(tally.made).toBe(1);
    expect(ai.calls).toHaveLength(2);
    // The repair request names what was wrong.
    expect(userContent(1)).toContain("slides that exist");
    expect(await contentOf(lectureId)).toHaveLength(1);
  }, SLOW);

  it("a malformed range and then broken JSON: the job ends done, nothing written, nothing cached", async () => {
    const { userId, lectureId } = await lecture();
    ai.queue("groq", page([...SECTIONS.slice(0, 2), { ...SECTIONS[2], slides: "pages 2 to 3" }]), { text: BROKEN_JSON });
    ai.setDefault("groq", page());

    const { result, tally } = await runJob(lectureId, userId);

    expect(result).toEqual({ done: 1, retried: 0, failed: 0 });
    expect(tally).toEqual({ ...emptyTally(), badOutput: 1 });
    // One first answer and one repair, never a third try.
    expect(ai.calls).toHaveLength(2);
    expect(await contentOf(lectureId)).toEqual([]);
    expect(await t.db.select().from(aiCache)).toEqual([]);
    expect((await pageJobs()).map((j) => j.status)).toEqual(["done"]);
  }, SLOW);

  it("rejects too few sections and a reversed range the same way", async () => {
    const { userId, lectureId } = await lecture();
    ai.queue("groq", page(SECTIONS.slice(0, 2)), page([...SECTIONS.slice(0, 2), { ...SECTIONS[2], slides: "slides 3–2" }]));

    const { tally } = await runJob(lectureId, userId);

    expect(tally.badOutput).toBe(1);
    expect(ai.calls).toHaveLength(2);
  }, SLOW);

  it("does not send the same file twice: a second lecture with the same deck, and a re-run, ask nothing", async () => {
    const one = await lecture();
    const two = await lecture({ userId: one.userId });
    ai.setDefault("groq", page());

    expect((await runJob(one.lectureId, one.userId)).tally.made).toBe(1);
    expect((await runJob(two.lectureId, two.userId)).tally.made).toBe(1);
    expect(ai.calls).toHaveLength(1);
    expect((await t.db.select().from(aiCache)).map((r) => r.job)).toEqual([LECTURE_PAGE_AI_JOB]);
    expect((await contentOf(two.lectureId))[0].sections).toEqual((await contentOf(one.lectureId))[0].sections);

    // The same lecture again: its stored page is from this exact text.
    expect((await runJob(one.lectureId, one.userId)).tally).toEqual({ ...emptyTally(), kept: 1 });
    expect(ai.calls).toHaveLength(1);

    // The file's text changes: asked again, and the row is written over.
    const [p] = await t.db.select().from(filePages).where(eq(filePages.fileId, one.fileId)).orderBy(asc(filePages.page));
    await t.db.update(filePages).set({ text: `${p.text} Changed.` }).where(eq(filePages.id, p.id));
    expect((await runJob(one.lectureId, one.userId)).tally.made).toBe(1);
    expect(ai.calls).toHaveLength(2);
    expect(await contentOf(one.lectureId)).toHaveLength(1);
  }, SLOW);

  it("throws AiBusy when every provider is limited, so the job stays queued and is tried again later", async () => {
    const { userId, lectureId } = await lecture();
    ai.queue("groq", { status: 429, retryAfter: 30 });

    const { result } = await runJob(lectureId, userId);

    expect(result).toEqual({ done: 0, retried: 1, failed: 0 });
    const [job] = await pageJobs();
    expect(job.status).toBe("queued");
    expect(job.runAfter.getTime()).toBeGreaterThan(NOW.getTime());
    expect(job.lastError).toMatch(/^AiBusy/);
    expect(job.lastError).not.toContain(SECRET_TEXT);
    expect(await contentOf(lectureId)).toEqual([]);
  }, SLOW);

  it("asks nothing and writes nothing when mayUseFiles says no", async () => {
    ai.setDefault("groq", page());
    for (const opts of [{ aiStudy: "unknown" as const }, { aiStudy: "not_allowed" as const }, { useFiles: false }]) {
      const { userId, lectureId } = await lecture(opts);
      const { result, tally } = await runJob(lectureId, userId);
      expect(result).toEqual({ done: 1, retried: 0, failed: 0 });
      expect(tally).toEqual({ ...emptyTally(), skipped: 1 });
      expect(await contentOf(lectureId)).toEqual([]);
    }
    expect(ai.calls).toEqual([]);
  }, SLOW);

  it("asks for the page in the slides' language", async () => {
    const { userId, lectureId } = await lecture({ slides: FINNISH });
    ai.queue("groq", page(SECTIONS.map((s) => ({ ...s, slides: s.slides === "slide 4" ? "slide 3" : s.slides }))));

    expect((await runJob(lectureId, userId)).tally.made).toBe(1);
    expect(systemText(0)).toContain("Write the page in Finnish");
    expect(systemText(0)).not.toContain("in English");
  }, SLOW);

  it("picture-only slides: nothing asked, a thin row written, and a re-run keeps it", async () => {
    const { userId, lectureId } = await lecture({ slides: ["Figure 1", "", "  ", "Thanks!"] });
    ai.setDefault("groq", page());

    expect((await runJob(lectureId, userId)).tally).toEqual({ ...emptyTally(), thin: 1 });
    const [row] = await contentOf(lectureId);
    expect([row.breath, row.minutes, row.sections, row.slideTitles]).toEqual([null, null, [], []]);
    expect((await runJob(lectureId, userId)).tally).toEqual({ ...emptyTally(), kept: 1 });
    expect(ai.calls).toEqual([]);
  }, SLOW);

  it("sends a long deck to the medium model", async () => {
    // 10 slides of over 2,000 characters: 20,000 sent, over MEDIUM_FROM.
    const long = Array.from({ length: 10 }, (_, i) => `${ENGLISH[i % 4]} ${"More slide text about the same topic. ".repeat(60)}`);
    const { userId, lectureId } = await lecture({ slides: long });
    ai.queue("groq", page());

    expect((await runJob(lectureId, userId)).tally.made).toBe(1);
    expect(ai.calls[0].model).toBe(MEDIUM.model);
  }, SLOW);

  it("skips a lecture whose file text is not extracted yet, and an id that is not a lecture", async () => {
    const { userId, lectureId, fileId } = await lecture();
    await t.db.update(courseFiles).set({ textStatus: "queued" }).where(eq(courseFiles.id, fileId));
    expect((await runJob(lectureId, userId)).tally.skipped).toBe(1);
    expect((await runJob("not-a-uuid", userId)).tally.skipped).toBe(1);
    expect(ai.calls).toEqual([]);
  }, SLOW);
});

describe("POST /api/cron/lecture-page", () => {
  it("answers 401 without the cron secret, and with a wrong one", async () => {
    vi.stubEnv("CRON_SECRET", "test-only-cron-secret");
    expect((await POST(new Request("http://localhost/api/cron/lecture-page", { method: "POST" }))).status).toBe(401);
    const wrong = new Request("http://localhost/api/cron/lecture-page", {
      method: "POST",
      headers: { authorization: "Bearer not-the-secret" },
    });
    expect((await POST(wrong)).status).toBe(401);

    vi.stubEnv("CRON_SECRET", "");
    const none = new Request("http://localhost/api/cron/lecture-page", { method: "POST", headers: { authorization: "Bearer " } });
    expect((await POST(none)).status).toBe(401);
  });
});
