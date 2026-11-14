// @vitest-environment node
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sample from "../../../tests/fixtures/moodle-sample/core_course_get_contents.json";
import { ensureSessionFor, newToken } from "@/server/auth/session";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { jobs } from "@/server/db/schema/system";
import { enqueue } from "@/server/jobs/queue";
import { MoodleDown, resetMoodleClient } from "@/server/moodle/client";
import { ALLOWED_SITES, connectWithKey, disconnect } from "@/server/moodle/connect";
import { DEMO_KEY } from "@/server/moodle/fake-inline";
import type { CourseFile, CourseSection } from "@/server/moodle/read/contents";
import { syncAssignments } from "./assignments";
import { NotConnected, syncCourses } from "./courses";
import {
  EXTRACT_KIND,
  MAX_EXTRACT_BYTES,
  SYNC_FILES_KIND,
  isExtractable,
  sectionFileRef,
  syncFiles,
  type SyncFilesDeps,
} from "./files";

// The cron route reads the shared `db`; here that is the test's own database.
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/server/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/db/client")>()),
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        const real = holder.db as object;
        const value: unknown = Reflect.get(real, prop, real);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
      },
    },
  ),
}));

// Made-up values for tests only. The fake Moodle accepts DEMO_KEY and nothing else.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const TEST_CRON_SECRET = "test-only-cron-secret-not-real";
const AALTO = ALLOWED_SITES[0];
// The machine can be busy; a fresh database per test takes a while.
const SLOW = 120_000;
/** The Moodle id of the course the test files sit in (Forecasting Methods in the fake). */
const FORECASTING = 3101;
const PLUGINFILE = "https://moodle.example.edu/webservice/pluginfile.php";

let t: TestDb;
beforeEach(async () => {
  vi.stubEnv("MOODLE_FAKE", "1");
  vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
  t = await createTestDb();
  holder.db = t.db;
}, SLOW);
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetMoodleClient();
  await t.close();
});

/** A user with the fake Moodle connected and her four courses synced. */
async function connectedUser(): Promise<string> {
  const { user } = await ensureSessionFor(t.db, newToken());
  const result = await connectWithKey(user.id, AALTO, DEMO_KEY, t.db);
  if (!result.ok) throw new Error("the fake Moodle rejected the demo key");
  await syncCourses(result.userId, t.db);
  return result.userId;
}

function file(name: string, change: Partial<CourseFile> = {}): CourseFile {
  return {
    name,
    url: `${PLUGINFILE}/62101/mod_resource/content/1/${name}?forcedownload=1`,
    mime: name.endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
    size: 1_000_000,
    modifiedAt: new Date("2026-09-02T08:00:00Z"),
    ...change,
  };
}

/** Two weeks of a course page: a lecture PDF each, and the first week's slides as PowerPoint. */
function twoLectures(): CourseSection[] {
  return [
    {
      section: "General",
      position: 0,
      modules: [{ moodleRef: "cm:7001", name: "Announcements", kind: "other", files: [] }],
    },
    {
      section: "Week 1: Introduction",
      position: 1,
      modules: [
        { moodleRef: "cm:7101", name: "Lecture 1", kind: "resource", files: [file("lecture-01.pdf")] },
        { moodleRef: "cm:7102", name: "Lecture 1 slides", kind: "resource", files: [file("lecture-01.pptx")] },
      ],
    },
    {
      section: "Week 2: Smoothing",
      position: 2,
      modules: [{ moodleRef: "cm:7201", name: "Lecture 2", kind: "resource", files: [file("lecture-02.pdf")] }],
    },
  ];
}

/**
 * A Moodle whose course pages the test writes: `pages` maps a course's Moodle
 * id to its sections; every other course has an empty page. `asked` records
 * which courses were asked for.
 */
function moodleWith(pages: Record<number, CourseSection[]>) {
  const asked: number[] = [];
  const deps: SyncFilesDeps = {
    getCourseContents: async (_conn, courseMoodleId) => {
      asked.push(courseMoodleId);
      return structuredClone(pages[courseMoodleId] ?? []);
    },
  };
  return { deps, asked, pages };
}

