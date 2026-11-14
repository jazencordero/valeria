// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, newToken, SESSION_COOKIE } from "@/server/auth/session";
import { seal } from "@/server/crypto/seal";
import type { Db } from "@/server/db/client";
import { courseFiles, courses } from "@/server/db/schema/courses";
import { moodleConnections } from "@/server/db/schema/moodle";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { ALLOWED_SITES, connectWithKey } from "@/server/moodle/connect";
import { DEMO_KEY } from "@/server/moodle/fake-inline";

// The route reads the app database; point it at this test's fresh PGlite.
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/server/db/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db/client")>();
  const db = new Proxy({} as Db, {
    get(_t, prop) {
      const target = holder.db as Db;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...real, db };
});

const { GET } = await import("./route");

// Made-up values for tests only.
const FAKE_SECRET = "test-only-seal-secret-not-real";
const GOOD_KEY = "made-up-key-0123456789abcdef";
const AALTO = ALLOWED_SITES[0];
const SLOW = 120_000;
vi.setConfig({ testTimeout: SLOW, hookTimeout: SLOW });

const PDF_BYTES = Buffer.from("%PDF-1.4\nnot a real pdf, just bytes äö\n%%EOF\n", "utf8");

// A tiny stand-in for her Moodle site's file server, for the path that really fetches.
let moodle: Server;
let moodleUrl: string;
const seen: string[] = [];

