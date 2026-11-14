/*
 * M2-09: pull the text out of her course files.
 *
 *   await extractFile(fileId)                       // one file, now
 *   await drain(EXTRACT_KIND, extractJob, { ... })   // the `extract` job queue (src/app/api/cron/extract)
 *
 * `extractFile` downloads one `course_files` row from Moodle with her key, streamed and capped at
 * 20 MB, and writes its text to `file_pages`:
 * - PDF: one row per page, read with `unpdf` (pages with only pictures give an empty row).
 * - TXT and MD: the whole file as page 1.
 * - CSV: page 1 holds the first 200 rows and then one line with the row and column counts.
 * Earlier rows of the file are replaced, never added to, and `text_status` ends `done`.
 *
 * Problems that another try cannot fix (too large, not a type we read, a broken PDF, the file gone
 * from Moodle, no key or a rejected key) end the file `failed` and are *returned*, not thrown, so
 * the job counts as done and is not retried. The reason is a short code (`FailReason`);
 * `course_files` has no column for it, so `extractJob` writes it to the job's `last_error` as
 * `file failed: <reason>`. Moodle being down or slow is thrown (`MoodleDown`) so the queue tries
 * again with its backoff; on the last try (`MAX_TRIES`) `extractJob` first marks the file `failed`
 * with `moodle_down`, so a file never stays `queued` after its job has given up.
 * (One gap: a run that is killed mid-way on its 5th try is ended by the queue itself, which
 * cannot know about files, so that file keeps its old status until it is queued again.)
 *
 * Privacy. The bytes live only in memory for the length of one call and are never stored. Her key
 * only goes into the URL fetched (`fileUrl`), only for her own Moodle site, never through a
 * redirect. Nothing here logs: not the key, not the URL, not the text. The text is extracted here,
 * locally; nothing in this file sends it anywhere (no AI).
 *
 * With MOODLE_FAKE=1 no request is made: the fake's demo key gets a small made-up file, like
 * /api/files/[id] (M1-29), whose fetch this file mirrors (reimplemented: a route file is no library).
 */
import { and, eq } from "drizzle-orm";
import { extractText, getDocumentProxy } from "unpdf";
// Importing this module has no side effects and needs no environment: the database handle,
// her connection and the queue are imported only when `extractFile` or a job runs, so a local
// script can use `pagesFromBytes` alone. (Schema tables and the Moodle client are plain
// definitions with no imports that open anything.)
import type { Db } from "@/server/db/client";
import { courseFiles, filePages } from "@/server/db/schema/courses";
import { jobs } from "@/server/db/schema/system";
import type { JobInfo } from "@/server/jobs/queue";
import {
  MOODLE_TIMEOUT_MS,
  MoodleDown,
  USER_AGENT,
  fileUrl,
  type MoodleConn,
} from "@/server/moodle/client";

export const EXTRACT_KIND = "extract";
/** Largest file we download. Past this the download is cut off and the file fails `too_large`. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** How many CSV rows go into the page before the counts line. */
export const CSV_ROWS = 200;
/** The whole download (after the first answer) must finish in this time, or it counts as Moodle down. */
export const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Why a file ended `failed`. None of these get better by trying again soon. */
export type FailReason =
  | "too_large"
  | "unsupported_type"
  | "corrupt"
  | "password_protected"
  | "file_gone"
  | "not_on_her_site"
  | "not_connected"
  | "key_rejected"
  | "moodle_down";

export type ExtractResult =
  | { status: "done"; pages: number }
  | { status: "failed"; reason: FailReason }
  /** No `course_files` row with this id (deleted since the job was queued). Nothing to do. */
  | { status: "missing" };

export type ExtractOptions = {
  db?: Db;
  /** Stand-in for `fetch` in tests. */
  fetch?: typeof fetch;
  /** Stand-in for reading her Moodle connection. */
  connection?: (userId: string, db: Db) => Promise<MoodleConn | null>;
  /** Only extract the file when it belongs to this user (a job's `userId`). */
  userId?: string | null;
};

type Kind = "pdf" | "text" | "csv";

/** A problem another try will not fix: the file ends `failed` with this reason. */
class Permanent extends Error {
  constructor(readonly reason: FailReason) {
    super(reason);
    this.name = "Permanent";
  }
}

const KEY_ERRORS = new Set([
  "invalidtoken",
  "accessexception",
  "usernotfullysetup",
  "forcepasswordchangenotice",
]);
/** Error answers from Moodle's file server are small JSON; anything bigger is a real file. */
const MAX_ERROR_JSON_BYTES = 64 * 1024;
const PAGES_PER_INSERT = 100;

// ---------------------------------------------------------------------------
// What kind of file is it

