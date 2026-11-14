/*
 * M1-29: open one course file through our server.
 *
 * GET /api/files/<course_files.id>
 * - Not signed in: 401 `{error:'not_signed_in'}`.
 * - Unknown id, malformed id, or a file of another user: 404 `{error:'not_found'}` (the same
 *   answer for all three, so ids of other people's files cannot be probed).
 * - No Moodle connection, or Moodle rejects her key: 401 `{error:'key_rejected', reconnect:true}`.
 * - Moodle down, slow, or answering something we cannot use: 502 `{error:'moodle_down', message}`.
 * - Otherwise the bytes, streamed through as Moodle sends them, with the content type and
 *   `Content-Disposition: inline; filename=...` (RFC 5987 `filename*` for non-ASCII names).
 *
 * Her key only ever goes into the URL our server fetches (`fileUrl`). The browser never sees a
 * redirect to Moodle, and no Moodle header except the type and length is passed on.
 * Nothing here logs: not the key, not the URL, not the file.
 *
 * With MOODLE_FAKE=1 no request is made: the fake answers with a small made-up file, and only
 * for the fake's demo key (anything else is a rejected key), like the rest of the fake Moodle.
 *
 * Cut (ticket): no caching, no range requests, no preview rendering.
 */
import { and, eq } from "drizzle-orm";
import { NotSignedIn, SESSION_COOKIE, currentUserFor } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { courseFiles } from "@/server/db/schema/courses";
import { MOODLE_TIMEOUT_MS, USER_AGENT, fileUrl, type MoodleConn } from "@/server/moodle/client";
import { getConnection } from "@/server/moodle/connect";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Error answers from Moodle's file server are small JSON; anything bigger is a real file. */
const MAX_ERROR_JSON_BYTES = 64 * 1024;
const PDF = "application/pdf";

const DOWN_MESSAGE = "MyCourses is not answering right now. Try again in a few minutes.";

type Failure = "key_rejected" | "moodle_down";

