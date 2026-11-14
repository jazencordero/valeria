// @vitest-environment node
import { asc } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionFor, SESSION_COOKIE } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { courseFiles, courses, filePages } from "@/server/db/schema/courses";
import { aiCalls } from "@/server/db/schema/system";
import { assignments, chatMessages, chats } from "@/server/db/schema/work";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { appendMessage, getOrCreateChat } from "@/server/chat/store";
import { startFakeAi, type FakeAi } from "../../../../../tests/fake-ai/server";

// The route, the chat store and the AI router all read the app database; point it at this
// test's fresh PGlite.
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
const SECRET_QUESTION = "PRIVATE-QUESTION-7c1b what does the brief ask for?";
const BRIEF = "BRIEF-TEXT-91aa Write two pages about chloroplasts.";

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
  // The route uses the app's own router: give it one made-up key and send its calls to the fake.
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

type Policy = "allowed" | "unknown" | "not_allowed";

/** A signed-in user with one course, one assignment and one attached file of two pages. */
async function student(policy: Policy, word: string) {
  const { user, token } = await ensureSessionFor(t.db, undefined);
  const [course] = await t.db
    .insert(courses)
    .values({ userId: user.id, moodleId: 1, name: "Cell Biology", aiPolicy: policy })
    .returning();
  const [assignment] = await t.db
    .insert(assignments)
    .values({ userId: user.id, courseId: course.id, moodleId: 1, name: "Essay 1", introHtml: `<p>${BRIEF}</p>` })
    .returning();
  const [file] = await t.db
    .insert(courseFiles)
    .values({
      userId: user.id,
      courseId: course.id,
      assignmentId: assignment.id,
      moodleRef: "file-1",
      name: "Lecture 3.pdf",
      url: "https://moodle.invalid/lecture3.pdf",
      textStatus: "done",
    })
    .returning();
  await t.db.insert(filePages).values([
    { fileId: file.id, page: 1, text: `Notes by ${word}. Photosynthesis happens in the chloroplast.` },
    { fileId: file.id, page: 2, text: `More by ${word}. Photosynthesis needs light and water.` },
  ]);
  return { user, cookie: `${SESSION_COOKIE}=${token}`, course, assignment, file };
}

function post(body: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost/api/ai/assignment-chat", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** The chunks of a UI message stream response. */
async function chunks(res: Response): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const line of (await res.text()).split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    out.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
  }
  return out;
}

const stored = () => t.db.select().from(chatMessages).orderBy(asc(chatMessages.createdAt));

/** An OpenAI-style stream in which the model calls one tool and stops. */
function toolCallStream(name: string, args: unknown): string {
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return (
    chunk(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } },
        ],
      },
      null,
    ) +
    chunk({}, "tool_calls") +
    "data: [DONE]\n\n"
  );
}

type Sent = { role: string; content: unknown; tool_calls?: unknown };
const sentMessages = (call: number) => ai.calls[call].body.messages as Sent[];