const PDF_TYPES = new Set(["application/pdf", "application/x-pdf"]);
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/x-markdown"]);
const CSV_TYPES = new Set([
  "text/csv",
  "application/csv",
  "text/comma-separated-values",
]);

function baseType(type: string | null | undefined): string {
  return (type ?? "").split(";")[0].trim().toLowerCase();
}

function kindOfType(type: string | null | undefined): Kind | null {
  const t = baseType(type);
  if (PDF_TYPES.has(t)) return "pdf";
  if (CSV_TYPES.has(t)) return "csv";
  if (TEXT_TYPES.has(t)) return "text";
  return null;
}

function kindOfName(name: string): Kind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "csv") return "csv";
  if (ext === "txt" || ext === "md" || ext === "markdown") return "text";
  return null;
}

/** The stored type, else the name. Moodle's own answer is only asked when both say nothing. */
function kindOf(mime: string | null, name: string): Kind | null {
  return kindOfType(mime) ?? kindOfName(name);
}

// ---------------------------------------------------------------------------
// Download

type Downloaded = { bytes: Uint8Array; type: string | null };

function moodleErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const e = body as {
    errorcode?: unknown;
    exception?: unknown;
    error?: unknown;
  };
  if (typeof e.errorcode !== "string") return null;
  if (e.exception === undefined && e.error === undefined) return null;
  return e.errorcode;
}

/** Reads the body into memory, stopping (and cancelling the download) past `max` bytes. */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  max: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new MoodleDown("the download took too long");
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new Permanent("too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Permanent || error instanceof MoodleDown) throw error;
    throw new MoodleDown("the download broke off");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function download(
  conn: MoodleConn,
  url: string,
  mime: string | null,
  doFetch: typeof fetch,
): Promise<Downloaded> {
  if (process.env.MOODLE_FAKE === "1") return fakeFile(conn, mime);

  // Only files on her own site: the key is for that site, and we fetch nothing else.
  const site = new URL(conn.siteUrl.replace(/\/+$/, "") + "/");
  let target: URL;
  try {
    target = new URL(url, site);
  } catch {
    throw new Permanent("not_on_her_site");
  }
  if (target.origin !== site.origin) throw new Permanent("not_on_her_site");

  const controller = new AbortController();
  // First: an answer must start within the Moodle timeout.
  let timer = setTimeout(() => controller.abort(), MOODLE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(fileUrl(conn, target.toString()), {
      headers: { "user-agent": USER_AGENT },
      // Never follow a redirect: it could carry her key somewhere we do not know,
      // and Moodle redirects to its login page when it does not like the key.
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    throw new MoodleDown("could not reach the file");
  }
  clearTimeout(timer);

  const type = res.headers.get("content-type");
  const cancel = () => res.body?.cancel().catch(() => {});

  if (res.status >= 300 && res.status < 400) {
    await cancel();
    if (/\/login\//.test(res.headers.get("location") ?? ""))
      throw new Permanent("key_rejected");
    throw new MoodleDown(`the file answered a redirect (${res.status})`);
  }
  if (res.status === 401 || res.status === 403) {
    await cancel();
    throw new Permanent("key_rejected");
  }
  if (res.status === 404 || res.status === 410) {
    await cancel();
    throw new Permanent("file_gone");
  }

  const length = res.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_FILE_BYTES) {
    await cancel();
    throw new Permanent("too_large");
  }

  // Moodle's file server answers a bad key with a small JSON error, sometimes with HTTP 200.
  const smallJson =
    /\bjson\b/i.test(type ?? "") &&
    (length === null || Number(length) <= MAX_ERROR_JSON_BYTES);
  if (smallJson || !res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON: an error page
    }
    const code = moodleErrorCode(parsed);
    if (code && KEY_ERRORS.has(code)) throw new Permanent("key_rejected");
    if (code === "filenotfound" || code === "invalidfile")
      throw new Permanent("file_gone");
    if (!res.ok) throw new MoodleDown(`the file answered ${res.status}`);
    if (code)
      throw new MoodleDown("Moodle answered an error instead of the file");
    // A small JSON course file: not a type we read anyway.
    return { bytes: new TextEncoder().encode(text), type };
  }
  if (!res.body) return { bytes: new Uint8Array(0), type };

  // Then: the whole body must arrive within the download timeout.
  timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    return {
      bytes: await readCapped(res.body, MAX_FILE_BYTES, controller.signal),
      type,
    };
  } finally {
    clearTimeout(timer);
  }
}

// A one-page PDF that says it is a demo file, for MOODLE_FAKE previews (as in M1-29).
const FAKE_PDF = [
  "%PDF-1.4",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
  "4 0 obj<</Length 44>>stream",
  "BT /F1 18 Tf 40 70 Td (Demo course file) Tj ET",
  "endstream endobj",
  "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
  "trailer<</Root 1 0 R>>",
  "%%EOF",
].join("\n");
const FAKE_TEXT = "Demo course file from the fake Moodle.\n";

async function fakeFile(
  conn: MoodleConn,
  mime: string | null,
): Promise<Downloaded> {
  const { DEMO_KEY } = await import("@/server/moodle/fake-inline");
  if (process.env.VERCEL_ENV === "production")
    throw new Error("The fake Moodle is switched on in production.");
  if (conn.token !== DEMO_KEY) throw new Permanent("key_rejected");
  const pdf = kindOfType(mime) === "pdf";
  return {
    bytes: new TextEncoder().encode(pdf ? FAKE_PDF : FAKE_TEXT),
    type: pdf ? "application/pdf" : "text/plain; charset=utf-8",
  };
}

// ---------------------------------------------------------------------------
// Reading text

/** Postgres text cannot hold NUL; other control characters except tab and newlines go too. */
function clean(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function startsWithPdfMagic(bytes: Uint8Array): boolean {
  // "%PDF-" may follow a little junk; PDF readers look in the first 1 KB.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  if (!startsWithPdfMagic(bytes)) throw new Permanent("corrupt");
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // verbosity 0: PDF.js prints nothing (its warnings could name parts of the file).
    pdf = await getDocumentProxy(bytes, { verbosity: 0 });
  } catch (error) {
    throw new Permanent(
      error instanceof Error && error.name === "PasswordException"
        ? "password_protected"
        : "corrupt",
    );
  }
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((page) => clean(page).trim());
  } catch {
    throw new Permanent("corrupt");
  }
}

