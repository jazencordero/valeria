// @vitest-environment node
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { asc, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { seal } from "@/server/crypto/seal";
import type { Db } from "@/server/db/client";
import { courseFiles, courses, filePages } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { jobs } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import {
  BACKOFF_MINUTES,
  MAX_TRIES,
  drain,
  enqueue,
} from "@/server/jobs/queue";
import { ALLOWED_SITES } from "@/server/moodle/connect";
import { DEMO_KEY } from "@/server/moodle/fake-inline";
import {
  CSV_ROWS,
  EXTRACT_KIND,
  MAX_FILE_BYTES,
  csvPage,
  extractFile,
  extractJob,
  pagesFromBytes,
} from "./extract";

// The cron route reads the shared `db`; here that is the test's own database.
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/server/db/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db/client")>();
  const db = new Proxy({} as Db, {
    get(_t, prop) {
      const target = holder.db as Db;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { ...real, db };
});

const route = await import("@/app/api/cron/extract/route");

// Made-up values for tests only.
const FAKE_SEAL_SECRET = "test-only-seal-secret-not-real";
const GOOD_KEY = "made-up-key-0123456789abcdef";
const TEST_CRON_SECRET = "test-only-cron-secret-not-real";
const SLOW = 120_000;
const MINUTE = 60_000;
vi.setConfig({ testTimeout: SLOW, hookTimeout: SLOW });

const SAMPLE_PDF = readFileSync(
  new URL("../../../tests/fixtures/files/lecture-sample.pdf", import.meta.url),
);

// A tiny stand-in for her Moodle site's file server.
let moodle: Server;
let moodleUrl: string;
const seen: string[] = [];
let bigAborted: Promise<void>;
let markBigAborted: () => void;

function serve(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  seen.push(url.pathname);
  if (!url.pathname.startsWith("/webservice/pluginfile.php/")) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (url.searchParams.get("token") !== GOOD_KEY) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Invalid token",
        errorcode: "invalidtoken",
        stacktrace: null,
      }),
    );
    return;
  }
  const name = url.pathname.split("/").pop();
  switch (name) {
    case "lecture.pdf":
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": String(SAMPLE_PDF.length),
      });
      res.end(SAMPLE_PDF);
      return;
    case "corrupt.pdf":
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("%PDF-1.4\nthis is not really a pdf at all\n%%EOF\n");
      return;
    case "notes.txt":
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        "﻿Week 3 notes\r\nMitochondria make ATP.\r\nÄänekoski field trip on Friday.\u0000\n",
      );
      return;
    case "grades.csv": {
      const lines = ["student;week;points"];
      for (let i = 1; i <= 250; i++)
        lines.push(`s${i};${(i % 12) + 1};"${i}, of 10"`);
      res.writeHead(200, { "content-type": "text/csv" });
      res.end(lines.join("\n") + "\n");
      return;
    }
    case "big.pdf": {
      // No content-length: only counting the stream can find out it is too big.
      res.writeHead(200, { "content-type": "application/pdf" });
      res.on("close", () => markBigAborted());
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      let sent = 0;
      const pump = () => {
        while (sent < 30 && !res.destroyed) {
          sent++;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      res.write("%PDF-1.4\n");
      pump();
      return;
    }
    case "down.pdf":
      res.writeHead(503);
      res.end("busy");
      return;
    case "gone.pdf":
      res.writeHead(404);
      res.end();
      return;
  }
  res.writeHead(404);
  res.end();
}

beforeAll(async () => {
  moodle = createServer(serve);
  await new Promise<void>((resolve) => moodle.listen(0, "127.0.0.1", resolve));
  moodleUrl = `http://127.0.0.1:${(moodle.address() as AddressInfo).port}`;
});
afterAll(async () => {
  moodle.closeAllConnections();
  await new Promise<void>((resolve) => moodle.close(() => resolve()));
});

