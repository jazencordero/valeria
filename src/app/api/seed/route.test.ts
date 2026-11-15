// @vitest-environment node
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signUp } from "@/server/auth/accounts";
import { ensureSessionFor, newToken, SESSION_COOKIE } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { events } from "@/server/db/schema/calendar";
import { courses } from "@/server/db/schema/courses";
import { gradeItems } from "@/server/db/schema/grades";
import { lectureContent, lectures } from "@/server/db/schema/learn";
import { moodleConnections } from "@/server/db/schema/moodle";
import { cards, cardStates, concepts, examDocuments, exams } from "@/server/db/schema/study";
import { sessions, users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { DEMO_FLAG } from "@/server/demo/seed";
import {
  applySeed,
  combineAnswers,
  loadSeed,
  planSeed,
  seedPartsOf,
  serialisePart,
  UPLOAD_MAX_BYTES,
  type SeedAnswer,
  type SeedInput,
} from "@/server/study/seed-account";

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

const { POST } = await import("./route");
const { POST: LOGIN } = await import("../login/route");
const { POST: LOGOUT } = await import("../../logout/route");
const { run } = await import("../../../../scripts/study/seed-account");

const T = 90_000;
vi.setConfig({ testTimeout: T, hookTimeout: T });

// Invented data only: the sample account and the sample bundles of tests/fixtures/study.
const ACCOUNT = path.join(process.cwd(), "tests/fixtures/study/sample-account");
const BUNDLE = path.join(process.cwd(), "tests/fixtures/study/sample-bundle");
const STUDY_ONLY = path.join(process.cwd(), "tests/fixtures/study/sample-study-only");
const NOW = new Date("2026-11-15T10:00:00Z");
/** A size that makes the sample course folder take several requests. */
const SMALL = 4_000;
const URL_HERE = "http://localhost:3000/api/seed";

let tmp: string;
let bundles: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "seed-route-"));
  bundles = path.join(tmp, "bundles");
  await cp(BUNDLE, path.join(bundles, "TST-E0001"), { recursive: true });
  await cp(STUDY_ONLY, path.join(bundles, "TST-E0003"), { recursive: true });
  // More invented cards, so the cards alone take more than one request.
  const deckFile = path.join(bundles, "TST-E0001", "deck-1.json");
  const deck = JSON.parse(await readFile(deckFile, "utf8")) as unknown[];
  for (let i = 1; i <= 40; i++) deck.push({ id: `more-${i}`, type: "basic", concept: "moving-average", q: `Invented question ${i}?`, a: `Invented answer ${i}.`, source: "Lecture 1, slide 9" });
  await writeFile(deckFile, JSON.stringify(deck));
  await writeFile(
    path.join(bundles, "account.json"),
    JSON.stringify({
      exams: [{ courseCode: "TST-E0001", title: "Forecasting final", kind: "exam", at: "2026-12-11T09:00:00+02:00", atIsPlaceholderTime: true }],
      gradeWeights: [{ courseCode: "TST-E0001", items: [{ name: "Exercises", weight: 40 }, { name: "Final exam", weight: 60 }] }],
      aiAllowed: [{ courseCode: "TST-E0001", allowed: true }],
    }),
  );
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

let t: TestDb;
let input: SeedInput;
beforeEach(async () => {
  t = await createTestDb();
  holder.db = t.db;
  input = await loadSeed(ACCOUNT, bundles);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

/** A device session with no account behind it: what a browser had before accounts (M5-14). */
async function deviceSession(): Promise<{ userId: string; cookie: string }> {
  const { user, token } = await ensureSessionFor(t.db, newToken());
  return { userId: user.id, cookie: `other=1; ${SESSION_COOKIE}=${token}` };
}

let made = 0;
/** A session of a named account (invented names only). */
async function signIn(): Promise<{ userId: string; cookie: string }> {
  const session = await deviceSession();
  await t.db.update(users).set({ username: `test.student.${++made}` }).where(eq(users.id, session.userId));
  return session;
}

function post(body: string, cookie?: string, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest(URL_HERE, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
      body,
    }),
  );
}