/** Splits CSV text into rows, keeping newlines inside quoted fields. Empty rows are dropped. */
function csvRows(text: string): string[] {
  const rows: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (c === "\n" && !quoted) {
      rows.push(text.slice(start, i));
      start = i + 1;
    }
  }
  rows.push(text.slice(start));
  return rows.filter((r) => r.trim() !== "");
}

/** The delimiter that splits the header best: comma, semicolon (common in Finland) or tab. */
function csvDelimiter(header: string): string {
  let best = ",";
  let most = -1;
  for (const d of [",", ";", "\t"]) {
    const n = csvFields(header, d);
    if (n > most) {
      most = n;
      best = d;
    }
  }
  return best;
}

function csvFields(row: string, delimiter: string): number {
  let n = 1;
  let quoted = false;
  for (const c of row) {
    if (c === '"') quoted = !quoted;
    else if (c === delimiter && !quoted) n++;
  }
  return n;
}

/** The first CSV_ROWS rows, then a line with how many rows (header included) and columns there are. */
export function csvPage(text: string): string {
  const rows = csvRows(clean(text));
  const columns = rows.length ? csvFields(rows[0], csvDelimiter(rows[0])) : 0;
  const shown = rows.slice(0, CSV_ROWS);
  const counts =
    `[CSV: ${rows.length} ${rows.length === 1 ? "row" : "rows"} (header included), ` +
    `${columns} ${columns === 1 ? "column" : "columns"}` +
    (rows.length > CSV_ROWS
      ? `; only the first ${CSV_ROWS} rows are shown]`
      : "]");
  return [...shown, counts].join("\n");
}

async function pagesOf(kind: Kind, bytes: Uint8Array): Promise<string[]> {
  if (kind === "pdf") return pdfPages(bytes);
  const text = decode(bytes);
  if (kind === "csv") return [csvPage(text)];
  return [clean(text)];
}

/** Thrown by `pagesFromBytes` for a file it cannot read; `reason` says why. */
export class UnreadableFile extends Error {
  constructor(
    readonly reason: "unsupported_type" | "corrupt" | "password_protected",
  ) {
    super(reason);
    this.name = "UnreadableFile";
  }
}

/**
 * The text of a file already in memory, page by page: a PDF per page (pages with only pictures
 * give empty text), TXT and MD as page 1, CSV as page 1 with the first 200 rows and a counts line.
 * Pure: no database, no network, no environment. `mime` is a MIME type (`application/pdf`,
 * `text/plain`, `text/markdown`, `text/csv`) or, failing that, a file name such as `notes.md`.
 * Throws `UnreadableFile` for a type it does not read or a PDF it cannot open.
 */
