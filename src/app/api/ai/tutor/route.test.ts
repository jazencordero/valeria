// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, SESSION_COOKIE } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { lectureContent, lectures } from "@/server/db/schema/learn";
import { aiCalls, providerCooldowns } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import { assignments } from "@/server/db/schema/work";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { TUTOR_RESTING } from "@/server/tutor/context";
import { startFakeAi, type FakeAi } from "../../../../../tests/fake-ai/server";

// The route, the context and the AI router all read the app database: point it at this test's PGlite.
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
const GROQ_HOST = "https://api.groq.com/openai/v1";
const OPENROUTER_HOST = "https://openrouter.ai/api/v1";
const ANTHROPIC_HOST = "https://api.anthropic.com";
const ANTHROPIC_KEY = "fake-anthropic-key-not-real";
const QUESTION = "PRIVATE-QUESTION-5d2e what is a discount rate?";

let ai: FakeAi;
let t: TestDb;
let logs: unknown[][];
/** What Anthropic's address answers in this test; null: it must not be called. */
let anthropic: (() => Response) | null;
let anthropicCalls: { headers: Record<string, string>; body: Record<string, unknown> }[];

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
  anthropic = null;
  anthropicCalls = [];
  vi.stubEnv("GROQ_API_KEY", "fake-groq-key-not-real");
  vi.stubEnv("OPENROUTER_API_KEY", "fake-openrouter-key-not-real");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("AI_FAKE_URL", "");
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(GROQ_HOST)) return realFetch(`${ai.url}/groq/v1${url.slice(GROQ_HOST.length)}`, init);
    if (url.startsWith(OPENROUTER_HOST)) return realFetch(`${ai.url}/openrouter/v1${url.slice(OPENROUTER_HOST.length)}`, init);
    if (url.startsWith(ANTHROPIC_HOST)) {
      if (!anthropic) throw new Error("This test may not call Anthropic");
      anthropicCalls.push({
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return anthropic();
    }
    throw new Error(`A test may not call ${new URL(url).host}`);
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
type Help = "unknown" | "off" | "explain" | "allowed";

/** A signed-in student with one course, lecture 1 (one section) and one assignment. */
async function student(opts: { tutor?: boolean; study?: Study; help?: Help } = {}) {
  const { user, token } = await ensureSessionFor(t.db, undefined);
  if (opts.tutor !== false) await t.db.update(users).set({ settings: { tutor: { enabled: true } } }).where(eq(users.id, user.id));
  const [course] = await t.db
    .insert(courses)
    .values({ userId: user.id, moodleId: 1, name: "Corporate Finance", aiStudy: opts.study ?? "allowed", aiAssignments: opts.help ?? "explain" })
    .returning();
  const [lecture] = await t.db.insert(lectures).values({ userId: user.id, courseId: course.id, n: 1, title: "Time value" }).returning();
  await t.db.insert(lectureContent).values({
    lectureId: lecture.id,
    sourceHash: "h",
    sections: [{ heading: "Discounting", blocks: [["p", "LECTURE-TEXT-8a1f a euro today beats a euro tomorrow."]], keyPoints: ["KEY-POINT-2b"] }],
  });
  const [assignment] = await t.db
    .insert(assignments)
    .values({ userId: user.id, courseId: course.id, moodleId: 1, name: "ASSIGNMENT-NAME-77 Problem set", introHtml: "<p>BRIEF-TEXT-66</p>" })
    .returning();
  return { user, cookie: `${SESSION_COOKIE}=${token}`, course, assignment };
}

function post(body: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost/api/ai/tutor", { method: "POST", headers, body: JSON.stringify(body) });
}

async function chunks(res: Response): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const line of (await res.text()).split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    out.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
  }
  return out;
}
const answerOf = async (res: Response) =>
  (await chunks(res))
    .filter((p) => p.type === "text-delta")
    .map((p) => p.delta)
    .join("");

type Sent = { role: string; content: string };
const sent = (call: number) => ai.calls[call].body.messages as Sent[];
const OTHER = { kind: "other" as const };