class FileFetchFailed extends Error {
  constructor(readonly why: Failure) {
    super(why);
  }
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

const notFound = () => json(404, { error: "not_found" });
const reconnect = () => json(401, { error: "key_rejected", reconnect: true });
const down = () => json(502, { error: "moodle_down", message: DOWN_MESSAGE });

function sessionToken(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1 || part.slice(0, at).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(at + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/** `inline; filename="<ascii>"; filename*=UTF-8''<percent-encoded>` (RFC 6266 / RFC 5987). */
function contentDisposition(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, "").trim() || "file";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Moodle's type unless it is missing or generic, then the type stored with the file. */
function contentType(fromMoodle: string | null, fromRow: string | null): string {
  const moodle = fromMoodle?.trim();
  if (moodle && !/^application\/octet-stream\b/i.test(moodle)) return moodle;
  return fromRow?.trim() || moodle || "application/octet-stream";
}

/** True when Moodle answered with one of its JSON error bodies instead of the file. */
function moodleError(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const e = body as { errorcode?: unknown; exception?: unknown; error?: unknown };
  if (typeof e.errorcode !== "string") return null;
  if (e.exception === undefined && e.error === undefined) return null;
  return e.errorcode;
}

const KEY_ERRORS = new Set(["invalidtoken", "accessexception", "usernotfullysetup", "forcepasswordchangenotice"]);

type Fetched = { body: ReadableStream<Uint8Array> | null; type: string | null; length: string | null };

async function fetchFromMoodle(conn: MoodleConn, url: string, mime: string | null): Promise<Fetched> {
  if (process.env.MOODLE_FAKE === "1") return fakeFile(conn, mime);

  // Only files on her own site: the key is for that site, and we fetch nothing else.
  const site = new URL(conn.siteUrl.replace(/\/+$/, "") + "/");
  let target: URL;
  try {
    target = new URL(url, site);
  } catch {
    throw new FileFetchFailed("moodle_down");
  }
  if (target.origin !== site.origin) throw new FileFetchFailed("moodle_down");

  // The timeout covers getting an answer started, not the whole download.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MOODLE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(fileUrl(conn, target.toString()), {
      headers: { "user-agent": USER_AGENT },
      // Never follow a redirect: it could carry the request somewhere we do not know,
      // and Moodle redirects to its login page when it does not like the key.
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    throw new FileFetchFailed("moodle_down");
  } finally {
    clearTimeout(timer);
  }

  const type = res.headers.get("content-type");
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    const to = res.headers.get("location") ?? "";
    throw new FileFetchFailed(/\/login\//.test(to) ? "key_rejected" : "moodle_down");
  }
  if (res.status === 401) {
    await res.body?.cancel().catch(() => {});
    throw new FileFetchFailed("key_rejected");
  }

  // Moodle's file server answers a bad key with a small JSON error, sometimes with HTTP 200.
  const length = res.headers.get("content-length");
  const smallJson =
    /\bjson\b/i.test(type ?? "") && (length === null || Number(length) <= MAX_ERROR_JSON_BYTES);
  if (smallJson || !res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON: a real file, or an error page
    }
    const code = moodleError(parsed);
    if (code && KEY_ERRORS.has(code)) throw new FileFetchFailed("key_rejected");
    if (!res.ok || code) {
      if (res.status === 403) throw new FileFetchFailed("key_rejected");
      throw new FileFetchFailed("moodle_down");
    }
    // A small JSON course file: send what we read.
    const bytes = new TextEncoder().encode(text);
    return { body: new Response(bytes).body, type, length: String(bytes.byteLength) };
  }
  return { body: res.body, type, length };
}

// A one-page PDF that says it is a demo file, for MOODLE_FAKE previews.
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

async function fakeFile(conn: MoodleConn, mime: string | null): Promise<Fetched> {
  const { DEMO_KEY } = await import("@/server/moodle/fake-inline");
  if (process.env.VERCEL_ENV === "production") throw new Error("The fake Moodle is switched on in production.");
  if (conn.token !== DEMO_KEY) throw new FileFetchFailed("key_rejected");
  const pdf = (mime ?? "").toLowerCase().startsWith(PDF);
  const bytes = new TextEncoder().encode(pdf ? FAKE_PDF : FAKE_TEXT);
  return { body: new Response(bytes).body, type: pdf ? PDF : "text/plain; charset=utf-8", length: String(bytes.byteLength) };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  let userId: string;
  try {
    userId = (await currentUserFor(db, sessionToken(request))).id;
  } catch (error) {
    if (error instanceof NotSignedIn) return json(401, { error: "not_signed_in" });
    throw error;
  }

  const { id } = await params;
  if (typeof id !== "string" || !UUID.test(id)) return notFound();

  const [file] = await db
    .select({ name: courseFiles.name, mime: courseFiles.mime, url: courseFiles.url })
    .from(courseFiles)
    .where(and(eq(courseFiles.id, id), eq(courseFiles.userId, userId)))
    .limit(1);
  if (!file) return notFound();

  const conn = await getConnection(userId, db);
  if (!conn) return reconnect();

  let fetched: Fetched;
  try {
    fetched = await fetchFromMoodle(conn, file.url, file.mime);
  } catch (error) {
    if (error instanceof FileFetchFailed) return error.why === "key_rejected" ? reconnect() : down();
    throw error;
  }

  const type = contentType(fetched.type, file.mime);
  const headers = new Headers({
    "content-type": type,
    "content-disposition": contentDisposition(file.name),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  // An HTML or SVG course file must not run as a page of ours. PDFs are left out:
  // some browsers refuse to show a PDF inside a sandbox.
  if (!type.toLowerCase().startsWith(PDF)) headers.set("content-security-policy", "sandbox");
  if (fetched.length && /^\d+$/.test(fetched.length)) headers.set("content-length", fetched.length);
  return new Response(fetched.body, { status: 200, headers });
}