/** Sends every part of the seed, in order, as the tool will. */
async function upload(cookie: string, maxBytes = SMALL): Promise<SeedAnswer[]> {
  const answers: SeedAnswer[] = [];
  for (const part of seedPartsOf(input, maxBytes)) {
    const res = await post(serialisePart(part), cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    answers.push((await res.json()) as SeedAnswer);
  }
  return answers;
}

const TABLES = { courses, assignments, events, gradeItems, exams, concepts, cards, cardStates, lectures, lectureContent, examDocuments };
async function rowCounts(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, table] of Object.entries(TABLES)) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
    out[name] = row.n;
  }
  return out;
}

/** A few values of the rows, to compare an upload with a direct run. */
async function someValues(db: Db, userId: string) {
  const sorted = <R>(rows: R[]) => rows.map((r) => JSON.stringify(r)).sort();
  return {
    courses: sorted((await db.select().from(courses).where(eq(courses.userId, userId))).map((c) => [c.code, c.name, c.moodleId, c.aiAssignments, c.aiStudy])),
    assignments: sorted((await db.select().from(assignments).where(eq(assignments.userId, userId))).map((a) => [a.moodleId, a.name, a.dueAt, a.state, a.submittedAt])),
    exams: sorted((await db.select().from(exams).where(eq(exams.userId, userId))).map((e) => [e.title, e.at, e.kind, e.targetPct, e.studyMap, e.gradeTarget])),
    cards: sorted((await db.select().from(cards).where(eq(cards.userId, userId))).map((c) => [c.contentHash, c.importId, c.type, c.body])),
    pages: sorted((await db.select().from(lectureContent)).map((p) => [p.sourceHash, p.minutes])),
    concepts: sorted((await db.select().from(concepts).where(eq(concepts.userId, userId))).map((c) => [c.slug, c.position, c.weight])),
  };
}

