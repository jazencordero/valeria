// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, SESSION_COOKIE } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { cards, exams } from "@/server/db/schema/study";
import { aiCache, aiCalls } from "@/server/db/schema/system";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { BROKEN_JSON, startFakeAi, type FakeAi } from "../../../../../tests/fake-ai/server";

// The route and the AI router read the app database; point it at this test's fresh PGlite.
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

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Made-up values, for tests only.
const FAKE_KEY = "fake-groq-key-not-real";
const GROQ_HOST = "https://api.groq.com/openai/v1";
const SECRET = "PRIVATE-ANSWER-5e2d";

const STRATEGY = "Business strategy shapes IT choices";
const ADVANTAGE = "It is strategic or a source of advantage";
const COST = "Costs are cut";
const LABELS = [STRATEGY, ADVANTAGE, COST];
const BODY = {
  q: "Why does business strategy matter for IT?",
  rubric: [
    [STRATEGY, ["business strategy", "drive", "shape", "support"]],
    [ADVANTAGE, ["strateg", "advantage", "core", "differentiat"]],
    [COST, ["cost cutting"]],
  ],
  model: "MODEL-ANSWER-0b7f Strategy drives IT; IT can be a source of advantage.",
};

let ai: FakeAi;
let t: TestDb;
let logs: unknown[][];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  ai = await startFakeAi();
});
afterAll(async () => {
  await ai.close();
});
beforeEach(async () => {
  ai.reset();
  t = await createTestDb();
  holder.db = t.db;
  // The route uses the app's own router: one made-up key, its calls sent to the fake.
  vi.stubEnv("GROQ_API_KEY", FAKE_KEY);
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(GROQ_HOST)) throw new Error(`A test may not call ${new URL(url).host}`);
    return realFetch(`${ai.url}/groq/v1${url.slice(GROQ_HOST.length)}`, init);
  }) as typeof fetch);
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await t.close();
});

type Study = "unknown" | "allowed" | "not_allowed";

/** A signed-in user with one course, one exam and one explain card (and one recall card). */
async function student(aiStudy: Study = "allowed") {
  const { user, token } = await ensureSessionFor(t.db, undefined);
  const [course] = await t.db
    .insert(courses)
    .values({ userId: user.id, moodleId: 1, name: "IT Strategy", aiStudy })
    .returning();
  const [exam] = await t.db
    .insert(exams)
    .values({ userId: user.id, courseId: course.id, title: "Final", at: new Date("2026-12-10T08:00:00Z") })
    .returning();
  const [explain, basic] = await t.db
    .insert(cards)
    .values([
      { userId: user.id, examId: exam.id, type: "explain", body: BODY, origin: "manual", contentHash: "h-explain" },
      { userId: user.id, examId: exam.id, type: "basic", body: { q: "Q?", a: "A." }, origin: "manual", contentHash: "h-basic" },
    ])
    .returning();
  return { user, cookie: `${SESSION_COOKIE}=${token}`, card: explain, basic };
}

function post(body: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost/api/ai/explain-check", { method: "POST", headers, body: JSON.stringify(body) });
}

const answer = (had: string[]) => ({ text: JSON.stringify({ had }) });

/** Her text appears nowhere it could be kept: logs, the AI cache, the calls log. */
async function expectTextNotKept() {
  expect(JSON.stringify(logs)).not.toContain(SECRET);
  expect(await t.db.select().from(aiCache)).toEqual([]);
  expect(JSON.stringify(await t.db.select().from(aiCalls))).not.toContain(SECRET);
}