async function filesOf(userId: string) {
  return t.db.select().from(courseFiles).where(eq(courseFiles.userId, userId)).orderBy(asc(courseFiles.moodleRef));
}

async function statusByRef(userId: string) {
  return Object.fromEntries((await filesOf(userId)).map((f) => [f.moodleRef, f.textStatus]));
}

async function jobsOf(kind: string) {
  return t.db.select().from(jobs).where(eq(jobs.kind, kind)).orderBy(asc(jobs.createdAt));
}

/** What the extract job would do when it finishes: the job is done and so is the file's text. */
async function finishExtraction() {
  await t.db.update(jobs).set({ status: "done" }).where(eq(jobs.kind, EXTRACT_KIND));
  await t.db.update(courseFiles).set({ textStatus: "done" }).where(eq(courseFiles.textStatus, "queued"));
}

describe("isExtractable", () => {
  it("takes PDF, TXT, MD and CSV under 20 MB, by the file's name", () => {
    for (const name of ["a.pdf", "a.txt", "a.md", "a.csv", "LECTURE.PDF", "extra/notes.Md", "v1.2-final.pdf"]) {
      expect(isExtractable({ name, size: 5_000 }), name).toBe(true);
    }
    for (const name of ["a.pptx", "a.xlsx", "a.docx", "a.png", "pdf", "notes", "a.pdf.zip", "week.1/readme"]) {
      expect(isExtractable({ name, size: 5_000 }), name).toBe(false);
    }
    expect(isExtractable({ name: "a.pdf", size: MAX_EXTRACT_BYTES - 1 })).toBe(true);
    expect(isExtractable({ name: "a.pdf", size: MAX_EXTRACT_BYTES })).toBe(false);
    expect(isExtractable({ name: "a.pdf", size: null })).toBe(false);
  });
});