describe("POST /api/seed", () => {
  it("fills the signed-in account as a direct run would, in several requests, and a second upload changes nothing", async () => {
    const { userId, cookie } = await signIn();
    const parts = seedPartsOf(input, SMALL);
    // The account, the exam course in more than two batches, the study-only course.
    expect(parts[0].part).toBe("account");
    expect(parts.filter((p) => p.part === "bundle" && p.kind === "exam").length).toBeGreaterThan(2);
    const answers = await upload(cookie);
    expect(answers).toHaveLength(parts.length);

    // The same files, straight into another database.
    const direct = await createTestDb();
    try {
      const plan = planSeed(input);
      const r = await applySeed(direct.db, plan, { now: NOW });
      expect(await rowCounts(t.db)).toEqual(await rowCounts(direct.db));
      expect(await someValues(t.db, userId)).toEqual(await someValues(direct.db, r.userId));
      // The counts the tool prints are the direct run's.
      const summary = combineAnswers(plan, answers);
      expect({ ...summary.counts, user: null }).toEqual({ ...r.counts, user: null });
      expect(summary.imports.map((i) => [i.courseCode, i.counts])).toEqual(r.imports.map((i) => [i.courseCode, i.counts]));
      expect(summary.imports[0].counts).toMatchObject({ cards: { created: 45, skipped: 0, updated: 0 }, concepts: { created: 3, skipped: 0 }, pages: { created: 1 } });
      expect(await t.db.select().from(users)).toHaveLength(1);

      const before = [await rowCounts(t.db), await someValues(t.db, userId)];
      const again = combineAnswers(plan, await upload(cookie));
      expect([await rowCounts(t.db), await someValues(t.db, userId)]).toEqual(before);
      const touched = [...Object.values(again.counts), ...again.imports.flatMap((i) => Object.values(i.counts))].reduce((s, c) => s + c.created + c.updated, 0);
      expect(touched).toBe(0);
      expect(again.imports[0].counts).toMatchObject({ cards: { created: 0, skipped: 45 }, concepts: { skipped: 3 } });
    } finally {
      await direct.close();
    }
  });

  it("refuses a request with no session, and one with a session nobody has", async () => {
    const body = serialisePart(seedPartsOf(input)[0]);
    for (const cookie of [undefined, `${SESSION_COOKIE}=${newToken()}`, `${SESSION_COOKIE}=not-a-token`]) {
      const res = await post(body, cookie);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ error: "not_signed_in" });
    }
    expect(Object.values(await rowCounts(t.db)).every((n) => n === 0)).toBe(true);
  });

  it("refuses a device session with no account behind it (403), whatever it sends, and writes nothing", async () => {
    const anonymous = await deviceSession();
    for (const body of seedPartsOf(input).map(serialisePart)) {
      const res = await post(body, anonymous.cookie);
      expect(res.status).toBe(403);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "no_account", message: "Log in to an account with a username first: files only go into a named account." });
    }
    expect(Object.values(await rowCounts(t.db)).every((n) => n === 0)).toBe(true);
    const [row] = await t.db.select().from(users).where(eq(users.id, anonymous.userId));
    expect(row.settings.seededFrom).toBeUndefined();
    // The same session, once it is an account's, is let in.
    await t.db.update(users).set({ username: "test.student.named" }).where(eq(users.id, anonymous.userId));
    expect((await post(serialisePart(seedPartsOf(input)[0]), anonymous.cookie)).status).toBe(200);
  });

  it("refuses a body over 4 MB with a clear message: by its declared length, and by the bytes that really come", async () => {
    const { cookie } = await signIn();
    const big = JSON.stringify({ part: "account", padding: "x".repeat(UPLOAD_MAX_BYTES) });
    const small = serialisePart(seedPartsOf(input)[0]);
    const tries = [
      post(big, cookie), // no Content-Length at all
      post(big, cookie, { "content-length": String(Buffer.byteLength(big)) }),
      post(big, cookie, { "content-length": "120" }), // a length that lies
      post(small, cookie, { "content-length": String(UPLOAD_MAX_BYTES + 1) }),
    ];
    for (const res of await Promise.all(tries)) {
      expect(res.status).toBe(413);
      const answer = (await res.json()) as { error: string; message: string };
      expect(answer.error).toBe("too_large");
      expect(answer.message).toBe("This part is over 4 MB. Send it as several smaller parts: a bundle's cards and pages can be split into batches.");
    }
    expect(Object.values(await rowCounts(t.db)).every((n) => n === 0)).toBe(true);
    // Exactly at the limit is read (and then refused for what it says, not for its size).
    const atLimit = `{"part":"nothing","padding":"${"x".repeat(UPLOAD_MAX_BYTES - 31)}"}`;
    expect(Buffer.byteLength(atLimit)).toBe(UPLOAD_MAX_BYTES);
    expect((await post(atLimit, cookie)).status).toBe(400);
  });

  it("refuses the 31st request in an hour with Retry-After, per user, and lets her in again after the hour", async () => {
    const { cookie } = await signIn();
    const start = Date.now();
    for (let i = 0; i < 30; i++) expect((await post("{}", cookie)).status).toBe(400);
    const res = await post(serialisePart(seedPartsOf(input)[0]), cookie);
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const wait = Number(res.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(3500);
    expect(wait).toBeLessThanOrEqual(3600);
    expect(await res.json()).toMatchObject({ error: "too_many" });
    expect(Object.values(await rowCounts(t.db)).every((n) => n === 0)).toBe(true);

    // Someone else is not held back by her count.
    const other = await signIn();
    expect((await post("{}", other.cookie)).status).toBe(400);

    vi.spyOn(Date, "now").mockReturnValue(start + 61 * 60 * 1000);
    expect((await post("{}", cookie)).status).toBe(400);
  });

  it("cannot write to another user: a body that names one is refused, and nothing of hers changes", async () => {
    const me = await signIn();
    const her = await signIn();
    const [account, bundle] = seedPartsOf(input).map((p) => JSON.parse(serialisePart(p)) as Record<string, unknown>);
    for (const body of [
      { ...account, userId: her.userId },
      { ...account, user_id: her.userId },
      { ...account, user: { id: her.userId } },
      { ...account, key: "0".repeat(64) },
      { ...bundle, userId: her.userId },
    ]) {
      const res = await post(JSON.stringify(body), me.cookie);
      expect(res.status).toBe(400);
      const answer = (await res.json()) as { error: string; problems: string[] };
      expect(answer.error).toBe("invalid");
      expect(answer.problems.join("\n")).toContain("a part cannot say whose account it is for");
      expect(JSON.stringify(answer)).not.toContain(her.userId);
    }
    expect(Object.values(await rowCounts(t.db)).every((n) => n === 0)).toBe(true);

    // A user id hidden deeper is not read at all: the rows are the caller's.
    const res = await post(JSON.stringify({ ...account, account: { ...(account.account as object), userId: her.userId, user: { id: her.userId } } }), me.cookie);
    expect(res.status).toBe(200);
    expect(await t.db.select().from(courses).where(eq(courses.userId, her.userId))).toHaveLength(0);
    expect(await t.db.select().from(courses).where(eq(courses.userId, me.userId))).toHaveLength(3);
    const [hers] = await t.db.select().from(users).where(eq(users.id, her.userId));
    expect(hers.settings.seededFrom).toBeUndefined();
    const [mine] = await t.db.select().from(users).where(eq(users.id, me.userId));
    expect((mine.settings.seededFrom as Record<string, unknown>).key).toBeUndefined();
  });

  it("takes JSON only, and nothing a browser sends from another site", async () => {
    const { cookie } = await signIn();
    const body = serialisePart(seedPartsOf(input)[0]);
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp", ""]) {
      const res = await post(body, cookie, { "content-type": type });
      expect(res.status).toBe(415);
      expect(await res.json()).toMatchObject({ error: "wrong_type" });
    }
    const elsewhere: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: "https://elsewhere.example", host: "localhost:3000" },
      { origin: "null" },
      { origin: "http://localhost:3000", "x-forwarded-host": "ready.example" },
    ];
    for (const headers of elsewhere) {
      const res = await post(body, cookie, headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "cross_site" });
    }
    expect(Object.values(await rowCounts(t.db)).every((n) => n === 0)).toBe(true);
    // The app's own pages, and the tool (which sends neither header), are let through.
    expect((await post(body, cookie, { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await post(body, cookie, { origin: "https://ready.example", "x-forwarded-host": "ready.example" })).status).toBe(200);
    expect((await post(body, cookie, { "content-type": "application/json; charset=utf-8" })).status).toBe(200);
  });

  it("says what does not fit by its path, never by its value, and writes nothing", async () => {
    const { cookie } = await signIn();
    const account = JSON.parse(serialisePart(seedPartsOf(input)[0])) as { account: { courses: { name: unknown; assignments: { dueAt: string }[] }[] } };
    account.account.courses[0].assignments[0].dueAt = "a secret day";
    account.account.courses[1].name = 12;
    const res = await post(JSON.stringify(account), cookie);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("account.courses.0.assignments.0.dueAt");
    expect(text).toContain("account.courses.1.name");
    expect(text).not.toContain("a secret day");
    for (const body of ["", "{not json", "[]", '"text"', '{"part":"plan"}']) expect((await post(body, cookie)).status).toBe(400);
    expect(Object.values(await rowCounts(t.db)).every((n) => n === 0)).toBe(true);
  });

  it("refuses the account part once the account has a Moodle connection (409) and a demo account altogether; logs nothing of a part", async () => {
    const logged: unknown[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation((...a: unknown[]) => void logged.push(...a));
    const { userId, cookie } = await signIn();
    await t.db.insert(moodleConnections).values({ userId, siteUrl: "https://moodle.example.test", moodleUserId: 1, tokenSealed: "not-a-real-sealed-key" });
    const [account, bundle] = seedPartsOf(input).map(serialisePart);
    const res = await post(account, cookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "refused" });
    // Her course folder is study content: it goes in when the sync has made the course, and says so when not.
    const none = await post(bundle, cookie);
    expect(none.status).toBe(200);
    expect(await none.json()).toMatchObject({ part: "bundle", imported: false });
    await t.db.insert(courses).values({ userId, moodleId: 4401, code: "TST-E0001", name: "Intro to Forecasting" });
    const went = await post(bundle, cookie);
    expect(await went.json()).toMatchObject({ part: "bundle", imported: true, counts: { cards: { created: 45 } } });

    const demo = await signIn();
    await t.db.update(users).set({ settings: { [DEMO_FLAG]: true } }).where(eq(users.id, demo.userId));
    expect((await post(account, demo.cookie)).status).toBe(403);
    expect(await t.db.select().from(courses).where(eq(courses.userId, demo.userId))).toHaveLength(0);
    expect(logged).toEqual([]);
  });
});