describe("POST /api/ai/assignment-chat", () => {
  it("streams the reply in the UI stream format and stores it once, with its sources", async () => {
    const s = await student("allowed", "ALPHA");
    const answer =
      "Chloroplasts make sugar [Lecture 3.pdf, p. 2]. The brief wants two pages [Assignment brief]. " +
      "Light is needed [Lecture 3.pdf, p. 2] and water too [Lecture 3.pdf, p.1].";
    ai.queue("groq", { text: answer });

    const res = await POST(post({ assignmentId: s.assignment.id, text: SECRET_QUESTION }, s.cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");

    const parts = await chunks(res);
    const deltas = parts.filter((p) => p.type === "text-delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((p) => p.delta).join("")).toBe(answer);
    expect(parts.some((p) => p.type === "error")).toBe(false);
    expect(parts.at(-1)).toMatchObject({ type: "finish" });

    // The large model got the system prompt (with the brief: the course allows AI) and her message.
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]).toMatchObject({ route: "groq", model: "openai/gpt-oss-120b", stream: true });
    const sent = sentMessages(0);
    expect(sent[0].role).toBe("system");
    expect(sent[0].content).toContain("BRIEF-TEXT-91aa");
    expect(sent.slice(1)).toEqual([{ role: "user", content: SECRET_QUESTION }]);

    await vi.waitFor(async () => expect(await stored()).toHaveLength(2));
    // Give a second end-of-stream report the time to arrive: still one reply.
    await new Promise((r) => setTimeout(r, 200));
    const rows = await stored();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: SECRET_QUESTION }] });
    expect(rows[1]).toMatchObject({
      role: "assistant",
      parts: [
        { type: "text", text: answer },
        { type: "source", label: "Lecture 3.pdf, p. 2" },
        { type: "source", label: "Lecture 3.pdf, p.1" },
      ],
    });
    expect(await t.db.select().from(chats)).toHaveLength(1);

    // One row in ai_calls, and nothing private printed.
    await vi.waitFor(async () => expect(await t.db.select().from(aiCalls)).toHaveLength(1));
    expect(await t.db.select().from(aiCalls)).toMatchObject([
      { provider: "groq", job: "assignment-chat", ok: true, userId: s.user.id },
    ]);
    const printed = JSON.stringify(logs.map((args) => args.map(String)));
    for (const secret of [SECRET_QUESTION, "BRIEF-TEXT-91aa", answer, FAKE_KEY]) expect(printed).not.toContain(secret);
  });

  it("a search_material call returns only her pages, and the answer after it is stored once", async () => {
    const s = await student("allowed", "ALPHA");
    const other = await student("allowed", "BRAVO"); // someone else, same words in her file
    ai.queue("groq", { rawBody: toolCallStream("search_material", { query: "photosynthesis" }) });
    ai.queue("groq", { text: "It happens in the chloroplast [Lecture 3.pdf, p. 1]." });

    const res = await POST(post({ assignmentId: s.assignment.id, text: "Where does photosynthesis happen?" }, s.cookie));
    expect(res.status).toBe(200);
    const parts = await chunks(res);

    // Round one offered both tools; round two carried the tool's answer back to the model.
    expect(ai.calls).toHaveLength(2);
    const offered = (ai.calls[0].body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    expect(offered.sort()).toEqual(["read_pages", "search_material"]);
    const toolMessage = sentMessages(1).find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    const raw = typeof toolMessage!.content === "string" ? toolMessage!.content : JSON.stringify(toolMessage!.content);
    expect(raw).toContain("ALPHA");
    expect(raw).not.toContain("BRAVO");
    expect(raw).toContain(s.file.id);
    expect(raw).not.toContain(other.file.id);

    // The browser saw the tool's answer too, and it is hers only.
    const output = parts.find((p) => p.type === "tool-output-available");
    expect(output).toBeDefined();
    const hits = (output!.output as { hits: { fileId: string; page: number }[] }).hits;
    expect(hits.length).toBe(2);
    expect(hits.every((hit) => hit.fileId === s.file.id)).toBe(true);
    expect(JSON.stringify(parts)).not.toContain("BRAVO");

    await vi.waitFor(async () => expect(await stored()).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 200));
    const rows = await stored();
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows[1].parts).toEqual([
      { type: "text", text: "It happens in the chloroplast [Lecture 3.pdf, p. 1]." },
      { type: "source", label: "Lecture 3.pdf, p. 1" },
    ]);
    // Two HTTP rounds, one request: one row.
    expect(await t.db.select().from(aiCalls)).toHaveLength(1);
  });

  it("stops after 4 tool rounds", async () => {
    const s = await student("allowed", "ALPHA");
    ai.setDefault("groq", { rawBody: toolCallStream("search_material", { query: "light" }) });

    const res = await POST(post({ assignmentId: s.assignment.id, text: "Keep searching." }, s.cookie));
    await chunks(res);

    // Four rounds of tools plus the step that should have answered.
    expect(ai.calls).toHaveLength(5);
    await new Promise((r) => setTimeout(r, 200));
    // The model never wrote anything, so there is no reply to store.
    expect((await stored()).map((row) => row.role)).toEqual(["user"]);
  });

  it("when every provider is busy: 503 with the busy message, and only her message is stored", async () => {
    const s = await student("allowed", "ALPHA");
    ai.queue("groq", { status: 429, retryAfter: 30 });

    const res = await POST(post({ assignmentId: s.assignment.id, text: "Hello?" }, s.cookie));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ai_busy", message: "AI is busy. Try again in a few minutes." });

    await new Promise((r) => setTimeout(r, 200));
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: "Hello?" }] });
  });

  it("with no key configured at all it is also 503 and one stored message", async () => {
    const s = await student("allowed", "ALPHA");
    vi.stubEnv("GROQ_API_KEY", "");

    const res = await POST(post({ assignmentId: s.assignment.id, text: "Hello?" }, s.cookie));
    expect(res.status).toBe(503);
    expect(ai.calls).toHaveLength(0);
    expect((await stored()).map((row) => row.role)).toEqual(["user"]);
  });

  it("a stream that fails part-way sends an error part and stores no reply", async () => {
    const s = await student("allowed", "ALPHA");
    ai.queue("groq", { rawBody: toolCallStream("search_material", { query: "light" }) });
    ai.queue("groq", { status: 500 });

    const res = await POST(post({ assignmentId: s.assignment.id, text: "What about light?" }, s.cookie));
    expect(res.status).toBe(200); // the stream had already started
    const parts = await chunks(res);
    const error = parts.find((p) => p.type === "error");
    expect(error).toEqual({ type: "error", errorText: "The answer stopped early. Try again." });

    await new Promise((r) => setTimeout(r, 300));
    expect((await stored()).map((row) => row.role)).toEqual(["user"]);
    const printed = JSON.stringify(logs.map((args) => args.map(String)));
    for (const secret of ["What about light?", "BRIEF-TEXT-91aa", FAKE_KEY]) expect(printed).not.toContain(secret);
  });

  it("another user's assignment is 404 and nothing is stored or sent", async () => {
    const s = await student("allowed", "ALPHA");
    const other = await student("allowed", "BRAVO");

    const res = await POST(post({ assignmentId: other.assignment.id, text: "Let me in." }, s.cookie));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });

    // An id that does not exist looks the same.
    const missing = await POST(
      post({ assignmentId: "0b9f4a52-6f0e-4c1d-9a55-2d1c8f3e7a10", text: "Let me in." }, s.cookie),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });

    expect(await stored()).toHaveLength(0);
    expect(await t.db.select().from(chats)).toHaveLength(0);
    expect(ai.calls).toHaveLength(0);
  });

  it.each(["not_allowed", "unknown"] as const)("a '%s' course gets no tools and no material", async (policy) => {
    const s = await student(policy, "ALPHA");
    ai.queue("groq", { text: "I have not been given the brief." });

    const res = await POST(post({ assignmentId: s.assignment.id, text: "What does the brief say?" }, s.cookie));
    expect(res.status).toBe(200);
    await chunks(res);

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].body.tools).toBeUndefined();
    expect(ai.calls[0].body.tool_choice).toBeUndefined();
    const system = sentMessages(0)[0];
    expect(system.role).toBe("system");
    expect(system.content).not.toContain("BRIEF-TEXT-91aa");
    expect(JSON.stringify(ai.calls[0].body)).not.toContain("ALPHA");

    await vi.waitFor(async () => expect(await stored()).toHaveLength(2));
    expect((await stored())[1].parts).toEqual([{ type: "text", text: "I have not been given the brief." }]);
  });

  it("sends the last 20 messages, starting with one of hers, and drops old ones over the budget", async () => {
    const s = await student("not_allowed", "ALPHA");
    const chat = await getOrCreateChat(s.user.id, s.assignment.id, t.db);
    for (let i = 0; i < 12; i++) {
      await appendMessage(s.user.id, chat.id, "user", [{ type: "text", text: `question ${i}` }], t.db);
      await appendMessage(
        s.user.id,
        chat.id,
        "assistant",
        [
          { type: "text", text: `answer ${i}` },
          { type: "source", label: "Lecture 3.pdf, p. 1" },
        ],
        t.db,
      );
    }
    ai.queue("groq", { text: "ok" }, { text: "ok" });

    await chunks(await POST(post({ assignmentId: s.assignment.id, text: "question 12" }, s.cookie)));
    // 25 stored; the newest 20 start with an assistant message, which is dropped: 19 go out.
    const sent = sentMessages(0).slice(1);
    expect(sent).toHaveLength(19);
    expect(sent[0]).toEqual({ role: "user", content: "question 3" });
    expect(sent.at(-2)).toEqual({ role: "assistant", content: "answer 11" });
    expect(sent.at(-1)).toEqual({ role: "user", content: "question 12" });
    await vi.waitFor(async () => expect(await stored()).toHaveLength(26));

    // Two long old messages: together with the new one they pass 60,000 characters.
    const long = "x".repeat(31_000);
    await appendMessage(s.user.id, chat.id, "user", [{ type: "text", text: `first ${long}` }], t.db);
    await appendMessage(s.user.id, chat.id, "assistant", [{ type: "text", text: `second ${long}` }], t.db);
    await appendMessage(s.user.id, chat.id, "user", [{ type: "text", text: `third ${long}` }], t.db);
    await appendMessage(s.user.id, chat.id, "assistant", [{ type: "text", text: "short answer" }], t.db);
    await chunks(await POST(post({ assignmentId: s.assignment.id, text: "question 13" }, s.cookie)));
    const trimmed = sentMessages(1).slice(1);
    expect(trimmed.map((m) => String(m.content).slice(0, 6))).toEqual(["third ", "short ", "questi"]);
    expect(trimmed.reduce((n, m) => n + String(m.content).length, 0)).toBeLessThanOrEqual(60_000);
  });

  it("checks the body and the sign-in before anything is stored", async () => {
    const s = await student("allowed", "ALPHA");

    const unsigned = await POST(post({ assignmentId: s.assignment.id, text: "hi" }));
    expect(unsigned.status).toBe(401);

    for (const body of [
      { assignmentId: s.assignment.id, text: "" },
      { assignmentId: s.assignment.id, text: "x".repeat(4001) },
      { assignmentId: "not-a-uuid", text: "hi" },
      { text: "hi" },
    ]) {
      const res = await POST(post(body, s.cookie));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "bad_request" });
    }
    expect(await stored()).toHaveLength(0);
    expect(ai.calls).toHaveLength(0);
  });
});