describe("syncFiles", () => {
  it("queues two lecture PDFs for extraction once, and not again on a second sync", async () => {
    const userId = await connectedUser();
    const { deps, asked } = moodleWith({ [FORECASTING]: twoLectures() });

    expect(await syncFiles(userId, t.db, deps)).toEqual({ added: 3, updated: 0, queued: 2 });
    expect([...asked].sort()).toEqual([3101, 3102, 3103, 3104]);

    const files = await filesOf(userId);
    expect(files.map((f) => [f.moodleRef, f.textStatus])).toEqual([
      ["cm:7101:lecture-01.pdf", "queued"],
      ["cm:7102:lecture-01.pptx", "none"],
      ["cm:7201:lecture-02.pdf", "queued"],
    ]);
    const [course] = await t.db.select().from(courses).where(eq(courses.moodleId, FORECASTING));
    expect(files.every((f) => f.courseId === course.id && f.assignmentId === null)).toBe(true);
    expect(files.map((f) => f.section)).toEqual(["Week 1: Introduction", "Week 1: Introduction", "Week 2: Smoothing"]);
    expect(files[0]).toMatchObject({
      name: "lecture-01.pdf",
      mime: "application/pdf",
      size: 1_000_000,
      url: `${PLUGINFILE}/62101/mod_resource/content/1/lecture-01.pdf?forcedownload=1`,
      modifiedAt: new Date("2026-09-02T08:00:00Z"),
    });

    const pdfIds = [files[0].id, files[2].id];
    const queuedJobs = await jobsOf(EXTRACT_KIND);
    expect(queuedJobs).toHaveLength(2);
    expect(queuedJobs.every((j) => j.status === "queued" && j.userId === userId)).toBe(true);
    // The payload is the file id; the queue keeps the dedupeKey (the same id) beside it.
    const payloads = queuedJobs.map((j) => j.payload as { fileId: string; _dedupeKey: string });
    expect(payloads.sort((a, b) => a.fileId.localeCompare(b.fileId))).toEqual(
      [...pdfIds].sort((a, b) => a.localeCompare(b)).map((fileId) => ({ fileId, _dedupeKey: fileId })),
    );

    // A second sync, while the two jobs still wait: nothing new.
    expect(await syncFiles(userId, t.db, deps)).toEqual({ added: 0, updated: 0, queued: 0 });
    expect(await jobsOf(EXTRACT_KIND)).toEqual(queuedJobs);
    expect(await filesOf(userId)).toEqual(files);

    // And a third, after the text was pulled: still nothing, and the text is kept.
    await finishExtraction();
    expect(await syncFiles(userId, t.db, deps)).toEqual({ added: 0, updated: 0, queued: 0 });
    expect(await jobsOf(EXTRACT_KIND)).toHaveLength(2);
    expect(await statusByRef(userId)).toEqual({
      "cm:7101:lecture-01.pdf": "done",
      "cm:7102:lecture-01.pptx": "none",
      "cm:7201:lecture-02.pdf": "done",
    });
  }, SLOW);

  it("queues only PDF, TXT, MD and CSV under 20 MB; the rest is listed with 'none'", async () => {
    const userId = await connectedUser();
    const { deps } = moodleWith({
      [FORECASTING]: [
        {
          section: "Material",
          position: 1,
          modules: [
            {
              moodleRef: "cm:7203",
              name: "Everything",
              kind: "folder",
              files: [
                file("notes.txt"),
                file("readme.md"),
                file("weekly-sales.csv"),
                file("SCAN.PDF"),
                file("slides.pptx"),
                file("templates/smoothing.xlsx"),
                file("figure.png"),
                file("textbook.pdf", { size: MAX_EXTRACT_BYTES }),
                file("almost.pdf", { size: MAX_EXTRACT_BYTES - 1 }),
              ],
            },
          ],
        },
      ],
    });

    expect(await syncFiles(userId, t.db, deps)).toEqual({ added: 9, updated: 0, queued: 5 });
    expect(await statusByRef(userId)).toEqual({
      "cm:7203:SCAN.PDF": "queued",
      "cm:7203:almost.pdf": "queued",
      "cm:7203:figure.png": "none",
      "cm:7203:notes.txt": "queued",
      "cm:7203:readme.md": "queued",
      "cm:7203:slides.pptx": "none",
      "cm:7203:templates/smoothing.xlsx": "none",
      "cm:7203:textbook.pdf": "none",
      "cm:7203:weekly-sales.csv": "queued",
    });
    expect(await jobsOf(EXTRACT_KIND)).toHaveLength(5);
  }, SLOW);

  it("queues a changed file again: a new size, a new modified time or a new URL", async () => {
    const userId = await connectedUser();
    const moodle = moodleWith({ [FORECASTING]: twoLectures() });
    await syncFiles(userId, t.db, moodle.deps);
    await finishExtraction();
    const before = await filesOf(userId);
    const lecture = (week: 1 | 2) => moodle.pages[FORECASTING][week].modules[0].files[0];

    // Week 1's PDF was replaced by a bigger one.
    lecture(1).size = 1_200_000;
    expect(await syncFiles(userId, t.db, moodle.deps)).toEqual({ added: 0, updated: 1, queued: 1 });
    expect(await statusByRef(userId)).toMatchObject({
      "cm:7101:lecture-01.pdf": "queued",
      "cm:7201:lecture-02.pdf": "done",
    });
    let extractJobs = await jobsOf(EXTRACT_KIND);
    expect(extractJobs).toHaveLength(3);
    expect(extractJobs[2]).toMatchObject({ status: "queued", payload: { fileId: before[0].id } });
    expect((await filesOf(userId))[0]).toMatchObject({ id: before[0].id, size: 1_200_000 });

    // Changed once more before the job ran: still one waiting job for that file.
    lecture(1).size = 1_300_000;
    expect(await syncFiles(userId, t.db, moodle.deps)).toEqual({ added: 0, updated: 1, queued: 0 });
    expect(await jobsOf(EXTRACT_KIND)).toHaveLength(3);
    await finishExtraction();

    // Same size, later modified time.
    lecture(2).modifiedAt = new Date("2026-09-20T08:00:00Z");
    expect(await syncFiles(userId, t.db, moodle.deps)).toEqual({ added: 0, updated: 1, queued: 1 });
    expect(await statusByRef(userId)).toMatchObject({
      "cm:7101:lecture-01.pdf": "done",
      "cm:7201:lecture-02.pdf": "queued",
    });
    await finishExtraction();

    // Same size and time, but Moodle's URL carries a new revision.
    lecture(2).url = lecture(2).url.replace("/content/1/", "/content/2/");
    expect(await syncFiles(userId, t.db, moodle.deps)).toEqual({ added: 0, updated: 1, queued: 1 });
    extractJobs = await jobsOf(EXTRACT_KIND);
    expect(extractJobs).toHaveLength(5);
    await finishExtraction();

    // Nothing changed: nothing queued.
    expect(await syncFiles(userId, t.db, moodle.deps)).toEqual({ added: 0, updated: 0, queued: 0 });
    expect(await jobsOf(EXTRACT_KIND)).toHaveLength(5);
  }, SLOW);

  it("saves a renamed section without pulling the text again, and takes a file's text away when it grows past 20 MB", async () => {
    const userId = await connectedUser();
    const moodle = moodleWith({ [FORECASTING]: twoLectures() });
    await syncFiles(userId, t.db, moodle.deps);
    await finishExtraction();

    moodle.pages[FORECASTING][2].section = "Week 2: Exponential smoothing";
    expect(await syncFiles(userId, t.db, moodle.deps)).toEqual({ added: 0, updated: 1, queued: 0 });
    const renamed = (await filesOf(userId))[2];
    expect(renamed).toMatchObject({ section: "Week 2: Exponential smoothing", textStatus: "done" });

    moodle.pages[FORECASTING][1].modules[0].files[0].size = MAX_EXTRACT_BYTES + 5;
    expect(await syncFiles(userId, t.db, moodle.deps)).toEqual({ added: 0, updated: 1, queued: 0 });
    expect(await statusByRef(userId)).toMatchObject({ "cm:7101:lecture-01.pdf": "none" });
    expect(await jobsOf(EXTRACT_KIND)).toHaveLength(2);
  }, SLOW);

  it("does not try a failed file again until it changes", async () => {
    const userId = await connectedUser();
    const moodle = moodleWith({ [FORECASTING]: twoLectures() });
    await syncFiles(userId, t.db, moodle.deps);
    await t.db.update(jobs).set({ status: "failed" }).where(eq(jobs.kind, EXTRACT_KIND));
    await t.db.update(courseFiles).set({ textStatus: "failed" }).where(eq(courseFiles.textStatus, "queued"));

    expect(await syncFiles(userId, t.db, moodle.deps)).toEqual({ added: 0, updated: 0, queued: 0 });

    moodle.pages[FORECASTING][1].modules[0].files[0].size = 999;
    expect(await syncFiles(userId, t.db, moodle.deps)).toEqual({ added: 0, updated: 1, queued: 1 });
    expect(await statusByRef(userId)).toMatchObject({
      "cm:7101:lecture-01.pdf": "queued",
      "cm:7201:lecture-02.pdf": "failed",
    });
  }, SLOW);

  it("asks only for her visible courses", async () => {
    const userId = await connectedUser();
    await t.db.update(courses).set({ hidden: true }).where(eq(courses.moodleId, FORECASTING));
    const { deps, asked } = moodleWith({ [FORECASTING]: twoLectures() });

    expect(await syncFiles(userId, t.db, deps)).toEqual({ added: 0, updated: 0, queued: 0 });
    expect([...asked].sort()).toEqual([3102, 3103, 3104]);
    expect(await filesOf(userId)).toEqual([]);
    expect(await jobsOf(EXTRACT_KIND)).toEqual([]);
  }, SLOW);

  it("keeps a file Moodle no longer lists, and lists the same file once when Moodle repeats it", async () => {
    const userId = await connectedUser();
    const moodle = moodleWith({ [FORECASTING]: twoLectures() });
    // The same module shows up on a second course's page too (the fake does this).
    moodle.pages[3102] = twoLectures();
    expect(await syncFiles(userId, t.db, moodle.deps)).toEqual({ added: 3, updated: 0, queued: 2 });

    moodle.pages[FORECASTING] = [];
    moodle.pages[3102] = [];
    expect(await syncFiles(userId, t.db, moodle.deps)).toEqual({ added: 0, updated: 0, queued: 0 });
    expect(await filesOf(userId)).toHaveLength(3);
  }, SLOW);

  it("queues the PDFs attached to assignment briefs once, and their refs never meet the course-page ones", async () => {
    const userId = await connectedUser();
    await syncAssignments(userId, t.db);
    const { deps } = moodleWith({ [FORECASTING]: twoLectures() });

    // Two lecture PDFs and the four brief PDFs the fake's assignments carry.
    expect(await syncFiles(userId, t.db, deps)).toEqual({ added: 3, updated: 0, queued: 6 });
    const files = await filesOf(userId);
    expect(files.map((f) => [f.moodleRef, f.textStatus, f.assignmentId !== null])).toEqual([
      ["assign:7101:intro:assignment-3-brief.pdf", "queued", true],
      ["assign:7101:intro:sales-series.pdf", "queued", true],
      ["assign:7301:intro:case-memo-2.pdf", "queued", true],
      ["assign:7401:intro:service-blueprint-brief.pdf", "queued", true],
      // Course module 7101 and assignment 7101 are different things with the same number.
      ["cm:7101:lecture-01.pdf", "queued", false],
      ["cm:7102:lecture-01.pptx", "none", false],
      ["cm:7201:lecture-02.pdf", "queued", false],
    ]);
    expect(sectionFileRef("cm:7101", "lecture-01.pdf")).toBe("cm:7101:lecture-01.pdf");
    expect(await jobsOf(EXTRACT_KIND)).toHaveLength(6);

    // Both syncs again: the attachment rows keep their status and nothing is queued twice.
    await syncAssignments(userId, t.db);
    expect(await syncFiles(userId, t.db, deps)).toEqual({ added: 0, updated: 0, queued: 0 });
    await finishExtraction();
    await syncAssignments(userId, t.db);
    expect(await syncFiles(userId, t.db, deps)).toEqual({ added: 0, updated: 0, queued: 0 });
    expect(await jobsOf(EXTRACT_KIND)).toHaveLength(6);
    expect((await filesOf(userId)).filter((f) => f.textStatus === "done")).toHaveLength(6);
  }, SLOW);

  it("writes nothing when one course cannot be read", async () => {
    const userId = await connectedUser();
    const { deps } = moodleWith({ [FORECASTING]: twoLectures() });
    const down: SyncFilesDeps = {
      getCourseContents: async (conn, courseMoodleId) => {
        if (courseMoodleId === 3104) throw new MoodleDown("HTTP 503");
        return deps.getCourseContents(conn, courseMoodleId);
      },
    };

    await expect(syncFiles(userId, t.db, down)).rejects.toBeInstanceOf(MoodleDown);
    expect(await filesOf(userId)).toEqual([]);
    expect(await jobsOf(EXTRACT_KIND)).toEqual([]);
  }, SLOW);

  it("throws NotConnected for a user with no Moodle connection", async () => {
    const { user } = await ensureSessionFor(t.db, newToken());
    const { deps, asked } = moodleWith({});
    await expect(syncFiles(user.id, t.db, deps)).rejects.toBeInstanceOf(NotConnected);
    expect(asked).toEqual([]);
  }, SLOW);
});