// The tool (scripts/study/seed-account.ts --upload), with a fetch that calls the two route
// handlers in-process: no network, the same database as above.
describe("the tool's --upload, against POST /api/login and POST /api/seed", () => {
  // Invented only: never a real name or password.
  const NAME = "test.student";
  const PASSWORD = "correct horse battery";
  const HOST = "https://ready.example.test";

  type Call = { path: string; cookie: string | null; type: string | null; body: string };
  type Hook = (call: Call, nth: number) => Response | undefined;

  /** What the tool is given instead of the network. `hook` may answer in the app's place. */
  function app(hook?: Hook) {
    const calls: Call[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const to = new URL(String(url));
      const headers = new Headers(init?.headers);
      const call = { path: to.pathname, cookie: headers.get("cookie"), type: headers.get("content-type"), body: String(init?.body ?? "") };
      calls.push(call);
      expect(to.origin).toBe(HOST);
      expect(init?.redirect).toBe("manual");
      const canned = hook?.(call, calls.filter((c) => c.path === call.path).length);
      if (canned) return canned;
      const request = new NextRequest(to, { method: init?.method, headers, body: call.body });
      if (to.pathname === "/api/login") return LOGIN(request);
      if (to.pathname === "/api/seed") return POST(request);
      if (to.pathname === "/logout") return LOGOUT(request);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    return { calls, fetcher };
  }

  function io(fetcher: typeof fetch, password = PASSWORD, partBytes: number | undefined = SMALL) {
    const out: string[] = [];
    const err: string[] = [];
    const asked: string[] = [];
    return {
      out,
      err,
      asked,
      io: {
        out: (l: string) => void out.push(l),
        err: (l: string) => void err.push(l),
        askHidden: async (q: string) => {
          asked.push(q);
          return password;
        },
        fetch: fetcher,
        partBytes,
      },
    };
  }

  const upload = (more: string[] = []) => [ACCOUNT, bundles, "--upload", HOST, "--username", "Test.Student", ...more];
  /** The printed count lines, without the user's (an upload never makes a user). */
  const countLines = (lines: string[]) => lines.filter((l) => / created, /.test(l) && !/^\s*User /.test(l));
  /** Nothing printed may hold the password or a session token. */
  function nothingSecretIn(lines: string[], calls: Call[]) {
    const text = lines.join("\n");
    expect(text).not.toContain(PASSWORD);
    for (const c of calls) if (c.cookie) expect(text).not.toContain(c.cookie.split("=")[1]);
    expect(text).not.toContain(SESSION_COOKIE);
  }

  let userId: string;
  beforeEach(async () => {
    const account = await signUp(NAME, PASSWORD, { db: t.db });
    if (!account.ok) throw new Error("sign up failed");
    userId = account.userId;
  });

  it("logs in, sends the parts in order (account first) with the session, and prints a direct run's counts; a second upload changes nothing", async () => {
    const { calls, fetcher } = app();
    const first = io(fetcher);
    expect(await run(upload(), null, first.io)).toBe(0);
    expect(first.err).toEqual([]);
    expect(first.asked).toHaveLength(1);

    // One log in with no cookie, then every part of `seedPartsOf`, in order, each with the same session.
    const parts = seedPartsOf(input, SMALL).map(serialisePart);
    expect(parts.length).toBeGreaterThan(4);
    expect(calls.map((c) => c.path)).toEqual(["/api/login", ...parts.map(() => "/api/seed"), "/logout"]);
    expect(calls.slice(0, -1).every((c) => c.type === "application/json")).toBe(true);
    expect(calls[0].cookie).toBeNull();
    expect(JSON.parse(calls[0].body)).toEqual({ username: "Test.Student", password: PASSWORD });
    expect(calls.slice(1, -1).map((c) => c.body)).toEqual(parts);
    expect(JSON.parse(calls[1].body)).toMatchObject({ part: "account" });
    const cookie = calls[1].cookie!;
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}$`));
    expect(calls.slice(1).every((c) => c.cookie === cookie && !c.body.includes(PASSWORD))).toBe(true);
    nothingSecretIn([...first.out, ...first.err, ...first.asked], calls);
    expect(first.out[0]).toBe(`Uploaded to ${HOST}, into the account ${NAME}:`);
    expect(first.out.join("\n")).not.toContain("/open?code=");
    // The run ended its own session: only the one her sign-up made is left.
    expect(calls.at(-1)!.cookie).toBe(cookie);
    expect(await t.db.select().from(sessions)).toHaveLength(1);

    // The same files through a direct run, into another database: the same rows, the same printed counts.
    const direct = await createTestDb();
    try {
      const lines: string[] = [];
      expect(await run([ACCOUNT, bundles], direct.db, { out: (l) => void lines.push(l), err: (l) => void lines.push(l) })).toBe(0);
      const [seeded] = await direct.db.select().from(users);
      expect(await rowCounts(t.db)).toEqual(await rowCounts(direct.db));
      expect(await someValues(t.db, userId)).toEqual(await someValues(direct.db, seeded.id));
      expect(countLines(first.out).length).toBeGreaterThan(10);
      expect(countLines(first.out)).toEqual(countLines(lines));
    } finally {
      await direct.close();
    }
    expect(await t.db.select().from(users)).toHaveLength(1);

    const before = [await rowCounts(t.db), await someValues(t.db, userId)];
    const second = io(fetcher);
    expect(await run(upload(), null, second.io)).toBe(0);
    expect([await rowCounts(t.db), await someValues(t.db, userId)]).toEqual(before);
    expect(countLines(second.out).length).toBe(countLines(first.out).length);
    for (const line of countLines(second.out)) expect(line).toMatch(/ 0 created, \d+ already there$/);
  });

  it("--dry-run plans from the files, prints the sizes, asks for no password and sends nothing", async () => {
    const { calls, fetcher } = app();
    const dry = io(fetcher);
    expect(await run(upload(["--dry-run"]), null, dry.io)).toBe(0);
    expect(calls).toEqual([]);
    expect(dry.asked).toEqual([]);
    const parts = seedPartsOf(input, SMALL);
    expect(dry.out[0]).toBe("Dry run: nothing was sent, nobody was logged in and no password was asked.");
    expect(dry.out[1]).toBe(`An upload to ${HOST} into the account ${NAME} would send ${parts.length} requests:`);
    expect(dry.out.filter((l) => /^\s+\d+\. /.test(l))).toHaveLength(parts.length);
    expect(dry.out[2]).toMatch(/^\s+1\. account\s+[\d.]+ kB\s+3 courses$/);
    expect(dry.out.join("\n")).toContain("bundle TST-E0001 1/");
    expect(Object.values(await rowCounts(t.db)).every((n) => n === 0)).toBe(true);
  });

  it("stops at a wrong password (and at the log-in brake) before sending anything", async () => {
    const { calls, fetcher } = app();
    const wrong = io(fetcher, "not the password");
    expect(await run(upload(), null, wrong.io)).toBe(1);
    expect(calls.map((c) => c.path)).toEqual(["/api/login"]);
    expect(wrong.err).toEqual(["Log in failed: that username and password do not match. Nothing was sent."]);
    expect(wrong.out).toEqual([]);
    expect(wrong.err.join("\n")).not.toContain("not the password");

    const braked = app((call) => (call.path === "/api/login" ? Response.json({ error: "too_many", message: "x" }, { status: 429, headers: { "Retry-After": "900" } }) : undefined));
    const held = io(braked.fetcher);
    expect(await run(upload(), null, held.io)).toBe(1);
    expect(braked.calls).toHaveLength(1);
    expect(held.err).toEqual(["Log in refused: too many tries. Wait 15 minutes and run this again. Nothing was sent."]);

    // An app that answers 200 without a session, or with a redirect, is not logged in to.
    for (const answer of [() => Response.json({ ok: true }), () => new Response(null, { status: 308, headers: { location: "https://elsewhere.example/api/login" } })]) {
      const odd = app((call) => (call.path === "/api/login" ? answer() : undefined));
      const o = io(odd.fetcher);
      expect(await run(upload(), null, o.io)).toBe(1);
      expect(odd.calls).toHaveLength(1);
      expect(o.err[0]).toMatch(/Nothing was sent\.$/);
    }
    expect(Object.values(await rowCounts(t.db)).every((n) => n === 0)).toBe(true);
  });

  it("stops when the session is no longer valid (401), and says how long to wait when the app has had its 30 an hour (429)", async () => {
    const expired = app((call, nth) => (call.path === "/api/seed" && nth === 2 ? Response.json({ error: "not_signed_in", message: "Sign in first." }, { status: 401 }) : undefined));
    const a = io(expired.fetcher);
    expect(await run(upload(), null, a.io)).toBe(1);
    expect(expired.calls.filter((c) => c.path === "/api/seed")).toHaveLength(2);
    expect(a.err).toEqual(["At bundle TST-E0001 1/" + seedPartsOf(input, SMALL).filter((p) => p.part === "bundle" && p.kind === "exam").length + ": the log in is no longer valid (it ended or ran out). Run this again."]);
    // What went in before is listed.
    expect(a.out[0]).toBe(`Stopped before the end. Sent to ${HOST}, into the account ${NAME}, so far:`);
    expect(a.out.join("\n")).toMatch(/Courses\s+3 created/);

    const limited = app((call, nth) => (call.path === "/api/seed" && nth === 3 ? Response.json({ error: "too_many", message: "x", secret: "do not print" }, { status: 429, headers: { "Retry-After": "1500" } }) : undefined));
    const b = io(limited.fetcher);
    expect(await run(upload(), null, b.io)).toBe(1);
    expect(limited.calls.filter((c) => c.path === "/api/seed")).toHaveLength(3);
    expect(b.err).toHaveLength(1);
    expect(b.err[0]).toContain("Wait 25 minutes, then run the same command again");
    expect([...b.out, ...b.err].join("\n")).not.toContain("do not print");
    nothingSecretIn([...a.out, ...a.err, ...b.out, ...b.err], [...expired.calls, ...limited.calls]);

    // Run again after the wait: it carries on, and the account ends as one clean upload leaves it.
    const { fetcher } = app();
    expect(await run(upload(), null, io(fetcher).io)).toBe(0);
    const direct = await createTestDb();
    try {
      await applySeed(direct.db, planSeed(input), { now: NOW });
      expect(await rowCounts(t.db)).toEqual(await rowCounts(direct.db));
    } finally {
      await direct.close();
    }
  });

  it("sends a course folder again in smaller batches when a part is too large (413), once, and still prints one clean pass's counts", async () => {
    // The app takes the folder's first batch and finds its second too large, one time.
    let refused = 0;
    const tight = app((call) => {
      if (call.path !== "/api/seed" || refused > 0) return undefined;
      const part = JSON.parse(call.body) as { part: string; batch?: { n: number } };
      if (part.part !== "bundle" || part.batch?.n !== 2) return undefined;
      refused = tight.calls.length;
      return Response.json({ error: "too_large", message: "x" }, { status: 413 });
    });
    const a = io(tight.fetcher, PASSWORD, 2 * SMALL);
    expect(seedPartsOf(input, 2 * SMALL).filter((p) => p.part === "bundle" && p.kind === "exam").length).toBeGreaterThan(1);
    expect(await run(upload(), null, a.io)).toBe(0);
    expect(refused).toBe(4); // the log in, the account, batch 1, batch 2
    expect(a.err).toEqual([]);
    expect(a.out[0]).toMatch(/^bundle TST-E0001 2\/\d+ was too large for the app; sending TST-E0001 again in \d+ smaller batches\.$/);
    // The batches after the refusal are half the size.
    const after = tight.calls.slice(refused).filter((c) => c.path === "/api/seed").map((c) => Buffer.byteLength(c.body));
    expect(after.length).toBe(seedPartsOf(input, SMALL).length - 1);
    expect(after.every((n) => n <= SMALL)).toBe(true);
    expect(JSON.parse(tight.calls[refused].body)).toMatchObject({ part: "bundle", courseCode: "TST-E0001", batch: { n: 1 } });

    const direct = await createTestDb();
    try {
      const lines: string[] = [];
      expect(await run([ACCOUNT, bundles], direct.db, { out: (l) => void lines.push(l), err: (l) => void lines.push(l) })).toBe(0);
      expect(await rowCounts(t.db)).toEqual(await rowCounts(direct.db));
      expect(countLines(a.out)).toEqual(countLines(lines));
    } finally {
      await direct.close();
    }

    // An app that finds every batch of a folder too large: one more try in smaller batches, then stop.
    const never = app((call) => (call.path === "/api/seed" && call.body.startsWith('{"part":"bundle"') ? Response.json({ error: "too_large", message: "x" }, { status: 413 }) : undefined));
    const b = io(never.fetcher, PASSWORD, 2 * SMALL);
    expect(await run(upload(), null, b.io)).toBe(1);
    expect(never.calls.filter((c) => c.path === "/api/seed")).toHaveLength(3); // the account, the batch, the smaller batch
    expect(b.err).toHaveLength(1);
    expect(b.err[0]).toMatch(/^At bundle TST-E0001 1\/\d+: too large for the app, also in smaller batches\. Stopped\.$/);
  });

  it("says so when the account is connected to Moodle (409) and still sends the course folders; a folder that is not imported is not sent further", async () => {
    await t.db.insert(moodleConnections).values({ userId, siteUrl: "https://moodle.example.test", moodleUserId: 1, tokenSealed: "not-a-real-sealed-key" });
    const none = app();
    const a = io(none.fetcher);
    expect(await run(upload(), null, a.io)).toBe(0);
    // The account, then one batch of each folder: the sync has made no course, so none is imported.
    expect(none.calls.filter((c) => c.path === "/api/seed")).toHaveLength(1 + input.bundles.length);
    const said = a.out.join("\n");
    expect(said).toContain("This account is connected to the school's Moodle");
    expect(said).toContain("Bundle folder TST-E0001 (TST-E0001): not imported.");
    expect(await t.db.select().from(cards)).toHaveLength(0);

    await t.db.insert(courses).values({ userId, moodleId: 4401, code: "TST-E0001", name: "Intro to Forecasting" });
    const some = app();
    const b = io(some.fetcher);
    expect(await run(upload(), null, b.io)).toBe(0);
    expect(b.out.join("\n")).toContain("This account is connected to the school's Moodle");
    expect(b.out.join("\n")).toMatch(/Cards\s+45 created/);
    expect(await t.db.select().from(cards).where(eq(cards.userId, userId))).toHaveLength(45);
    // Nothing of the account part went in: the sync's one course is all there is.
    expect(await t.db.select().from(courses).where(eq(courses.userId, userId))).toHaveLength(1);
    expect(await t.db.select().from(assignments)).toHaveLength(0);
  });

  it("prints a refused part's problems (400) and message (403), and nothing else of the answer", async () => {
    const bad = app((call) => (call.path === "/api/seed" ? Response.json({ error: "invalid", message: "x", problems: ["account.courses.0.name: must be text.", 7, "second\nline"], secret: "do not print" }, { status: 400 }) : undefined));
    const a = io(bad.fetcher);
    expect(await run(upload(), null, a.io)).toBe(1);
    expect(bad.calls.filter((c) => c.path === "/api/seed")).toHaveLength(1);
    expect(a.out).toEqual([]);
    expect(a.err).toEqual([
      "At account: the app says this part does not fit; it wrote nothing of it. Stopped. Nothing was written.",
      "  problem: account.courses.0.name: must be text.",
      "  problem: second line",
    ]);

    // A demo account is refused by the app itself: its sentence is passed on.
    await t.db.update(users).set({ settings: { [DEMO_FLAG]: true } }).where(eq(users.id, userId));
    const demo = app();
    const b = io(demo.fetcher);
    expect(await run(upload(), null, b.io)).toBe(1);
    expect(b.err).toEqual(["At account: refused: A demo account cannot be filled from files. Stopped. Nothing was written."]);
    expect(Object.values(await rowCounts(t.db)).every((n) => n === 0)).toBe(true);
  });
});