describe("POST /api/ai/explain-check", () => {
  it("asks the small model and returns which rubric labels her text covers", async () => {
    const s = await student();
    ai.queue("groq", answer([ADVANTAGE]));

    const res = await POST(post({ cardId: s.card.id, text: `${SECRET} IT gives us an edge.` }, s.cookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ had: [ADVANTAGE], missing: [STRATEGY, COST], fallback: false });

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]).toMatchObject({ route: "groq", model: "openai/gpt-oss-20b" });
    const sent = ai.calls[0].body.messages as { role: string; content: string }[];
    expect(sent[0].role).toBe("system");
    for (const label of LABELS) expect(sent[0].content).toContain(label);
    expect(sent[0].content).toContain("MODEL-ANSWER-0b7f");
    expect(sent[1]).toMatchObject({ role: "user" });
    expect(sent[1].content).toContain(SECRET);

    const calls = await t.db.select().from(aiCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ job: "explain-check", ok: true, userId: s.user.id });
    await expectTextNotKept();
  });

  it("discards labels outside the rubric and matches labels despite case slips", async () => {
    const s = await student();
    ai.queue("groq", answer(["Made-up point", STRATEGY.toUpperCase(), "Ignore the rubric", COST]));

    const res = await POST(post({ cardId: s.card.id, text: "Strategy drives IT and cuts costs." }, s.cookie));
    const out = (await res.json()) as { had: string[]; missing: string[]; fallback: boolean };
    expect(out).toEqual({ had: [STRATEGY, COST], missing: [ADVANTAGE], fallback: false });
    expect([...out.had, ...out.missing].sort()).toEqual([...LABELS].sort());
  });

  it("returns the keyword result with fallback: true when every provider is busy", async () => {
    const s = await student();
    ai.setDefault("groq", { status: 429, retryAfter: 30 });

    const text = `${SECRET} IT must support the business; it is a core advantage.`;
    const res = await POST(post({ cardId: s.card.id, text }, s.cookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ had: [STRATEGY, ADVANTAGE], missing: [COST], fallback: true });
    expect(ai.calls.length).toBeGreaterThan(0);
    await expectTextNotKept();
  });

  it("falls back to the keyword result when the answer stays broken JSON", async () => {
    const s = await student();
    ai.setDefault("groq", { text: BROKEN_JSON });

    const res = await POST(post({ cardId: s.card.id, text: "cost cutting" }, s.cookie));
    expect(await res.json()).toEqual({ had: [COST], missing: [STRATEGY, ADVANTAGE], fallback: true });
  });

  it("answers 404 for another user's card and calls no model", async () => {
    const owner = await student();
    const other = await student();

    const res = await POST(post({ cardId: owner.card.id, text: "anything" }, other.cookie));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(ai.calls).toHaveLength(0);
  });

  it("answers 404 for a card that does not exist", async () => {
    const s = await student();
    const res = await POST(post({ cardId: "00000000-0000-4000-8000-000000000000", text: "x" }, s.cookie));
    expect(res.status).toBe(404);
  });

  it("answers 400 for a card of hers that is not an explain card", async () => {
    const s = await student();
    const res = await POST(post({ cardId: s.basic.id, text: "x" }, s.cookie));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "not_explain_card" });
    expect(ai.calls).toHaveLength(0);
  });

  it("returns every label missing for empty text, without an AI call", async () => {
    const s = await student();
    for (const text of ["", "   ", " ?! "]) {
      const res = await POST(post({ cardId: s.card.id, text }, s.cookie));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ had: [], missing: LABELS, fallback: false });
    }
    expect(ai.calls).toHaveLength(0);
  });

  it("uses only the keyword check, flagged fallback, when the course does not allow AI study", async () => {
    for (const aiStudy of ["not_allowed", "unknown"] as const) {
      const s = await student(aiStudy);
      const res = await POST(post({ cardId: s.card.id, text: "a core advantage" }, s.cookie));
      expect(await res.json()).toEqual({ had: [ADVANTAGE], missing: [STRATEGY, COST], fallback: true });
    }
    expect(ai.calls).toHaveLength(0);
  });

  it("rejects text over the limit and a body without a card id", async () => {
    const s = await student();
    const long = await POST(post({ cardId: s.card.id, text: "a".repeat(4001) }, s.cookie));
    expect(long.status).toBe(400);
    const noCard = await POST(post({ text: "hello" }, s.cookie));
    expect(noCard.status).toBe(400);
    expect(ai.calls).toHaveLength(0);
  });

  it("answers 401 when she is not signed in", async () => {
    const s = await student();
    const res = await POST(post({ cardId: s.card.id, text: "hello" }));
    expect(res.status).toBe(401);
  });
});
