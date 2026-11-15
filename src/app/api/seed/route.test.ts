// @vitest-environment node
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, newToken, SESSION_COOKIE } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { events } from "@/server/db/schema/calendar";
import { courses } from "@/server/db/schema/courses";
import { gradeItems } from "@/server/db/schema/grades";
import { lectureContent, lectures } from "@/server/db/schema/learn";
import { moodleConnections } from "@/server/db/schema/moodle";
import { cards, cardStates, concepts, examDocuments, exams } from "@/server/db/schema/study";
import { users } from "@/server/db/schema/users";
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

async function signIn(): Promise<{ userId: string; cookie: string }> {
  const { user, token } = await ensureSessionFor(t.db, newToken());
  return { userId: user.id, cookie: `other=1; ${SESSION_COOKIE}=${token}` };
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