describe("POST /api/cron/sync-files", () => {
  const URL_ = "https://ready.test/api/cron/sync-files";
  const call = async (headers: Record<string, string> = {}) => {
    const route = await import("@/app/api/cron/sync-files/route");
    return route.POST(new Request(URL_, { method: "POST", headers }));
  };
  const bearer = { authorization: `Bearer ${TEST_CRON_SECRET}` };

  /** From here on Moodle is asked over (stubbed) HTTP and answers every course page with the sample. */
  function moodleOverHttp() {
    vi.stubEnv("MOODLE_FAKE", "0");
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void url;
      void init;
      return new Response(JSON.stringify(sample), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("answers 401 without the secret and runs no job", async () => {
    const userId = await connectedUser();
    await enqueue(SYNC_FILES_KIND, {}, { userId, dedupeKey: userId, db: t.db });
    const fetchMock = moodleOverHttp();

    // No CRON_SECRET in the environment: closed to everyone, the right-looking header too.
    expect((await call()).status).toBe(401);
    expect((await call(bearer)).status).toBe(401);

    vi.stubEnv("CRON_SECRET", TEST_CRON_SECRET);
    const attempts: Record<string, string>[] = [
      {},
      { authorization: "" },
      { authorization: "Bearer" },
      { authorization: "Bearer wrong" },
      { authorization: `Bearer ${TEST_CRON_SECRET}x` },
      { authorization: `bearer ${TEST_CRON_SECRET}` },
      { authorization: TEST_CRON_SECRET },
    ];
    for (const headers of attempts) {
      const res = await call(headers);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(TEST_CRON_SECRET);
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await jobsOf(SYNC_FILES_KIND)).map((j) => j.status)).toEqual(["queued"]);
    expect(await filesOf(userId)).toEqual([]);
  }, SLOW);

  it("with the secret, runs her sync-files job: the sample's two lecture PDFs are queued once", async () => {
    const userId = await connectedUser();
    vi.stubEnv("CRON_SECRET", TEST_CRON_SECRET);
    await enqueue(SYNC_FILES_KIND, {}, { userId, dedupeKey: userId, db: t.db });
    const fetchMock = moodleOverHttp();

    const res = await call(bearer);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(TEST_CRON_SECRET);
    expect(body).not.toContain(DEMO_KEY);
    // The sample page: two lecture PDFs, a CSV and an exercise PDF are readable; a spreadsheet is not.
    expect(JSON.parse(body)).toEqual({
      ok: true,
      done: 1,
      retried: 0,
      failed: 0,
      skipped: 0,
      files: { added: 5, updated: 0, queued: 4 },
    });
    // One call per visible course.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(await statusByRef(userId)).toEqual({
      "cm:7101:lecture-01-why-forecast.pdf": "queued",
      "cm:7201:lecture-02-exponential-smoothing.pdf": "queued",
      "cm:7202:weekly-sales.csv": "queued",
      "cm:7203:exercises-1.pdf": "queued",
      "cm:7203:templates/smoothing-template.xlsx": "none",
    });
    expect((await jobsOf(SYNC_FILES_KIND)).map((j) => j.status)).toEqual(["done"]);
    expect(await jobsOf(EXTRACT_KIND)).toHaveLength(4);

    // The next sync adds a new job; draining it queues nothing a second time.
    await enqueue(SYNC_FILES_KIND, {}, { userId, dedupeKey: userId, db: t.db });
    expect(await (await call(bearer)).json()).toMatchObject({ done: 1, files: { added: 0, updated: 0, queued: 0 } });
    expect(await jobsOf(EXTRACT_KIND)).toHaveLength(4);
  }, SLOW);

  it("ends a job quietly when she has disconnected, and tries again later when Moodle is down", async () => {
    const userId = await connectedUser();
    vi.stubEnv("CRON_SECRET", TEST_CRON_SECRET);
    await enqueue(SYNC_FILES_KIND, {}, { userId, dedupeKey: userId, db: t.db });
    vi.stubEnv("MOODLE_FAKE", "0");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down for maintenance", { status: 404 })));

    const down = await (await call(bearer)).json();
    expect(down).toMatchObject({ ok: true, done: 0, retried: 1, failed: 0, skipped: 0 });
    const [job] = await jobsOf(SYNC_FILES_KIND);
    expect(job.status).toBe("queued");
    expect(job.runAfter.getTime()).toBeGreaterThan(Date.now());

    await disconnect(userId, t.db);
    await t.db.update(jobs).set({ runAfter: new Date(0) }).where(eq(jobs.id, job.id));
    expect(await (await call(bearer)).json()).toMatchObject({ ok: true, done: 1, retried: 0, skipped: 1 });
    expect((await jobsOf(SYNC_FILES_KIND)).map((j) => j.status)).toEqual(["done"]);
  }, SLOW);
});
