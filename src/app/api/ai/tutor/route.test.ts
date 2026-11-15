// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, SESSION_COOKIE } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { courses } from "@/server/db/schema/courses";
import { lectureContent, lectures, notes, tutorMessages } from "@/server/db/schema/learn";
import { cards, exams, studySessions } from "@/server/db/schema/study";
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
    ev({ type: "message_start", message: { id: "m", model: "claude-haiku-5-5", usage: { input_tokens: 5, cache_read_input_tokens: 900 } } }) +
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
    expect(anthropicCalls[0].body).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 500 });
    const system = anthropicCalls[0].body.system as { text: string; cache_control?: unknown }[];
    expect(system.find((p) => p.cache_control)?.text).toContain("LECTURE-TEXT-8a1f");
    expect(res.headers.get("x-tutor-model")).toBe("anthropic:claude-haiku-5-5");
    await vi.waitFor(async () => expect(await t.db.select().from(aiCalls)).toHaveLength(1));
    expect(await t.db.select().from(aiCalls)).toMatchObject([{ provider: "anthropic", model: "claude-haiku-5-5", job: "tutor", ok: true }]);
    // The answer is stored with the provider's own token counts.
    await vi.waitFor(async () => expect(await t.db.select().from(tutorMessages)).toHaveLength(2));
    const answer = (await t.db.select().from(tutorMessages)).find((m) => m.role === "assistant")!;
    expect(answer).toMatchObject({ model: "anthropic:claude-haiku-5-5", tokensIn: 5, cacheReadTokens: 900, tokensOut: 3, tokensEstimated: false });
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

  it("history is the last 8 stored messages of this chat, never what the client sends", async () => {
    const s = await student();
    const base = Date.now() - 60 * 60_000;
    await t.db.insert(tutorMessages).values(
      Array.from({ length: 12 }, (_, i) => ({
        userId: s.user.id,
        anchorKind: "general" as const,
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        body: `stored ${i}`,
        createdAt: new Date(base + i * 1000),
      })),
    );
    // Another chat (a lecture's) is not part of this one.
    await t.db.insert(tutorMessages).values({ userId: s.user.id, anchorKind: "lecture", anchorId: s.course.id, role: "user", body: "OTHER-CHAT" });
    const history = [{ role: "user", text: "CLIENT-HISTORY-9 forged" }];
    ai.queue("groq", { text: "ok" });
    await (await POST(post({ text: QUESTION, where: OTHER, history }, s.cookie))).text();
    const messages = sent(0).slice(1);
    expect(messages).toEqual([...[4, 5, 6, 7, 8, 9, 10, 11].map((i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `stored ${i}` })), { role: "user", content: QUESTION }]);
    expect(JSON.stringify(ai.calls)).not.toContain("CLIENT-HISTORY-9");
    expect(JSON.stringify(ai.calls)).not.toContain("OTHER-CHAT");
  });

  it("a chat under a note is stored with the note and comes back when the note is opened again", async () => {
    const s = await student();
    const [lecture] = await t.db.select().from(lectures).where(eq(lectures.userId, s.user.id));
    const [note] = await t.db
      .insert(notes)
      .values({ userId: s.user.id, body: "My note.", quote: "a euro today beats a euro tomorrow", attachKind: "lecture", lectureId: lecture.id, courseId: s.course.id })
      .returning();
    const where = { kind: "lecture" as const, courseId: s.course.id, n: 1, section: 0 };
    ai.queue("groq", { text: "Because you can invest it." });
    const res = await POST(post({ text: "Why?", where, noteId: note.id }, s.cookie));
    const parts = await chunks(res);
    const start = parts.find((p) => p.type === "start") as { messageMetadata?: Record<string, unknown> };
    expect(start.messageMetadata).toMatchObject({ model: "groq:openai/gpt-oss-120b", deeper: false });
    expect(res.headers.get("x-tutor-model")).toBe("groq:openai/gpt-oss-120b");
    // The note's quote is the passage: it is her lecture's text, so it goes first, as course text.
    const system = sent(0)[0].content;
    expect(system).toContain("The passage she highlighted");
    expect(system.indexOf("The passage she highlighted")).toBeLessThan(system.indexOf("LECTURE-TEXT-8a1f"));

    await vi.waitFor(async () => expect(await t.db.select().from(tutorMessages)).toHaveLength(2));
    const rows = await t.db.select().from(tutorMessages);
    expect(rows.every((r) => r.noteId === note.id && r.userId === s.user.id)).toBe(true);
    const answer = rows.find((r) => r.role === "assistant")!;
    expect(answer.id).toBe(start.messageMetadata?.answerId);
    // The fake gives no usage on streams: an estimate by characters, marked.
    expect(answer).toMatchObject({ model: "groq:openai/gpt-oss-120b", tokensEstimated: true });
    expect(answer.tokensOut).toBe(Math.ceil("Because you can invest it.".length / 4));
    expect(rows.find((r) => r.role === "user")).toMatchObject({ body: "Why?", quote: "a euro today beats a euro tomorrow" });

    const loaded = await POST(post({ mode: "load", where, noteId: note.id }, s.cookie));
    expect(loaded.status).toBe(200);
    const body = (await loaded.json()) as { messages: { role: string; text: string; model: string | null }[]; deeperAvailable: boolean };
    expect(body.messages.map((m) => [m.role, m.text, m.model])).toEqual([
      ["user", "Why?", null],
      ["assistant", "Because you can invest it.", "groq:openai/gpt-oss-120b"],
    ]);
    expect(body.deeperAvailable).toBe(false);
    // The same place without the note is another chat.
    const plain = (await (await POST(post({ mode: "load", where }, s.cookie))).json()) as { messages: unknown[] };
    expect(plain.messages).toEqual([]);

    // "Save to note" appends the answer to the note.
    const saved = await POST(post({ mode: "save", noteId: note.id, answerId: answer.id }, s.cookie));
    expect(await saved.json()).toEqual({ ok: true, body: "My note.\n\nBecause you can invest it." });
    expect(ai.calls).toHaveLength(1);
  });

  it("someone else's note, or answer, is not found", async () => {
    const s = await student();
    const other = await student();
    const [theirs] = await t.db.insert(notes).values({ userId: other.user.id, body: "THEIR-NOTE" }).returning();
    for (const body of [
      { text: QUESTION, where: OTHER, noteId: theirs.id },
      { mode: "load", where: OTHER, noteId: theirs.id },
      { mode: "save", noteId: theirs.id, answerId: theirs.id },
    ]) {
      expect((await POST(post(body, s.cookie))).status).toBe(404);
    }
    const [mine] = await t.db.insert(notes).values({ userId: s.user.id, body: "" }).returning();
    const [theirAnswer] = await t.db.insert(tutorMessages).values({ userId: other.user.id, anchorKind: "general", role: "assistant", body: "THEIR-ANSWER" }).returning();
    expect((await POST(post({ mode: "save", noteId: mine.id, answerId: theirAnswer.id }, s.cookie))).status).toBe(404);
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY);
    expect((await POST(post({ deeper: true, answerId: theirAnswer.id, where: OTHER }, s.cookie))).status).toBe(404);
    expect(ai.calls).toHaveLength(0);
    expect(anthropicCalls).toHaveLength(0);
  });

  it("past the monthly budget the tutor answers from the free models and never calls Anthropic", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY);
    vi.stubEnv("TUTOR_BUDGET_EUR", "1");
    anthropic = () => anthropicSse("never");
    const s = await student();
    // 2 million Fable output tokens this month: about 74 EUR, far past a 1 EUR budget.
    await t.db.insert(tutorMessages).values({ userId: s.user.id, anchorKind: "general", role: "assistant", body: "old", model: "anthropic:claude-fable-5-2", tokensIn: 0, tokensOut: 2_000_000 });
    ai.queue("groq", { text: "Free over budget." });
    const res = await POST(post({ text: QUESTION, where: OTHER }, s.cookie));
    expect(await answerOf(res)).toBe("Free over budget.");
    expect(anthropicCalls).toHaveLength(0);
    // And "Go deeper" is not offered.
    const load = (await (await POST(post({ mode: "load", where: OTHER }, s.cookie))).json()) as { deeperAvailable: boolean };
    expect(load.deeperAvailable).toBe(false);
  });

  it("Go deeper reruns that one question on Claude Fable 5.2 and stores the new answer under it", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY);
    anthropic = () => anthropicSse("Small answer.");
    const s = await student();
    const first = await chunks(await POST(post({ text: "What is NPV?", where: OTHER }, s.cookie)));
    const meta = (first.find((p) => p.type === "start") as { messageMetadata: { answerId: string; questionId: string } }).messageMetadata;
    await vi.waitFor(async () => expect(await t.db.select().from(tutorMessages)).toHaveLength(2));
    anthropic = () => anthropicSse("A second one.");
    await (await POST(post({ text: "And IRR?", where: OTHER }, s.cookie))).text();
    await vi.waitFor(async () => expect(await t.db.select().from(tutorMessages)).toHaveLength(4));
    const load1 = (await (await POST(post({ mode: "load", where: OTHER }, s.cookie))).json()) as { deeperAvailable: boolean };
    expect(load1.deeperAvailable).toBe(true);

    anthropic = () => anthropicSse("Deeper answer.");
    const deep = await POST(post({ deeper: true, answerId: meta.answerId, where: OTHER }, s.cookie));
    expect(await answerOf(deep)).toBe("Deeper answer.");
    const call = anthropicCalls.at(-1)!;
    expect(call.body).toMatchObject({ model: "claude-fable-5-2", max_tokens: 1200 });
    // The same question again, with only what came before it as history.
    expect(call.body.messages).toEqual([{ role: "user", content: "What is NPV?" }]);
    // Only her explicit choice ("Go deeper" here) ever reached the large model.
    expect(anthropicCalls.map((c) => c.body.model)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5", "claude-fable-5-2"]);

    await vi.waitFor(async () => expect(await t.db.select().from(tutorMessages)).toHaveLength(5));
    const loaded = (await (await POST(post({ mode: "load", where: OTHER }, s.cookie))).json()) as { messages: { role: string; text: string; replyTo: string | null }[] };
    expect(loaded.messages.map((m) => m.text)).toEqual(["What is NPV?", "Small answer.", "Deeper answer.", "And IRR?", "A second one."]);
    expect(loaded.messages[2].replyTo).toBe(meta.questionId);
  });

  it("the picker's level picks the model on the server: Quick by default, Balanced Sonnet 5.5, Deep Fable 5.2", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY);
    anthropic = () => anthropicSse("Answer.");
    const s = await student();
    for (const level of [undefined, "quick", "balanced", "deep"]) {
      const res = await POST(post({ text: QUESTION, where: OTHER, ...(level ? { level } : {}) }, s.cookie));
      expect(await answerOf(res)).toBe("Answer.");
    }
    expect(anthropicCalls.map((c) => [c.body.model, c.body.max_tokens])).toEqual([
      ["claude-haiku-5-5", 500],
      ["claude-haiku-5-5", 500],
      ["claude-sonnet-5-5", 800],
      ["claude-fable-5-2", 1200],
    ]);
    const load = (await (await POST(post({ mode: "load", where: OTHER }, s.cookie))).json()) as { paidLevels: boolean; deeperAvailable: boolean };
    expect(load).toMatchObject({ paidLevels: true, deeperAvailable: true });
  });

  it("the client can never name a model: anything but the three levels is refused before anything is sent", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY);
    anthropic = () => anthropicSse("never");
    const s = await student();
    for (const level of ["claude-fable-5-2", "max", "", 3]) {
      expect((await POST(post({ text: QUESTION, where: OTHER, level }, s.cookie))).status).toBe(400);
    }
    expect(anthropicCalls).toHaveLength(0);
    expect(ai.calls).toHaveLength(0);
  });

  it("with no key a chosen level is ignored: the free models answer and nothing calls Anthropic", async () => {
    const s = await student();
    ai.queue("groq", { text: "Free deep." });
    const res = await POST(post({ text: QUESTION, where: OTHER, level: "deep" }, s.cookie));
    expect(await answerOf(res)).toBe("Free deep.");
    expect(anthropicCalls).toHaveLength(0);
    const load = (await (await POST(post({ mode: "load", where: OTHER }, s.cookie))).json()) as { paidLevels: boolean };
    expect(load.paidLevels).toBe(false);
  });

  describe("usage mode", () => {
    it("is 404 without the tutor switch, and null without a key; it calls no AI", async () => {
      const off = await student({ tutor: false });
      expect((await POST(post({ mode: "usage" }, off.cookie))).status).toBe(404);
      const s = await student();
      const res = await POST(post({ mode: "usage" }, s.cookie));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ meter: null });
      const load = (await (await POST(post({ mode: "load", where: OTHER }, s.cookie))).json()) as { meter: unknown };
      expect(load.meter).toBeNull();
      expect(ai.calls).toHaveLength(0);
    });

    it("the bar is everyone's spend against the one budget; the estimates are from her own answers", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY);
      vi.stubEnv("TUTOR_BUDGET_EUR", "100");
      const s = await student();
      const other = await student();
      const row = (userId: string, model: string, out: number) => ({
        userId,
        anchorKind: "general" as const,
        role: "assistant" as const,
        body: "a",
        model,
        tokensIn: 0,
        tokensOut: out,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      // Someone else: 500K Fable output tokens (20 USD). Her: two Quick answers of 1,000 output tokens.
      await t.db.insert(tutorMessages).values([
        row(other.user.id, "anthropic:claude-fable-5-2", 500_000),
        row(s.user.id, "anthropic:claude-haiku-5-5", 1000),
        row(s.user.id, "anthropic:claude-haiku-5-5", 1000),
      ]);
      const { meter } = (await (await POST(post({ mode: "usage" }, s.cookie))).json()) as {
        meter: { usedEur: number; budgetEur: number; fraction: number; resetsOn: string; paidAvailable: boolean; levels: Record<string, { answersLeft: number; basis: string }> };
      };
      const used = (20 + 0.001) * 0.92;
      expect(meter.usedEur).toBeCloseTo(used, 6);
      expect(meter).toMatchObject({ budgetEur: 100, paidAvailable: true });
      expect(meter.fraction).toBeCloseTo(used / 100, 6);
      expect(meter.resetsOn).toMatch(/^\d{4}-\d{2}-01$/);
      // Her Quick answer costs 1,000 x 0.50 USD / 1M = 0.0005 USD.
      expect(meter.levels.quick).toEqual({ answersLeft: Math.floor((100 - used) / (0.0005 * 0.92)), basis: "own" });
      expect(meter.levels.balanced.basis).toBe("default");
      expect(meter.levels.deep.basis).toBe("default");
      expect(meter.levels.balanced.answersLeft).toBeGreaterThan(meter.levels.deep.answersLeft);
      // The load answer carries the same meter, so the chip needs no second request.
      const load = (await (await POST(post({ mode: "load", where: OTHER }, s.cookie))).json()) as { meter: typeof meter };
      expect(load.meter).toEqual(meter);
      expect(anthropicCalls).toHaveLength(0);
      expect(ai.calls).toHaveLength(0);
    });
  });

  it("Go deeper without a key is unavailable: 409, nothing sent", async () => {
    const s = await student();
    const [q] = await t.db.insert(tutorMessages).values({ userId: s.user.id, anchorKind: "general", role: "user", body: "Q" }).returning();
    const [a] = await t.db.insert(tutorMessages).values({ userId: s.user.id, anchorKind: "general", role: "assistant", body: "A", replyTo: q.id }).returning();
    const res = await POST(post({ deeper: true, answerId: a.id, where: OTHER }, s.cookie));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "deeper_unavailable" });
    expect(ai.calls).toHaveLength(0);
    expect(anthropicCalls).toHaveLength(0);
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

  describe("the course's study rule (asked once in the chat)", () => {
    /** An exam of her course, a study session for it and one card. */
    async function examOf(s: { user: { id: string }; course: { id: string } }) {
      const [exam] = await t.db.insert(exams).values({ userId: s.user.id, courseId: s.course.id, title: "Midterm", at: new Date("2026-12-01T09:00:00Z") }).returning();
      const [card] = await t.db
        .insert(cards)
        .values({ userId: s.user.id, examId: exam.id, type: "basic", body: { type: "basic", q: "Q", a: "A" }, origin: "ai", contentHash: `c-${s.user.id}` })
        .returning();
      const [session] = await t.db.insert(studySessions).values({ userId: s.user.id, examId: exam.id, mode: "bite" }).returning();
      return { exam, card, session };
    }
    const ruleOf = async (courseId: string) =>
      (await t.db.select({ aiStudy: courses.aiStudy }).from(courses).where(eq(courses.id, courseId)))[0].aiStudy;

    it("load returns the course in view and its rule for a lecture, an exam and a card; null elsewhere", async () => {
      const s = await student({ study: "unknown" });
      const { exam, card, session } = await examOf(s);
      const study = { courseId: s.course.id, courseName: "Corporate Finance", rule: "unknown" };
      const load = async (where: unknown) => ((await (await POST(post({ mode: "load", where }, s.cookie))).json()) as { study: unknown }).study;
      expect(await load({ kind: "lecture", courseId: s.course.id, n: 1, section: 0 })).toEqual(study);
      expect(await load({ kind: "exam", examId: exam.id })).toEqual(study);
      expect(await load({ kind: "study", sessionId: session.id, cardId: card.id, revealed: true })).toEqual(study);
      expect(await load({ kind: "assignment", assignmentId: s.assignment.id })).toBeNull();
      expect(await load(OTHER)).toBeNull();
      expect(ai.calls).toHaveLength(0);
    });

    it("someone else's course is not in view, and setting its rule is 404 and changes nothing", async () => {
      const s = await student({ study: "unknown" });
      const them = await student({ study: "unknown" });
      const theirs = await examOf(them);
      const load = (await (await POST(post({ mode: "load", where: { kind: "exam", examId: theirs.exam.id } }, s.cookie))).json()) as { study: unknown };
      expect(load.study).toBeNull();
      const lecture = (await (await POST(post({ mode: "load", where: { kind: "lecture", courseId: them.course.id, n: 1 } }, s.cookie))).json()) as {
        study: unknown;
      };
      expect(lecture.study).toBeNull();
      const res = await POST(post({ mode: "study-rule", courseId: them.course.id, rule: "allowed" }, s.cookie));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect(await ruleOf(them.course.id)).toBe("unknown");
    });

    it("study-rule stores allowed or not_allowed for her course, with no AI call; anything else is refused", async () => {
      const s = await student({ study: "unknown" });
      const yes = await POST(post({ mode: "study-rule", courseId: s.course.id, rule: "allowed" }, s.cookie));
      expect(yes.status).toBe(200);
      expect(await yes.json()).toEqual({ ok: true, rule: "allowed" });
      expect(await ruleOf(s.course.id)).toBe("allowed");
      const no = await POST(post({ mode: "study-rule", courseId: s.course.id, rule: "not_allowed" }, s.cookie));
      expect(await no.json()).toEqual({ ok: true, rule: "not_allowed" });
      expect(await ruleOf(s.course.id)).toBe("not_allowed");
      expect((await POST(post({ mode: "study-rule", courseId: s.course.id, rule: "unknown" }, s.cookie))).status).toBe(400);
      expect((await POST(post({ mode: "study-rule", courseId: "nope", rule: "allowed" }, s.cookie))).status).toBe(400);
      expect((await POST(post({ mode: "study-rule", rule: "allowed" }, s.cookie))).status).toBe(400);
      expect(await ruleOf(s.course.id)).toBe("not_allowed");
      expect(ai.calls).toHaveLength(0);
      expect(await t.db.select().from(aiCalls)).toHaveLength(0);
    });

    it("without the tutor switch, study-rule is 404 and changes nothing", async () => {
      const s = await student({ tutor: false, study: "unknown" });
      const res = await POST(post({ mode: "study-rule", courseId: s.course.id, rule: "allowed" }, s.cookie));
      expect(res.status).toBe(404);
      expect(await ruleOf(s.course.id)).toBe("unknown");
    });

    it("after her yes, the next answer gets the course text", async () => {
      const s = await student({ study: "unknown" });
      const where = { kind: "lecture", courseId: s.course.id, n: 1, section: 0 };
      ai.queue("groq", { text: "General answer." });
      await (await POST(post({ text: QUESTION, where }, s.cookie))).text();
      expect(sent(0)[0].content).not.toContain("LECTURE-TEXT-8a1f");
      await POST(post({ mode: "study-rule", courseId: s.course.id, rule: "allowed" }, s.cookie));
      ai.queue("groq", { text: "Course answer." });
      await (await POST(post({ text: QUESTION, where }, s.cookie))).text();
      expect(sent(1)[0].content).toContain("LECTURE-TEXT-8a1f");
    });
  });

  it("copy mode for a course that does not allow AI for study: no course text, and a note", async () => {
    const s = await student({ study: "not_allowed" });
    const res = await POST(post({ mode: "copy", text: "What is NPV?", where: { kind: "lecture", courseId: s.course.id, n: 1 } }, s.cookie));
    const body = (await res.json()) as { text: string; note: string | null };
    expect(body.text).not.toContain("LECTURE-TEXT-8a1f");
    expect(body.note).toContain("Copied without course text");
  });
});