let t: TestDb;
let clock: Date;
const now = () => new Date(clock);

beforeEach(async () => {
  vi.stubEnv("KEY_SEAL_SECRET", FAKE_SEAL_SECRET);
  vi.stubEnv("MOODLE_FAKE", "0");
  t = await createTestDb();
  holder.db = t.db;
  clock = new Date("2026-11-15T10:00:00Z");
  seen.length = 0;
  bigAborted = new Promise((r) => (markBigAborted = r));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
});

/** A user connected to the local stand-in Moodle. */
async function connectedUser(key = GOOD_KEY, siteUrl = moodleUrl) {
  const [user] = await t.db.insert(users).values({}).returning();
  await t.db
    .insert(moodleConnections)
    .values({
      userId: user.id,
      siteUrl,
      moodleUserId: 42,
      tokenSealed: seal(key),
    });
  return user.id;
}

async function fileFor(
  userId: string,
  name: string,
  opts: { mime?: string | null; size?: number; url?: string } = {},
) {
  const [course] = await t.db
    .insert(courses)
    .values({
      userId,
      moodleId: Math.floor(Math.random() * 1e6),
      name: "Demo course",
    })
    .returning();
  const [file] = await t.db
    .insert(courseFiles)
    .values({
      userId,
      courseId: course.id,
      moodleRef: `ref-${Math.random()}`,
      name,
      mime: opts.mime === undefined ? null : opts.mime,
      size: opts.size ?? null,
      url:
        opts.url ??
        `${moodleUrl}/pluginfile.php/1/mod_resource/content/0/${name}`,
      textStatus: "queued",
    })
    .returning();
  return file.id;
}

const pagesOf = (fileId: string) =>
  t.db
    .select()
    .from(filePages)
    .where(eq(filePages.fileId, fileId))
    .orderBy(asc(filePages.page));
async function statusOf(fileId: string) {
  const [row] = await t.db
    .select({ s: courseFiles.textStatus })
    .from(courseFiles)
    .where(eq(courseFiles.id, fileId));
  return row.s;
}
async function jobById(id: string) {
  const [row] = await t.db.select().from(jobs).where(eq(jobs.id, id));
  return row;
}