function anthropicSse(text: string): Response {
  const ev = (data: unknown) => `event: x\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response(
    ev({ type: "message_start", message: { id: "m", model: "claude-fable-5-2", usage: { input_tokens: 5 } } }) +
      ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
      ev({ type: "content_block_stop", index: 0 }) +
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) +
      ev({ type: "message_stop" }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("POST /api/ai/tutor", () => {
  it("a user without the switch gets 404 and nothing is sent; signed out is 401", async () => {
    const s = await student({ tutor: false });
    const res = await POST(post({ text: QUESTION, where: OTHER }, s.cookie));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    const copy = await POST(post({ mode: "copy", text: QUESTION, where: OTHER }, s.cookie));
    expect(copy.status).toBe(404);
    expect(ai.calls).toHaveLength(0);
    expect((await POST(post({ text: QUESTION, where: OTHER }))).status).toBe(401);
  });

  it("with the switch and no key, it streams from the free providers and nothing calls Anthropic", async () => {
    const s = await student();
    ai.queue("groq", { text: "Discounting means money later is worth less now." });
    const res = await POST(post({ text: QUESTION, where: { kind: "lecture", courseId: s.course.id, n: 1, section: 0 } }, s.cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await answerOf(res)).toBe("Discounting means money later is worth less now.");
    expect(anthropicCalls).toHaveLength(0);

    expect(ai.calls[0]).toMatchObject({ route: "groq", model: "openai/gpt-oss-120b", stream: true });
    const body = ai.calls[0].body as { max_tokens?: number; max_completion_tokens?: number };
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(1500);
    const messages = sent(0);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Start from zero");
    expect(messages[0].content).toContain("LECTURE-TEXT-8a1f");
    expect(messages.slice(1)).toEqual([{ role: "user", content: QUESTION }]);

    await vi.waitFor(async () => expect(await t.db.select().from(aiCalls)).toHaveLength(1));
    expect(await t.db.select().from(aiCalls)).toMatchObject([{ provider: "groq", job: "tutor", ok: true }]);
    expect(JSON.stringify(logs)).not.toContain("PRIVATE-QUESTION");
  });

  it("with a working key, Claude answers first", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY);
    anthropic = () => anthropicSse("From Claude.");
    const s = await student();
    const res = await POST(post({ text: QUESTION, where: { kind: "lecture", courseId: s.course.id, n: 1 } }, s.cookie));
    expect(await answerOf(res)).toBe("From Claude.");
    expect(ai.calls).toHaveLength(0);
    expect(anthropicCalls).toHaveLength(1);
    const system = anthropicCalls[0].body.system as { text: string; cache_control?: unknown }[];
    expect(system.find((p) => p.cache_control)?.text).toContain("LECTURE-TEXT-8a1f");
    await vi.waitFor(async () => expect(await t.db.select().from(aiCalls)).toHaveLength(1));
    expect(await t.db.select().from(aiCalls)).toMatchObject([{ provider: "anthropic", model: "claude-fable-5-2", job: "tutor", ok: true }]);
  });

  for (const code of [401, 403, 429, 500]) {
    it(`a key that gets ${code} never breaks the tutor: the free providers answer`, async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY);
      anthropic = () => Response.json({ type: "error", error: { type: "x" } }, { status: code });
      ai.queue("groq", { text: "Free answer." });
      const s = await student();
      const res = await POST(post({ text: QUESTION, where: OTHER }, s.cookie));
      expect(res.status).toBe(200);
      expect(await answerOf(res)).toBe("Free answer.");
      expect(anthropicCalls).toHaveLength(1);
    });
  }

  it("a key whose network call fails also falls back", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY);
    anthropic = () => {
      throw new TypeError("fetch failed");
    };
    ai.queue("groq", { text: "Still here." });
    const s = await student();
    expect(await answerOf(await POST(post({ text: QUESTION, where: OTHER }, s.cookie)))).toBe("Still here.");
  });

  it("every provider busy: 503 with the resting line, exactly", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY);
    anthropic = () => Response.json({}, { status: 529 });
    ai.queue("groq", { status: 429 });
    ai.queue("openrouter", { status: 503 });
    const s = await student();
    const res = await POST(post({ text: QUESTION, where: OTHER }, s.cookie));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "tutor_resting", message: "The tutor is resting. Try again in a minute." });
    expect(TUTOR_RESTING).toBe("The tutor is resting. Try again in a minute.");
    await t.db.delete(providerCooldowns);
  });

  for (const study of ["unknown", "not_allowed"] as const) {
    it(`a course whose study rule is "${study}" sends no course text`, async () => {
      const s = await student({ study });
      ai.queue("groq", { text: "General answer." });
      await (await POST(post({ text: QUESTION, where: { kind: "lecture", courseId: s.course.id, n: 1, section: 0 } }, s.cookie))).text();
      const system = sent(0)[0].content;
      expect(system).not.toContain("LECTURE-TEXT-8a1f");
      expect(system).not.toContain("KEY-POINT-2b");
      expect(system).toContain("not using her course material");
    });
  }

  it("an assignment question for a course with help off is declined: no assignment data, the rule is there", async () => {
    const s = await student({ help: "off" });
    ai.queue("groq", { text: "That course does not allow AI help on its assignments." });
    await (
      await POST(post({ text: "Solve problem 2 of my problem set", where: { kind: "assignment", assignmentId: s.assignment.id } }, s.cookie))
    ).text();
    const system = sent(0)[0].content;
    expect(system).not.toContain("ASSIGNMENT-NAME-77");
    expect(system).not.toContain("BRIEF-TEXT-66");
    expect(system).toContain("Do not discuss their assignments at all");
    expect(system).toContain("Corporate Finance");
    expect(system).toContain("Never write an answer to an assignment");
  });

  it("refuses a message over 4,000 characters, and an empty one", async () => {
    const s = await student();
    expect((await POST(post({ text: "x".repeat(4001), where: OTHER }, s.cookie))).status).toBe(400);
    expect((await POST(post({ text: "   ", where: OTHER }, s.cookie))).status).toBe(400);
    expect(ai.calls).toHaveLength(0);
  });

  it("sends at most the last 20 messages, starting with one of hers", async () => {
    const s = await student();
    const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", text: `turn ${i}` }));
    ai.queue("groq", { text: "ok" });
    await (await POST(post({ text: QUESTION, where: OTHER, history }, s.cookie))).text();
    const messages = sent(0).slice(1);
    expect(messages.length).toBeLessThanOrEqual(20);
    expect(messages[0].role).toBe("user");
    expect(messages.at(-1)).toEqual({ role: "user", content: QUESTION });
    expect(messages.at(-2)).toEqual({ role: "assistant", content: "turn 29" });
  });

  it("abuse guard: the 31st tutor call within a minute is refused; there is no daily cap", async () => {
    const s = await student();
    // 200 earlier today (more than any old daily cap), 29 in the last minute.
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await t.db.insert(aiCalls).values(Array.from({ length: 200 }, () => ({ provider: "groq", model: "m", job: "tutor", ok: true, ms: 1, userId: s.user.id, createdAt: old })));
    await t.db.insert(aiCalls).values(Array.from({ length: 29 }, () => ({ provider: "groq", model: "m", job: "tutor", ok: true, ms: 1, userId: s.user.id })));
    ai.queue("groq", { text: "thirtieth" });
    const ok = await POST(post({ text: QUESTION, where: OTHER }, s.cookie));
    expect(ok.status).toBe(200);
    expect(await answerOf(ok)).toBe("thirtieth");
    await vi.waitFor(async () => expect(await t.db.select().from(aiCalls)).toHaveLength(230));

    const refused = await POST(post({ text: QUESTION, where: OTHER }, s.cookie));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "slow_down" });
    expect(ai.calls).toHaveLength(1);
  });

  it("copy mode returns the study prompt and calls no AI", async () => {
    const s = await student();
    const res = await POST(post({ mode: "copy", text: "What is NPV?", where: { kind: "lecture", courseId: s.course.id, n: 1, section: 0 } }, s.cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; note: string | null };
    expect(body.text).toContain("Explain from zero");
    expect(body.text).toContain("My question: What is NPV?");
    expect(body.text).toContain("LECTURE-TEXT-8a1f");
    expect(body.note).toBeNull();
    expect(ai.calls).toHaveLength(0);
    expect(await t.db.select().from(aiCalls)).toHaveLength(0);
  });

  it("copy mode for a course that does not allow AI for study: no course text, and a note", async () => {
    const s = await student({ study: "not_allowed" });
    const res = await POST(post({ mode: "copy", text: "What is NPV?", where: { kind: "lecture", courseId: s.course.id, n: 1 } }, s.cookie));
    const body = (await res.json()) as { text: string; note: string | null };
    expect(body.text).not.toContain("LECTURE-TEXT-8a1f");
    expect(body.note).toContain("Copied without course text");
  });
});