function serve(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  seen.push(req.url ?? "");
  const token = url.searchParams.get("token");
  if (url.pathname.startsWith("/webservice/pluginfile.php/")) {
    if (token !== GOOD_KEY) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid token - token not found", errorcode: "invalidtoken", stacktrace: null }));
      return;
    }
    if (url.pathname.endsWith("/down.pdf")) {
      res.writeHead(503);
      res.end("busy");
      return;
    }
    if (url.pathname.endsWith("/broken.pdf")) {
      res.writeHead(500);
      res.end("oops");
      return;
    }
    if (url.pathname.endsWith("/moved.pdf")) {
      res.writeHead(303, { location: `${moodleUrl}/login/index.php` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/pdf", "content-length": String(PDF_BYTES.length) });
    res.end(PDF_BYTES);
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
  await new Promise<void>((resolve) => moodle.close(() => resolve()));
});

let t: TestDb;
beforeEach(async () => {
  vi.stubEnv("KEY_SEAL_SECRET", FAKE_SECRET);
  vi.stubEnv("MOODLE_FAKE", "1");
  t = await createTestDb();
  holder.db = t.db;
  seen.length = 0;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
});

async function signedIn() {
  const { user, token } = await ensureSessionFor(t.db, newToken());
  return { userId: user.id, cookie: `other=1; ${SESSION_COOKIE}=${token}` };
}

async function fileFor(userId: string, opts: { name?: string; mime?: string | null; url?: string } = {}) {
  const [course] = await t.db
    .insert(courses)
    .values({ userId, moodleId: Math.floor(Math.random() * 1e6), name: "Demo course" })
    .returning();
  const [file] = await t.db
    .insert(courseFiles)
    .values({
      userId,
      courseId: course.id,
      moodleRef: `ref-${Math.random()}`,
      name: opts.name ?? "Lecture 1.pdf",
      mime: opts.mime === undefined ? "application/pdf" : opts.mime,
      url: opts.url ?? `${AALTO}/webservice/pluginfile.php/1/mod_resource/content/0/lecture1.pdf`,
    })
    .returning();
  return file.id;
}

/** A connection row pointing at the local stand-in Moodle (the real path, no fake). */
async function connectLocal(userId: string, key = GOOD_KEY) {
  await t.db.insert(moodleConnections).values({ userId, siteUrl: moodleUrl, moodleUserId: 42, tokenSealed: seal(key) });
}

function get(id: string, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return GET(new Request(`http://localhost/api/files/${id}`, { headers }), { params: Promise.resolve({ id }) });
}

/** Everything the browser gets: status, every header, and the body. */
async function seenByBrowser(res: Response) {
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  const body = Buffer.from(await res.arrayBuffer());
  return { headers, body, all: `${res.status}\n${headers}\n${body.toString("latin1")}` };
}

describe("GET /api/files/[id] against the fake Moodle", () => {
  it("gives the owner the bytes, inline, with no key anywhere in the response", async () => {
    const { userId, cookie } = await signedIn();
    const result = await connectWithKey(userId, AALTO, DEMO_KEY, t.db);
    expect(result.ok).toBe(true);
    const id = await fileFor(userId);

    const res = await get(id, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="Lecture 1.pdf"; filename*=UTF-8''Lecture%201.pdf`);
    expect(res.headers.get("location")).toBeNull();
    const { body, all } = await seenByBrowser(res);
    expect(body.toString("latin1").startsWith("%PDF-")).toBe(true);
    expect(all).not.toContain("token=");
    expect(all).not.toContain(DEMO_KEY);
  });

  it("answers 404 for another user's file, an unknown id and a malformed id", async () => {
    const owner = await signedIn();
    await connectWithKey(owner.userId, AALTO, DEMO_KEY, t.db);
    const id = await fileFor(owner.userId);
    const other = await signedIn();

    for (const [fileId, cookie] of [
      [id, other.cookie],
      ["00000000-0000-4000-8000-000000000000", owner.cookie],
      ["not-a-uuid", owner.cookie],
      ["../../etc/passwd", owner.cookie],
    ] as const) {
      const res = await get(fileId, cookie);
      expect(res.status).toBe(404);
      const { all } = await seenByBrowser(res);
      expect(JSON.parse(all.split("\n").pop()!)).toEqual({ error: "not_found" });
      expect(all).not.toContain("token=");
    }
  });

  it("answers 401 not_signed_in without a session", async () => {
    const owner = await signedIn();
    const id = await fileFor(owner.userId);
    const res = await get(id);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "not_signed_in" });
  });

  it("answers 401 reconnect when the key is rejected or she is not connected", async () => {
    const { userId, cookie } = await signedIn();
    const id = await fileFor(userId);

    const notConnected = await get(id, cookie);
    expect(notConnected.status).toBe(401);
    expect(await notConnected.json()).toEqual({ error: "key_rejected", reconnect: true });

    // A key the fake does not accept (stored directly: connectWithKey would refuse it).
    await t.db.insert(moodleConnections).values({ userId, siteUrl: AALTO, moodleUserId: 7, tokenSealed: seal("made-up-wrong-key") });
    const res = await get(id, cookie);
    expect(res.status).toBe(401);
    const { all } = await seenByBrowser(res);
    expect(JSON.parse(all.split("\n").pop()!)).toEqual({ error: "key_rejected", reconnect: true });
    expect(all).not.toContain("made-up-wrong-key");
  });

  it("encodes a non-ASCII or awkward file name safely", async () => {
    const { userId, cookie } = await signedIn();
    await connectWithKey(userId, AALTO, DEMO_KEY, t.db);
    const id = await fileFor(userId, { name: 'Luento "ä" 2\r\n(final).txt', mime: "text/plain" });

    const res = await get(id, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `inline; filename="Luento ___ 2(final).txt"; filename*=UTF-8''Luento%20%22%C3%A4%22%202%28final%29.txt`,
    );
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(await res.text()).toContain("Demo course file");
  });
});

describe("GET /api/files/[id] fetching from her Moodle site", () => {
  beforeEach(() => {
    vi.stubEnv("MOODLE_FAKE", "0");
  });

  it("streams the owner's bytes through; the key goes only to Moodle, never to the browser", async () => {
    const { userId, cookie } = await signedIn();
    await connectLocal(userId);
    const id = await fileFor(userId, {
      name: "Viikko 3 – kalvot.pdf",
      mime: null,
      url: `${moodleUrl}/pluginfile.php/9/mod_resource/content/0/w3.pdf`,
    });

    const res = await get(id, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      `inline; filename="Viikko 3 _ kalvot.pdf"; filename*=UTF-8''Viikko%203%20%E2%80%93%20kalvot.pdf`,
    );
    const { body, all } = await seenByBrowser(res);
    expect(body.equals(PDF_BYTES)).toBe(true);
    expect(all).not.toContain("token=");
    expect(all).not.toContain(GOOD_KEY);

    // Moodle got the key, on the web service file server path.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/webservice/pluginfile.php/9/");
    expect(seen[0]).toContain(`token=${GOOD_KEY}`);
  });

  it("gives another user 404 without asking Moodle", async () => {
    const owner = await signedIn();
    await connectLocal(owner.userId);
    const id = await fileFor(owner.userId, { url: `${moodleUrl}/webservice/pluginfile.php/1/x/0/a.pdf` });
    const other = await signedIn();
    await connectLocal(other.userId);

    const res = await get(id, other.cookie);
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("answers 401 reconnect when Moodle rejects the key, and when it redirects to its login page", async () => {
    const { userId, cookie } = await signedIn();
    await connectLocal(userId, "made-up-revoked-key");
    const id = await fileFor(userId, { url: `${moodleUrl}/webservice/pluginfile.php/1/x/0/a.pdf` });
    const res = await get(id, cookie);
    expect(res.status).toBe(401);
    const { all } = await seenByBrowser(res);
    expect(JSON.parse(all.split("\n").pop()!)).toEqual({ error: "key_rejected", reconnect: true });
    expect(all).not.toContain("made-up-revoked-key");

    const { userId: u2, cookie: c2 } = await signedIn();
    await connectLocal(u2);
    const moved = await fileFor(u2, { url: `${moodleUrl}/webservice/pluginfile.php/1/x/0/moved.pdf` });
    const redirected = await get(moved, c2);
    expect(redirected.status).toBe(401);
    expect(redirected.headers.get("location")).toBeNull();
    const seenMoved = await seenByBrowser(redirected);
    expect(seenMoved.all).not.toContain("token=");
    expect(seenMoved.all).not.toContain("/login/");
  });

  it("answers 502 with a short JSON body when Moodle is down, broken or unreachable", async () => {
    const { userId, cookie } = await signedIn();
    await connectLocal(userId);
    for (const name of ["down.pdf", "broken.pdf"]) {
      const id = await fileFor(userId, { url: `${moodleUrl}/webservice/pluginfile.php/1/x/0/${name}` });
      const res = await get(id, cookie);
      expect(res.status).toBe(502);
      const { all } = await seenByBrowser(res);
      expect(JSON.parse(all.split("\n").pop()!)).toMatchObject({ error: "moodle_down" });
      expect(all).not.toContain("token=");
    }

    // Nothing listens on her site any more.
    const { userId: u2, cookie: c2 } = await signedIn();
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await t.db.insert(moodleConnections).values({ userId: u2, siteUrl: deadUrl, moodleUserId: 43, tokenSealed: seal(GOOD_KEY) });
    const id = await fileFor(u2, { url: `${deadUrl}/webservice/pluginfile.php/1/x/0/a.pdf` });
    const res = await get(id, c2);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "moodle_down" });
  });

  it("does not send her key to a file URL on another host", async () => {
    const { userId, cookie } = await signedIn();
    await connectLocal(userId);
    const id = await fileFor(userId, { url: "https://elsewhere.example/webservice/pluginfile.php/1/a.pdf" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await get(id, cookie);
    expect(res.status).toBe(502);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