export async function pagesFromBytes(
  bytes: Uint8Array,
  mime: string,
): Promise<{ page: number; text: string }[]> {
  const kind = kindOfType(mime) ?? kindOfName(mime);
  if (!kind) throw new UnreadableFile("unsupported_type");
  try {
    const pages = await pagesOf(kind, bytes);
    return pages.map((text, i) => ({ page: i + 1, text }));
  } catch (error) {
    if (
      error instanceof Permanent &&
      (error.reason === "corrupt" || error.reason === "password_protected")
    ) {
      throw new UnreadableFile(error.reason);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Saving

/** Replaces the file's pages and marks it done, all at once. */
async function savePages(
  db: Db,
  fileId: string,
  pages: string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(filePages).where(eq(filePages.fileId, fileId));
    for (let i = 0; i < pages.length; i += PAGES_PER_INSERT) {
      const values = pages
        .slice(i, i + PAGES_PER_INSERT)
        .map((text, k) => ({ fileId, page: i + k + 1, text }));
      await tx.insert(filePages).values(values);
    }
    await tx
      .update(courseFiles)
      .set({ textStatus: "done" })
      .where(eq(courseFiles.id, fileId));
  });
}

/** Old pages go when a file fails: they belong to a version we can no longer read. */
async function saveFailed(db: Db, fileId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(filePages).where(eq(filePages.fileId, fileId));
    await tx
      .update(courseFiles)
      .set({ textStatus: "failed" })
      .where(eq(courseFiles.id, fileId));
  });
}

// ---------------------------------------------------------------------------
// The two entry points

/**
 * Extracts one file's text into `file_pages`. Returns what happened; throws only `MoodleDown`
 * (try again later) or an unexpected error.
 */
export async function extractFile(
  fileId: string,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const db = options.db ?? (await import("@/server/db/client")).db;
  const doFetch = options.fetch ?? fetch;
  const connection =
    options.connection ??
    (async (userId: string, database: Db) =>
      (await import("@/server/moodle/connect")).getConnection(
        userId,
        database,
      ));

  const where = options.userId
    ? and(eq(courseFiles.id, fileId), eq(courseFiles.userId, options.userId))
    : eq(courseFiles.id, fileId);
  const [file] = await db
    .select({
      userId: courseFiles.userId,
      name: courseFiles.name,
      mime: courseFiles.mime,
      size: courseFiles.size,
      url: courseFiles.url,
    })
    .from(courseFiles)
    .where(where)
    .limit(1);
  if (!file) return { status: "missing" };

  try {
    // Checks that need no download come first.
    if (file.size !== null && file.size > MAX_FILE_BYTES)
      throw new Permanent("too_large");
    const kind = kindOf(file.mime, file.name);
    if (
      !kind &&
      file.mime &&
      baseType(file.mime) !== "application/octet-stream"
    ) {
      throw new Permanent("unsupported_type");
    }

    const conn = await connection(file.userId, db);
    if (!conn) throw new Permanent("not_connected");

    const { bytes, type } = await download(conn, file.url, file.mime, doFetch);
    // What pagesFromBytes is told: the stored type if it names a kind, else the name, else Moodle's type.
    const as = kindOfType(file.mime)
      ? file.mime!
      : kindOfName(file.name)
        ? file.name
        : (type ?? "");
    const pages = await pagesFromBytes(bytes, as);
    await savePages(
      db,
      fileId,
      pages.map((p) => p.text),
    );
    return { status: "done", pages: pages.length };
  } catch (error) {
    const reason =
      error instanceof Permanent || error instanceof UnreadableFile
        ? error.reason
        : null;
    if (!reason) throw error;
    await saveFailed(db, fileId);
    return { status: "failed", reason };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What one `extract` job did, for the cron route's summary. */
export type ExtractTally = {
  extracted: number;
  failed: number;
  missing: number;
};

/**
 * The handler for `extract` jobs (payload `{ fileId }`). Pass `tally` to count outcomes.
 * A file that fails for good leaves `file failed: <reason>` in the job's `last_error`.
 */
export function extractJob(
  options: Omit<ExtractOptions, "userId"> & { tally?: ExtractTally } = {},
) {
  return async (payload: { fileId?: unknown }, job: JobInfo): Promise<void> => {
    const db = options.db ?? (await import("@/server/db/client")).db;
    const note = (text: string) =>
      db.update(jobs).set({ lastError: text }).where(eq(jobs.id, job.id));

    const fileId = payload.fileId;
    if (typeof fileId !== "string" || !UUID.test(fileId)) {
      await note("bad payload: fileId must be a uuid");
      return;
    }

    let result: ExtractResult;
    try {
      result = await extractFile(fileId, {
        ...options,
        db,
        userId: job.userId,
      });
    } catch (error) {
      // The queue gives up after this try: the file must not stay `queued` for ever.
      if (error instanceof MoodleDown) {
        const { MAX_TRIES } = await import("@/server/jobs/queue");
        if (job.attempt >= MAX_TRIES) await saveFailed(db, fileId);
      }
      throw error;
    }

    if (result.status === "done") {
      if (options.tally) options.tally.extracted++;
    } else if (result.status === "failed") {
      if (options.tally) options.tally.failed++;
      await note(`file failed: ${result.reason}`);
    } else {
      if (options.tally) options.tally.missing++;
      await note("file gone: no course_files row");
    }
  };
}