describe("extractFile", () => {
  it("gives one row per page of a 3-page PDF, with the words of each page", async () => {
    const userId = await connectedUser();
    const id = await fileFor(userId, "lecture.pdf", {
      mime: "application/pdf",
    });

    expect(await extractFile(id, { db: t.db })).toEqual({
      status: "done",
      pages: 3,
    });
    const pages = await pagesOf(id);
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(pages[0].text).toContain("Photosynthesis");
    expect(pages[0].text).toContain("thylakoid");
    expect(pages[1].text).toContain("Chlorophyll absorbs red and blue light");
    expect(pages[2].text).toContain("Rubisco");
    expect(pages[2].text).not.toContain("Photosynthesis");
    expect(await statusOf(id)).toBe("done");
    // The key went only to the file server path, never anywhere else.
    expect(seen).toEqual([
      "/webservice/pluginfile.php/1/mod_resource/content/0/lecture.pdf",
    ]);
  });

  it("replaces the rows on a second run instead of adding to them", async () => {
    const userId = await connectedUser();
    const id = await fileFor(userId, "lecture.pdf", {
      mime: "application/pdf",
    });
    await extractFile(id, { db: t.db });
    await extractFile(id, { db: t.db });
    expect((await pagesOf(id)).map((p) => p.page)).toEqual([1, 2, 3]);
  });

  it("reads a TXT file as one page, without BOM, CRs or NUL", async () => {
    const userId = await connectedUser();
    const id = await fileFor(userId, "notes.txt", { mime: "text/plain" });
    expect(await extractFile(id, { db: t.db })).toEqual({
      status: "done",
      pages: 1,
    });
    const [page] = await pagesOf(id);
    expect(page.page).toBe(1);
    expect(page.text).toBe(
      "Week 3 notes\nMitochondria make ATP.\nÄänekoski field trip on Friday.\n",
    );
  });

  it("reads a CSV as one page: the first 200 rows and a counts line", async () => {
    const userId = await connectedUser();
    // No stored type: the name decides.
    const id = await fileFor(userId, "grades.csv");
    expect(await extractFile(id, { db: t.db })).toEqual({
      status: "done",
      pages: 1,
    });
    const [page] = await pagesOf(id);
    const lines = page.text.split("\n");
    expect(lines).toHaveLength(CSV_ROWS + 1);
    expect(lines[0]).toBe("student;week;points");
    expect(lines[CSV_ROWS - 1]).toBe(
      `s${CSV_ROWS - 1};${((CSV_ROWS - 1) % 12) + 1};"${CSV_ROWS - 1}, of 10"`,
    );
    expect(lines[CSV_ROWS]).toBe(
      "[CSV: 251 rows (header included), 3 columns; only the first 200 rows are shown]",
    );
  });

  it("counts a short CSV with quoted newlines and commas right", () => {
    expect(csvPage('a,b\n1,"x\ny, z"\n\n2,3\n')).toBe(
      'a,b\n1,"x\ny, z"\n2,3\n[CSV: 3 rows (header included), 2 columns]',
    );
  });

  it("ends a corrupt PDF failed, with no rows", async () => {
    const userId = await connectedUser();
    const id = await fileFor(userId, "corrupt.pdf", {
      mime: "application/pdf",
    });
    expect(await extractFile(id, { db: t.db })).toEqual({
      status: "failed",
      reason: "corrupt",
    });
    expect(await pagesOf(id)).toEqual([]);
    expect(await statusOf(id)).toBe("failed");
  });

  it("cuts a download off past 20 MB and fails it too_large", async () => {
    const userId = await connectedUser();
    const id = await fileFor(userId, "big.pdf", { mime: "application/pdf" });
    expect(await extractFile(id, { db: t.db })).toEqual({
      status: "failed",
      reason: "too_large",
    });
    expect(await statusOf(id)).toBe("failed");
    // The server saw the connection go before it had sent all 30 MB.
    await bigAborted;
  });

  it("does not download a file whose stored size is over the cap", async () => {
    const userId = await connectedUser();
    const id = await fileFor(userId, "lecture.pdf", {
      mime: "application/pdf",
      size: MAX_FILE_BYTES + 1,
    });
    expect(await extractFile(id, { db: t.db })).toEqual({
      status: "failed",
      reason: "too_large",
    });
    expect(seen).toEqual([]);
  });

  it("fails types it does not read, without downloading", async () => {
    const userId = await connectedUser();
    const id = await fileFor(userId, "slides.pptx", {
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    expect(await extractFile(id, { db: t.db })).toEqual({
      status: "failed",
      reason: "unsupported_type",
    });
    expect(seen).toEqual([]);
  });

  it("fails a file Moodle no longer has, a rejected key, no key, and a file on another site", async () => {
    const userId = await connectedUser();
    const gone = await fileFor(userId, "gone.pdf", { mime: "application/pdf" });
    expect(await extractFile(gone, { db: t.db })).toEqual({
      status: "failed",
      reason: "file_gone",
    });

    const elsewhere = await fileFor(userId, "lecture.pdf", {
      mime: "application/pdf",
      url: "https://example.org/x.pdf",
    });
    expect(await extractFile(elsewhere, { db: t.db })).toEqual({
      status: "failed",
      reason: "not_on_her_site",
    });

    const wrongKey = await connectedUser("made-up-wrong-key");
    const rejected = await fileFor(wrongKey, "lecture.pdf", {
      mime: "application/pdf",
    });
    expect(await extractFile(rejected, { db: t.db })).toEqual({
      status: "failed",
      reason: "key_rejected",
    });

    const [loner] = await t.db.insert(users).values({}).returning();
    const unconnected = await fileFor(loner.id, "lecture.pdf", {
      mime: "application/pdf",
    });
    expect(await extractFile(unconnected, { db: t.db })).toEqual({
      status: "failed",
      reason: "not_connected",
    });
  });

  it("throws MoodleDown when Moodle is down, so the queue tries again", async () => {
    const userId = await connectedUser();
    const id = await fileFor(userId, "down.pdf", { mime: "application/pdf" });
    await expect(extractFile(id, { db: t.db })).rejects.toMatchObject({
      name: "MoodleDown",
    });
    expect(await statusOf(id)).toBe("queued");
  });

  it("says missing for a file row that no longer exists", async () => {
    expect(
      await extractFile("00000000-0000-4000-8000-000000000000", { db: t.db }),
    ).toEqual({ status: "missing" });
  });

  it("reads the fake Moodle's demo PDF with MOODLE_FAKE=1, making no request", async () => {
    vi.stubEnv("MOODLE_FAKE", "1");
    const userId = await connectedUser(DEMO_KEY, ALLOWED_SITES[0]);
    const id = await fileFor(userId, "Lecture 1.pdf", {
      mime: "application/pdf",
      url: `${ALLOWED_SITES[0]}/pluginfile.php/1/x.pdf`,
    });
    expect(await extractFile(id, { db: t.db })).toEqual({
      status: "done",
      pages: 1,
    });
    expect((await pagesOf(id))[0].text).toContain("Demo course file");
    expect(seen).toEqual([]);
  });
});

describe("extract jobs", () => {
  const drainOnce = () =>
    drain(EXTRACT_KIND, extractJob({ db: t.db }), { db: t.db, now });

  it("a corrupt file ends failed and its job is done, not retried", async () => {
    const userId = await connectedUser();
    const id = await fileFor(userId, "corrupt.pdf", {
      mime: "application/pdf",
    });
    const job = await enqueue(
      EXTRACT_KIND,
      { fileId: id },
      { userId, db: t.db, now },
    );

    expect(await drainOnce()).toEqual({ done: 1, retried: 0, failed: 0 });
    const row = await jobById(job.id);
    expect(row.status).toBe("done");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe("file failed: corrupt");
    expect(await statusOf(id)).toBe("failed");

    // Nothing left to run, even much later.
    clock = new Date(clock.getTime() + 24 * 60 * MINUTE);
    expect(await drainOnce()).toEqual({ done: 0, retried: 0, failed: 0 });
    expect((await jobById(job.id)).attempts).toBe(1);
  });

  it("retries Moodle down with backoff, and after the last try the job and the file end failed", async () => {
    const userId = await connectedUser();
    const id = await fileFor(userId, "down.pdf", { mime: "application/pdf" });
    const job = await enqueue(
      EXTRACT_KIND,
      { fileId: id },
      { userId, db: t.db, now },
    );

    for (let attempt = 1; attempt < MAX_TRIES; attempt++) {
      expect(await drainOnce()).toEqual({ done: 0, retried: 1, failed: 0 });
      expect(await statusOf(id)).toBe("queued");
      clock = new Date(clock.getTime() + BACKOFF_MINUTES[attempt - 1] * MINUTE);
    }
    expect(await drainOnce()).toEqual({ done: 0, retried: 0, failed: 1 });
    const row = await jobById(job.id);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(MAX_TRIES);
    expect(row.lastError).toMatch(/^MoodleDown/);
    expect(await statusOf(id)).toBe("failed");
  });

  it("extracts a queued PDF and ignores a job whose payload is not a file id", async () => {
    const userId = await connectedUser();
    const id = await fileFor(userId, "lecture.pdf", {
      mime: "application/pdf",
    });
    await enqueue(EXTRACT_KIND, { fileId: id }, { userId, db: t.db, now });
    const bad = await enqueue(
      EXTRACT_KIND,
      { fileId: "nope" },
      { db: t.db, now },
    );
    expect(await drainOnce()).toEqual({ done: 2, retried: 0, failed: 0 });
    expect(await pagesOf(id)).toHaveLength(3);
    expect((await jobById(bad.id)).lastError).toBe(
      "bad payload: fileId must be a uuid",
    );
  });

  it("does not extract a file for a job of another user", async () => {
    const owner = await connectedUser();
    const other = await connectedUser();
    const id = await fileFor(owner, "lecture.pdf", { mime: "application/pdf" });
    await enqueue(
      EXTRACT_KIND,
      { fileId: id },
      { userId: other, db: t.db, now },
    );
    expect(await drainOnce()).toEqual({ done: 1, retried: 0, failed: 0 });
    expect(await pagesOf(id)).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("/api/cron/extract", () => {
  const call = (authorization?: string) =>
    route.POST(
      new Request("http://localhost/api/cron/extract", {
        method: "POST",
        headers: authorization ? { authorization } : {},
      }),
    );

  it("answers 401 when CRON_SECRET is not set, even to a bearer header", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call()).status).toBe(401);
    expect((await call("Bearer ")).status).toBe(401);
    expect((await call("Bearer anything")).status).toBe(401);
  });

  it("answers 401 to a wrong secret, and drains extract jobs with the right one", async () => {
    vi.stubEnv("CRON_SECRET", TEST_CRON_SECRET);
    expect((await call("Bearer wrong")).status).toBe(401);

    const userId = await connectedUser();
    const good = await fileFor(userId, "lecture.pdf", {
      mime: "application/pdf",
    });
    const corrupt = await fileFor(userId, "corrupt.pdf", {
      mime: "application/pdf",
    });
    await enqueue(EXTRACT_KIND, { fileId: good }, { userId, db: t.db });
    await enqueue(EXTRACT_KIND, { fileId: corrupt }, { userId, db: t.db });

    const res = await call(`Bearer ${TEST_CRON_SECRET}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      kind: "extract",
      done: 2,
      retried: 0,
      failed: 0,
      files: { extracted: 1, failed: 1, missing: 0 },
    });
    expect(JSON.stringify(body)).not.toContain(TEST_CRON_SECRET);
    expect(route.maxDuration).toBeGreaterThan(40);
  });
});

describe("pagesFromBytes (no database, no network)", () => {
  it("reads the sample PDF page by page, and TXT, MD and CSV as one page", async () => {
    const pdf = await pagesFromBytes(new Uint8Array(SAMPLE_PDF), "application/pdf");
    expect(pdf.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(pdf[1].text).toContain("Chlorophyll");
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(await pagesFromBytes(enc("# Title\nBody"), "text/markdown")).toEqual([{ page: 1, text: "# Title\nBody" }]);
    expect(await pagesFromBytes(enc("hello"), "notes.txt")).toEqual([{ page: 1, text: "hello" }]);
    expect(await pagesFromBytes(enc("a,b\n1,2\n"), "text/csv; charset=utf-8")).toEqual([
      { page: 1, text: "a,b\n1,2\n[CSV: 2 rows (header included), 2 columns]" },
    ]);
  });

  it("throws UnreadableFile for a broken PDF and a type it does not read", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    await expect(pagesFromBytes(enc("%PDF-1.4 junk"), "application/pdf")).rejects.toMatchObject({
      name: "UnreadableFile",
      reason: "corrupt",
    });
    await expect(pagesFromBytes(enc("x"), "image/png")).rejects.toMatchObject({ reason: "unsupported_type" });
  });

  it("keeps the database, her connection and the queue out of extract.ts's static imports", () => {
    const source = readFileSync(new URL("./extract.ts", import.meta.url), "utf8");
    const staticValueImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    for (const banned of ["@/server/db/client", "@/server/moodle/connect", "@/server/jobs/queue"]) {
      expect(staticValueImports).not.toContain(banned);
    }
  });
});
