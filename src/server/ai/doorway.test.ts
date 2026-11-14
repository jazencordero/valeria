// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ensureSessionFor, newToken, SESSION_COOKIE } from "@/server/auth/session";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { aiCalls } from "@/server/db/schema/system";
import { users } from "@/server/db/schema/users";
import { startFakeAi, type FakeAi } from "../../../tests/fake-ai/server";
import { AI_BUSY_MESSAGE, createAiRoute, sessionTokenFrom, type AiHandler } from "./doorway";
import { PROVIDERS, type ProviderEntry, type SizeClass } from "./providers.config";
import { createRouter } from "./router";

// The machine running the suite can be slow; DB clones plus HTTP to the fake take a while.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const GROQ = PROVIDERS.small.find((e) => e.provider === "groq")!;
const NOW = new Date("2026-11-14T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ENV = { GROQ_API_KEY: "fake-groq-key" };
const SECRET = "PRIVATE-BODY-4d2e";

let ai: FakeAi;
let t: TestDb;

beforeAll(async () => {
  ai = await startFakeAi();
});
afterAll(async () => {
  await ai.close();
});
beforeEach(async () => {
  ai.reset();
  t = await createTestDb();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

function table(small: readonly ProviderEntry[]): Record<SizeClass, readonly ProviderEntry[]> {
  return { small, medium: small, large: small };
}

function aiRoute(env: Record<string, string | undefined> = ENV) {
  const router = createRouter({
    providers: table([GROQ]),
    env,
    database: t.db,
    now: () => NOW,
    baseUrlFor: (entry) => `${ai.url}/${entry.provider}/v1`,
  });
  // The doorway uses the real clock: the router writes `ai_calls.created_at` with the database's now().
  return createAiRoute({ router, database: t.db });
}

async function signedIn() {
  const { user, token } = await ensureSessionFor(t.db, undefined);
  return { user, cookie: `other=1; ${SESSION_COOKIE}=${token}` };
}

function post(body: string | undefined, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost/api/ai/test", { method: "POST", headers, body });
}

const Body = z.object({ question: z.string().min(1).max(200) });

const echo: AiHandler<z.output<typeof Body>> = async ({ body, ai: doorAi }) => {
  const { text, provider } = await doorAi.runText({
    messages: [{ role: "user", content: body.question }],
    job: "test-job",
  });
  return { answer: text, provider };
};

const opts = { size: "small" as const, perUserPerHour: 3, body: Body };

describe("sessionTokenFrom", () => {
  it("reads the session cookie among others", () => {
    const token = newToken();
    const req = new Request("http://x", { headers: { cookie: `a=1; ${SESSION_COOKIE}=${token}; b=2` } });
    expect(sessionTokenFrom(req)).toBe(token);
    expect(sessionTokenFrom(new Request("http://x"))).toBeUndefined();
  });
});

describe("aiRoute", () => {
  it("answers 401 when nobody is signed in, without calling the handler", async () => {
    const handler = vi.fn(echo);
    const route = aiRoute()(handler, opts);

    const none = await route(post(JSON.stringify({ question: "hi" })));
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: "not_signed_in" });

    // A well-formed token with no session row is not signed in either.
    const unknown = await route(post(JSON.stringify({ question: "hi" }), `${SESSION_COOKIE}=${newToken()}`));
    expect(unknown.status).toBe(401);

    expect(handler).not.toHaveBeenCalled();
    expect(ai.calls).toHaveLength(0);
  });

  it("answers 429 slow_down once she has made perUserPerHour calls in the last hour", async () => {
    const { user, cookie } = await signedIn();
    const [other] = await t.db.insert(users).values({}).returning();
    const row = (userId: string, ago: number) => ({
      provider: "groq",
      model: GROQ.model,
      job: "x",
      ok: true,
      ms: 1,
      userId,
      createdAt: new Date(Date.now() - ago),
    });
    // Two in the hour, one older than an hour, and someone else's: under the limit of 3.
    await t.db
      .insert(aiCalls)
      .values([row(user.id, 1000), row(user.id, HOUR / 2), row(user.id, HOUR + 1000), row(other.id, 1000)]);
    ai.setDefault("groq", { text: "ready" });
    const handler = vi.fn(echo);
    const route = aiRoute()(handler, opts);

    const third = await route(post(JSON.stringify({ question: "hi" }), cookie));
    expect(third.status).toBe(200);

    // That call wrote the third row inside the hour: the next one is over the limit.
    const fourth = await route(post(JSON.stringify({ question: "hi" }), cookie));
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toEqual({ error: "slow_down" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(ai.calls).toHaveLength(1);
  });

  it("maps AiBusy to 503 with the busy message", async () => {
    const { cookie } = await signedIn();
    const route = aiRoute({})(echo, opts); // no keys: every provider is skipped

    const res = await route(post(JSON.stringify({ question: "hi" }), cookie));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ai_busy", message: "AI is busy. Try again in a few minutes." });
    expect(AI_BUSY_MESSAGE).toBe("AI is busy. Try again in a few minutes.");
    expect(ai.calls).toHaveLength(0);
  });

  it("also answers 503 when every provider is limited", async () => {
    const { cookie } = await signedIn();
    ai.queue("groq", { status: 429, retryAfter: 30 });
    const res = await aiRoute()(echo, opts)(post(JSON.stringify({ question: "hi" }), cookie));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("ai_busy");
  });

  it("answers 400 for a body that is not JSON or does not match the schema, without echoing it", async () => {
    const { cookie } = await signedIn();
    const handler = vi.fn(echo);
    const route = aiRoute()(handler, opts);

    const notJson = await route(post(`{"question": "${SECRET}`, cookie));
    expect(notJson.status).toBe(400);
    expect((await notJson.json()).error).toBe("bad_request");

    const wrong = await route(post(JSON.stringify({ question: 42, extra: SECRET }), cookie));
    expect(wrong.status).toBe(400);
    const text = await wrong.text();
    expect(JSON.parse(text)).toMatchObject({ error: "bad_request", issues: [{ path: "question" }] });
    expect(text).not.toContain(SECRET);

    const empty = await route(post(undefined, cookie)); // empty body is {}: question is missing
    expect(empty.status).toBe(400);

    expect(handler).not.toHaveBeenCalled();
    expect(ai.calls).toHaveLength(0);
  });

  it("runs the handler on a good call and sends its result, with the size and user filled in", async () => {
    const { user, cookie } = await signedIn();
    ai.queue("groq", { text: "ready" });
    const route = aiRoute()(echo, opts);

    const res = await route(post(JSON.stringify({ question: "Are you there?" }), cookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: "ready", provider: "groq" });

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].model).toBe(GROQ.model);
    const logged = await t.db.select().from(aiCalls);
    expect(logged).toEqual([expect.objectContaining({ userId: user.id, job: "test-job", ok: true })]);
  });

  it("passes a Response from the handler through as is, and rethrows other errors", async () => {
    const { cookie } = await signedIn();
    const raw = aiRoute()(() => new Response("plain", { status: 202 }), { ...opts, body: z.object({}) });
    const res = await raw(post("{}", cookie));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("plain");

    const boom = aiRoute()(
      () => {
        throw new Error("boom");
      },
      { ...opts, body: z.object({}) },
    );
    await expect(boom(post("{}", cookie))).rejects.toThrow("boom");
  });
});
