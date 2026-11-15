// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { aiCalls, providerCooldowns } from "@/server/db/schema/system";
import { BROKEN_JSON, startFakeAi, type FakeAi } from "../../../tests/fake-ai/server";
import { PROVIDERS, type ProviderEntry, type SizeClass } from "./providers.config";
import {
  AiBadOutput,
  AiBusy,
  ANTHROPIC_BALANCED_MODEL,
  ANTHROPIC_DEEP_MODEL,
  ANTHROPIC_SMALL_MODEL,
  createRouter,
  fakeAiUrl,
  NotFree,
  PaidNotAllowed,
  retryAfterMs,
  TUTOR_JOB,
  type RouterDeps,
} from "./router";

// Real free entries from the config, so the allow-list check passes; their URLs point at the fake.
const GROQ = PROVIDERS.small.find((e) => e.provider === "groq")!;
const OPENROUTER = PROVIDERS.small.find((e) => e.provider === "openrouter")!;
const CLOUDFLARE = PROVIDERS.small.find((e) => e.provider === "cloudflare")!;

const NOW = new Date("2026-11-14T10:00:00.000Z");
const PROMPT = "PRIVATE-PROMPT-7f3a: explain photosynthesis";
const SYSTEM = "PRIVATE-SYSTEM-91bc: you are a tutor";
const ENV = {
  GROQ_API_KEY: "fake-groq-key",
  OPENROUTER_API_KEY: "fake-openrouter-key",
  CLOUDFLARE_API_TOKEN: "fake-cloudflare-token",
  CLOUDFLARE_ACCOUNT_ID: "fake-account",
};

let ai: FakeAi;
let t: TestDb;
let logs: unknown[][];

beforeAll(async () => {
  ai = await startFakeAi();
});
afterAll(async () => {
  await ai.close();
});
beforeEach(async () => {
  ai.reset();
  t = await createTestDb();
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

function table(small: readonly ProviderEntry[]): Record<SizeClass, readonly ProviderEntry[]> {
  return { small, medium: small, large: small };
}

function router(small: readonly ProviderEntry[] = [GROQ, OPENROUTER], extra: Partial<RouterDeps> = {}) {
  return createRouter({
    providers: table(small),
    env: ENV,
    database: t.db,
    now: () => NOW,
    baseUrlFor: (entry) => `${ai.url}/${entry.provider}/v1`,
    ...extra,
  });
}

const input = { size: "small" as const, system: SYSTEM, messages: [{ role: "user" as const, content: PROMPT }], job: "test-job" };

async function rows() {
  return t.db.select().from(aiCalls).orderBy(aiCalls.createdAt);
}

describe("pick", () => {
  it("takes the first provider that has its key and is not cooling down", async () => {
    expect((await router().pick("small"))?.provider).toBe("groq");

    const noGroqKey = router(undefined, { env: { ...ENV, GROQ_API_KEY: undefined } });
    expect((await noGroqKey.pick("small"))?.provider).toBe("openrouter");

    await t.db.insert(providerCooldowns).values({ provider: "groq", until: new Date(NOW.getTime() + 1000) });
    expect((await router().pick("small"))?.provider).toBe("openrouter");
  });

  it("uses a provider again once its cool-down has passed", async () => {
    await t.db.insert(providerCooldowns).values({ provider: "groq", until: new Date(NOW.getTime() - 1) });
    expect((await router().pick("small"))?.provider).toBe("groq");
  });

  it("skips Cloudflare without its account id, and returns null when nothing is configured", async () => {
    const r = router([CLOUDFLARE], { env: { CLOUDFLARE_API_TOKEN: "fake-cloudflare-token" } });
    expect(await r.pick("small")).toBeNull();
    expect(await router(undefined, { env: {} }).pick("small")).toBeNull();
  });
});

describe("runText", () => {
  it("answers from the first provider and logs one ok row", async () => {
    ai.queue("groq", { text: "Plants make sugar from light." });
    const out = await router().runText({ ...input, userId: null });

    expect(out).toMatchObject({ provider: "groq", model: GROQ.model, text: "Plants make sugar from light." });
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]).toMatchObject({ route: "groq", model: GROQ.model, stream: false, hasKey: true });
    expect(await rows()).toMatchObject([{ provider: "groq", model: GROQ.model, job: "test-job", ok: true, userId: null }]);
  });

  it("a 429 from the first provider falls to the second and writes a cool-down", async () => {
    ai.queue("groq", { status: 429, retryAfter: 30 });
    ai.queue("openrouter", { text: "From the second provider." });
    const r = router();

    const out = await r.runText(input);
    expect(out).toMatchObject({ provider: "openrouter", text: "From the second provider." });
    expect(ai.calls.map((c) => c.route)).toEqual(["groq", "openrouter"]);

    const cooldowns = await t.db.select().from(providerCooldowns);
    expect(cooldowns).toHaveLength(1);
    expect(cooldowns[0].provider).toBe("groq");
    expect(cooldowns[0].until.getTime()).toBe(NOW.getTime() + 30_000);

    expect((await rows()).map((row) => [row.provider, row.ok])).toEqual([
      ["groq", false],
      ["openrouter", true],
    ]);

    // While groq cools down it is not even tried.
    ai.calls.length = 0;
    await r.runText(input);
    expect(ai.calls.map((c) => c.route)).toEqual(["openrouter"]);
  });

  it("a 5xx without retry-after cools down for 60 seconds", async () => {
    ai.queue("groq", { status: 503 });
    await router().runText(input);
    const [cooldown] = await t.db.select().from(providerCooldowns);
    expect(cooldown.until.getTime()).toBe(NOW.getTime() + 60_000);
  });

  it("a second limit on a provider moves its cool-down forward", async () => {
    await t.db.insert(providerCooldowns).values({ provider: "groq", until: new Date(NOW.getTime() - 5000) });
    ai.queue("groq", { status: 429, retryAfter: 10 });
    await router().runText(input);
    const cooldowns = await t.db.select().from(providerCooldowns);
    expect(cooldowns).toHaveLength(1);
    expect(cooldowns[0].until.getTime()).toBe(NOW.getTime() + 10_000);
  });

  it("all providers limited throws AiBusy", async () => {
    ai.queue("groq", { status: 429, retryAfter: 20 });
    ai.queue("openrouter", { status: 429 });

    await expect(router().runText(input)).rejects.toBeInstanceOf(AiBusy);
    expect(ai.calls).toHaveLength(2);
    const cooldowns = await t.db.select().from(providerCooldowns);
    expect(cooldowns.map((c) => c.provider).sort()).toEqual(["groq", "openrouter"]);
  });

  it("throws AiBusy without calling anyone when every provider is cooling down or has no key", async () => {
    await t.db.insert(providerCooldowns).values({ provider: "groq", until: new Date(NOW.getTime() + 60_000) });
    const r = router(undefined, { env: { ...ENV, OPENROUTER_API_KEY: undefined } });
    await expect(r.runText(input)).rejects.toBeInstanceOf(AiBusy);
    expect(ai.calls).toHaveLength(0);
  });

  it("a model outside the allow-list throws NotFree before any network call", async () => {
    const paid: ProviderEntry = { ...GROQ, model: "some-vendor/paid-model-pro" };
    const r = router([paid, OPENROUTER]);

    await expect(r.runText(input)).rejects.toBeInstanceOf(NotFree);
    await expect(r.pick("small")).rejects.toBeInstanceOf(NotFree);
    await expect(r.streamChat(input)).rejects.toBeInstanceOf(NotFree);
    await expect(r.runObject({ ...input, schema: z.object({ a: z.number() }) })).rejects.toBeInstanceOf(NotFree);
    expect(ai.calls).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("every OpenRouter model in the config is a ':free' one", () => {
    // The allow-list is built from the config itself, so this is the check that
    // a paid OpenRouter model cannot be listed by mistake.
    const openrouter = Object.values(PROVIDERS).flat().filter((e) => e.provider === "openrouter");
    expect(openrouter.length).toBeGreaterThan(0);
    for (const entry of openrouter) expect(entry.model.endsWith(":free"), entry.model).toBe(true);
  });

  it("refuses a paid model even when it sits after a free one", async () => {
    const r = router([GROQ, { ...OPENROUTER, model: "openai/gpt-paid" }]);
    await expect(r.runText(input)).rejects.toBeInstanceOf(NotFree);
    expect(ai.calls).toHaveLength(0);
  });
});

describe("runObject", () => {
  const schema = z.object({ title: z.string(), cards: z.number().int() });

  it("uses JSON mode where the config says so and validates the answer", async () => {
    ai.queue("groq", { text: '{"title":"Cells","cards":3}' });
    const out = await router().runObject({ ...input, schema });

    expect(out).toMatchObject({ provider: "groq", object: { title: "Cells", cards: 3 } });
    expect(ai.calls[0].body.response_format).toEqual({ type: "json_object" });
    const system = (ai.calls[0].body.messages as { role: string; content: string }[])[0];
    expect(system.role).toBe("system");
    expect(system.content).toContain(SYSTEM);
    expect(system.content).toContain("JSON Schema");
  });

  it("without JSON mode it still asks for JSON, and accepts a fenced answer", async () => {
    ai.queue("cloudflare", { text: '```json\n{"title":"Cells","cards":2}\n```' });
    const out = await router([CLOUDFLARE]).runObject({ ...input, schema });

    expect(out.object).toEqual({ title: "Cells", cards: 2 });
    expect(ai.calls[0].body.response_format).toBeUndefined();
  });

  it("broken JSON is repaired once with the same provider", async () => {
    ai.queue("groq", { text: BROKEN_JSON }, { text: '{"title":"Fixed","cards":1}' });
    const out = await router().runObject({ ...input, schema });

    expect(out).toMatchObject({ provider: "groq", object: { title: "Fixed", cards: 1 } });
    expect(ai.calls.map((c) => c.route)).toEqual(["groq", "groq"]);
    const repairMessages = ai.calls[1].body.messages as { role: string; content: string }[];
    expect(repairMessages.at(-2)).toMatchObject({ role: "assistant", content: BROKEN_JSON });
    expect(repairMessages.at(-1)?.content).toContain("not valid JSON");
    expect((await rows()).map((row) => row.ok)).toEqual([true, true]);
  });

  it("an answer that misses the schema is repaired too", async () => {
    ai.queue("groq", { text: '{"title":"No count"}' }, { text: '{"title":"Counted","cards":4}' });
    const out = await router().runObject({ ...input, schema });
    expect(out.object).toEqual({ title: "Counted", cards: 4 });
    const repairMessages = ai.calls[1].body.messages as { role: string; content: string }[];
    expect(repairMessages.at(-1)?.content).toContain("cards");
  });

  it("broken JSON twice fails cleanly with AiBadOutput after exactly one repair", async () => {
    ai.queue("groq", { text: BROKEN_JSON }, { text: "still not json" });
    const err = await router()
      .runObject({ ...input, schema })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiBadOutput);
    expect((err as Error).message).not.toContain(PROMPT);
    expect(ai.calls.map((c) => c.route)).toEqual(["groq", "groq"]);
  });

  it("a limit during the repair moves to the next provider", async () => {
    ai.queue("groq", { text: BROKEN_JSON }, { status: 429 });
    ai.queue("openrouter", { text: '{"title":"Other","cards":5}' });
    const out = await router().runObject({ ...input, schema });
    expect(out).toMatchObject({ provider: "openrouter", object: { title: "Other", cards: 5 } });
  });
});

describe("streamChat", () => {
  it("streams the answer from the fake server and logs one row when it ends", async () => {
    ai.queue("groq", { text: "Light goes in, sugar comes out." });
    const { provider, result } = await router().streamChat(input);
    expect(provider).toBe("groq");

    const parts: string[] = [];
    for await (const delta of result.textStream) parts.push(delta);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe("Light goes in, sugar comes out.");
    expect(ai.calls[0].stream).toBe(true);

    await result.text;
    await vi.waitFor(async () => expect(await rows()).toHaveLength(1));
    expect(await rows()).toMatchObject([{ provider: "groq", job: "test-job", ok: true }]);
  });

  it("a 429 before the stream starts falls to the next provider and writes a cool-down", async () => {
    ai.queue("groq", { status: 429, retryAfter: 45 });
    ai.queue("openrouter", { text: "Streamed by the second." });
    const { provider, result } = await router().streamChat(input);

    expect(provider).toBe("openrouter");
    expect(await result.text).toBe("Streamed by the second.");
    const [cooldown] = await t.db.select().from(providerCooldowns);
    expect(cooldown).toMatchObject({ provider: "groq" });
    expect(cooldown.until.getTime()).toBe(NOW.getTime() + 45_000);
    await vi.waitFor(async () => expect(await rows()).toHaveLength(2));
    expect((await rows()).map((row) => [row.provider, row.ok])).toEqual([
      ["groq", false],
      ["openrouter", true],
    ]);
  });

  it("all providers limited throws AiBusy", async () => {
    ai.queue("groq", { status: 500 });
    ai.queue("openrouter", { status: 429 });
    await expect(router().streamChat(input)).rejects.toBeInstanceOf(AiBusy);
  });

  // M2-14: plain tools, tool rounds and onEnd.
  const toolCall = (name: string, args: unknown) => {
    const chunk = (delta: unknown, finish: string | null) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const call = { index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } };
    return chunk({ role: "assistant", content: null, tool_calls: [call] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n";
  };
  const lookUp = () => ({
    description: "Looks a word up.",
    inputSchema: z.object({ word: z.string() }),
    execute: vi.fn(async ({ word }: { word: string }) => ({ meaning: `${word} means TOOL-RESULT-42` })),
  });

  it("runs a plain tool, sends its answer back, and calls onEnd once with the whole text", async () => {
    ai.queue("groq", { rawBody: toolCall("look_up", { word: "stroma" }) }, { text: "It is the fluid." });
    const look_up = lookUp();
    const onEnd = vi.fn();
    const { result } = await router().streamChat({ ...input, tools: { look_up, skipped: undefined }, maxToolRounds: 2, onEnd });

    expect(await result.text).toBe("It is the fluid.");
    expect(look_up.execute).toHaveBeenCalledTimes(1);
    expect(look_up.execute.mock.calls[0][0]).toEqual({ word: "stroma" });
    expect(ai.calls).toHaveLength(2);
    expect((ai.calls[0].body.tools as { function: { name: string } }[]).map((x) => x.function.name)).toEqual(["look_up"]);
    expect(JSON.stringify(ai.calls[1].body.messages)).toContain("TOOL-RESULT-42");
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
    expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ text: "It is the fluid." }));
    await vi.waitFor(async () => expect(await rows()).toHaveLength(1));
  });

  it("without maxToolRounds a tool call is not followed up, and no tools means none are sent", async () => {
    ai.queue("groq", { rawBody: toolCall("look_up", { word: "stroma" }) });
    const first = await router().streamChat({ ...input, tools: { look_up: lookUp() } });
    await first.result.consumeStream();
    expect(ai.calls).toHaveLength(1);

    ai.queue("groq", { text: "plain" });
    const second = await router().streamChat({ ...input, tools: {} });
    expect(await second.result.text).toBe("plain");
    expect(ai.calls[1].body.tools).toBeUndefined();
  });

  it("does not call onEnd when the stream fails between tool rounds", async () => {
    ai.queue("groq", { rawBody: toolCall("look_up", { word: "stroma" }) }, { status: 500 });
    const onEnd = vi.fn();
    const { result } = await router().streamChat({ ...input, tools: { look_up: lookUp() }, maxToolRounds: 2, onEnd });
    await result.consumeStream({ onError: () => {} });
    await new Promise((r) => setTimeout(r, 200));
    expect(onEnd).not.toHaveBeenCalled();
    expect(ai.calls).toHaveLength(2);
  });
});

describe("privacy", () => {
  it("an ai_calls row holds no prompt, answer or key, and nothing is printed", async () => {
    ai.queue("groq", { status: 429 });
    ai.queue("openrouter", { text: "ANSWER-TEXT-55" });
    await router().runText(input);

    const all = await rows();
    expect(all).toHaveLength(2);
    for (const row of all) {
      expect(Object.keys(row).sort()).toEqual(["createdAt", "id", "job", "model", "ms", "ok", "provider", "userId"]);
      expect(row.ms).toBeGreaterThanOrEqual(0);
    }
    const stored = JSON.stringify(all);
    for (const secret of [PROMPT, SYSTEM, "ANSWER-TEXT-55", ...Object.values(ENV)]) {
      expect(stored).not.toContain(secret);
    }
    const printed = JSON.stringify(logs.map((args) => args.map(String)));
    for (const secret of [PROMPT, SYSTEM, ...Object.values(ENV)]) expect(printed).not.toContain(secret);
  });

  it("AiBusy carries no request body", async () => {
    ai.queue("groq", { status: 429 });
    ai.queue("openrouter", { status: 503 });
    const err = await router()
      .runText(input)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiBusy);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(PROMPT);
    expect((err as Error).cause).toBeUndefined();
  });
});

// M2-23: the test-only switch that points a dev server at the fake AI.
describe("AI_FAKE_URL", () => {
  /** A router with no `baseUrlFor`, as the app builds it, and a fetch that records where it was sent. */
  function appRouter(env: Record<string, string | undefined>, small: readonly ProviderEntry[] = [GROQ]) {
    const urls: string[] = [];
    const answer = {
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "from the stub" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    // Nothing leaves the machine: a call that is not for the fake is answered here.
    const fetch: typeof globalThis.fetch = async (url, init) => {
      urls.push(String(url));
      if (String(url).startsWith(ai.url)) return globalThis.fetch(url, init);
      return Response.json(answer);
    };
    const r = createRouter({ providers: table(small), env: { ...ENV, ...env }, database: t.db, now: () => NOW, fetch });
    return { r, urls };
  }

  it("on a local dev server, calls go to the fake under the provider's name", async () => {
    ai.queue("groq", { text: "from the fake" });
    const { r, urls } = appRouter({ NODE_ENV: "development", AI_FAKE_URL: ai.url });
    expect((await r.runText(input)).text).toBe("from the fake");
    expect(urls).toEqual([`${ai.url}/groq/v1/chat/completions`]);
    expect(ai.calls).toMatchObject([{ route: "groq", model: GROQ.model, hasKey: true }]);
  });

  it("is ignored in production", async () => {
    const { r, urls } = appRouter({ NODE_ENV: "production", AI_FAKE_URL: ai.url });
    expect((await r.runText(input)).text).toBe("from the stub");
    expect(urls).toEqual(["https://api.groq.com/openai/v1/chat/completions"]);
    expect(ai.calls).toHaveLength(0);
  });

  it.each([
    ["VERCEL", "1"],
    ["VERCEL_ENV", "preview"],
    ["VERCEL_ENV", "development"],
    ["VERCEL_URL", "ready-preview.vercel.app"],
    ["VERCEL_OIDC_TOKEN", "made-up"],
    ["VERCEL_ANYTHING_NEW", "x"],
  ])("is ignored when %s is set to %j, whatever NODE_ENV says", async (name, value) => {
    const { r, urls } = appRouter({ NODE_ENV: "development", AI_FAKE_URL: ai.url, [name]: value });
    expect((await r.runText(input)).text).toBe("from the stub");
    expect(urls).toEqual(["https://api.groq.com/openai/v1/chat/completions"]);
    expect(ai.calls).toHaveLength(0);
  });

  it.each([
    "https://evil.example/collect",
    "http://127.0.0.1.evil.example:4000",
    "http://localhost.evil.example",
    "http://evil.example#@127.0.0.1",
    "http://127.0.0.1@evil.example",
    "http://user:pw@127.0.0.1:4000",
    "http://0.0.0.0:4000",
    "http://192.168.1.20:4000",
    "http://[::1]:4000",
    "file:///tmp/x",
    "not a url",
  ])("is ignored when it does not point at this machine: %s", async (value) => {
    expect(fakeAiUrl({ NODE_ENV: "development", AI_FAKE_URL: value })).toBeNull();
    const { r, urls } = appRouter({ NODE_ENV: "development", AI_FAKE_URL: value });
    expect((await r.runText(input)).text).toBe("from the stub");
    expect(urls).toEqual(["https://api.groq.com/openai/v1/chat/completions"]);
  });

  it("a VERCEL* name with an empty value counts as not set", async () => {
    ai.queue("groq", { text: "from the fake" });
    const { r } = appRouter({ NODE_ENV: "development", AI_FAKE_URL: ai.url, VERCEL: "", VERCEL_ENV: undefined });
    expect((await r.runText(input)).text).toBe("from the fake");
  });

  it("reads localhost and 127.0.0.1, and drops any path", () => {
    expect(fakeAiUrl({ AI_FAKE_URL: "http://127.0.0.1:4010" })).toBe("http://127.0.0.1:4010");
    expect(fakeAiUrl({ AI_FAKE_URL: "http://localhost:4010/anything?x=1" })).toBe("http://localhost:4010");
    expect(fakeAiUrl({})).toBeNull();
    expect(fakeAiUrl({ AI_FAKE_URL: "" })).toBeNull();
  });

  it("the allow-list still applies: a paid model throws NotFree and nothing is sent", async () => {
    const paid: ProviderEntry = { ...GROQ, model: "openai/gpt-paid-1" };
    const { r, urls } = appRouter({ NODE_ENV: "development", AI_FAKE_URL: ai.url }, [paid]);
    await expect(r.runText(input)).rejects.toBeInstanceOf(NotFree);
    expect(urls).toHaveLength(0);
    expect(ai.calls).toHaveLength(0);
  });

  it("a provider without its key is still skipped, and nothing is printed", async () => {
    const { r, urls } = appRouter({ NODE_ENV: "development", AI_FAKE_URL: ai.url, GROQ_API_KEY: undefined });
    await expect(r.runText(input)).rejects.toBeInstanceOf(AiBusy);
    expect(urls).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });
});

describe("retryAfterMs", () => {
  it("reads seconds and HTTP dates, and ignores junk", () => {
    expect(retryAfterMs({ "retry-after": "12" }, NOW)).toBe(12_000);
    expect(retryAfterMs({ "retry-after": "1.5" }, NOW)).toBe(1_500);
    expect(retryAfterMs({ "retry-after": new Date(NOW.getTime() + 90_000).toUTCString() }, NOW)).toBe(90_000);
    expect(retryAfterMs({ "retry-after": "soon" }, NOW)).toBeNull();
    expect(retryAfterMs({}, NOW)).toBeNull();
    expect(retryAfterMs(undefined, NOW)).toBeNull();
  });
});

// M2-28: the tutor's paid path. Anthropic is never called for real: its address is a made-up
// host answered by `anthropicFetch` below; everything else goes to the fake AI as before.
describe("the tutor's paid path (anthropic)", () => {
  const ANTH = "https://anthropic.invalid";
  const KEY = "fake-anthropic-key-not-real";
  const tutorInput = {
    size: "small" as const,
    systemParts: [
      { text: "RULES-1a2b explain from zero" },
      { text: "LECTURE-TEXT-3c4d the section", cache: true },
      { text: "WHERE-5e6f lecture 3" },
    ],
    messages: [{ role: "user" as const, content: PROMPT }],
    job: TUTOR_JOB,
    paid: "tutor" as const,
    maxOutputTokens: 1500,
  };

  /** Anthropic's SSE for `text`, one delta per word, as the claude-api skill's curl example shows. */
  function sse(text: string, extra: string[] = [], stopReason = "end_turn"): string {
    const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    const words = text.split(/(?<= )/);
    return [
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          model: ANTHROPIC_SMALL_MODEL,
          usage: { input_tokens: 10, cache_read_input_tokens: 700, cache_creation_input_tokens: 0, output_tokens: 1 },
        },
      }),
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      ...words.map((w) => ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: w } })),
      ...extra,
      ev("content_block_stop", { type: "content_block_stop", index: 1 }),
      ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 12 } }),
      ev("message_stop", { type: "message_stop" }),
    ].join("");
  }

  type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

  /** A fetch that answers Anthropic's address with `reply` and sends the rest to the fake. */
  function anthropicFetch(reply: () => Response | Promise<Response>) {
    const sent: Sent[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.startsWith(ANTH) || u.includes("/anthropic/")) {
        sent.push({
          url: u,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return reply();
      }
      return globalThis.fetch(url, init);
    };
    return { fetch, sent };
  }

  const ok = (text: string) => () => new Response(sse(text), { status: 200, headers: { "content-type": "text/event-stream" } });
  const status = (code: number) => () => Response.json({ type: "error", error: { type: "x", message: "PRIVATE" } }, { status: code });

  function paidRouter(reply: () => Response | Promise<Response>, env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: KEY }) {
    const f = anthropicFetch(reply);
    const r = router([GROQ, OPENROUTER], { env: { ...ENV, ...env }, fetch: f.fetch, anthropicBaseUrl: ANTH });
    return { r, sent: f.sent };
  }

  it("with the key, the tutor streams from the small Claude model, capped at 500, and logs one anthropic row", async () => {
    const onEnd = vi.fn();
    const { r, sent } = paidRouter(ok("A cell is a small room."));
    const { provider, model, result } = await r.streamChat({ ...tutorInput, onEnd });
    expect(provider).toBe("anthropic");
    expect(model).toBe("claude-haiku-5-5");
    expect(ANTHROPIC_SMALL_MODEL).toBe("claude-haiku-5-5");
    expect(await result.text).toBe("A cell is a small room.");
    expect(ai.calls).toHaveLength(0);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${ANTH}/v1/messages`);
    expect(sent[0].headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": "2026-10-21" });
    // Claude Haiku 5.5 has no server-side fallback: no beta header, no `fallbacks`.
    expect(sent[0].headers).not.toHaveProperty("anthropic-beta");
    const body = sent[0].body;
    // The free path's cap (1500) does not apply: the paid path has its own.
    expect(body).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 500, stream: true, thinking: { type: "disabled" }, output_config: { effort: "low" } });
    expect(body).not.toHaveProperty("fallbacks");
    expect(body).not.toHaveProperty("temperature");
    // The provider's usage reaches onEnd: uncached input, cache reads and writes, output.
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
    expect(onEnd.mock.calls[0][0]).toEqual({ text: "A cell is a small room.", usage: { input: 10, output: 12, cacheRead: 700, cacheWrite: 0 } });
    // The breakpoint sits on the lecture text, after the stable rules, before the volatile part.
    expect(body.system).toEqual([
      { type: "text", text: "RULES-1a2b explain from zero" },
      { type: "text", text: "LECTURE-TEXT-3c4d the section", cache_control: { type: "ephemeral" } },
      { type: "text", text: "WHERE-5e6f lecture 3" },
    ]);
    expect(body.messages).toEqual([{ role: "user", content: PROMPT }]);

    await vi.waitFor(async () => expect(await rows()).toHaveLength(1));
    expect(await rows()).toMatchObject([{ provider: "anthropic", model: "claude-haiku-5-5", job: "tutor", ok: true }]);
    // Never the prompt or the key in the row, and nothing printed.
    expect(JSON.stringify(await rows())).not.toContain(PROMPT);
    expect(JSON.stringify(await rows())).not.toContain(KEY);
    expect(logs).toEqual([]);
  });

  it("`level: \"balanced\"` uses Claude Sonnet 5.5, capped at 800, thinking off its own way, with the refusal fallback", async () => {
    const { r, sent } = paidRouter(ok("Balanced."));
    const { provider, model, result } = await r.streamChat({ ...tutorInput, level: "balanced" });
    expect([provider, model]).toEqual(["anthropic", "claude-sonnet-5-5"]);
    expect(ANTHROPIC_BALANCED_MODEL).toBe("claude-sonnet-5-5");
    expect(await result.text).toBe("Balanced.");
    expect(sent[0].headers).toMatchObject({ "anthropic-beta": "server-side-fallback-2026-07-01" });
    // Claude Sonnet 5.5: `disabled` is a 400; `between_tools` (alone, effort high or below) is its "off".
    expect(sent[0].body).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 800,
      thinking: { type: "between_tools" },
      fallbacks: "default",
      output_config: { effort: "low" },
    });
    expect(Object.keys(sent[0].body.thinking as object)).toEqual(["type"]);
    expect(sent[0].body).not.toHaveProperty("temperature");
  });

  it("`level: \"deep\"` runs on Claude Fable 5.2, capped at 1,200, with the server-side refusal fallback", async () => {
    const { r, sent } = paidRouter(ok("Deeper."));
    const { provider, model, result } = await r.streamChat({ ...tutorInput, level: "deep" });
    expect([provider, model]).toEqual(["anthropic", "claude-fable-5-2"]);
    expect(ANTHROPIC_DEEP_MODEL).toBe("claude-fable-5-2");
    expect(await result.text).toBe("Deeper.");
    expect(sent[0].headers).toMatchObject({ "anthropic-beta": "server-side-fallback-2026-07-01" });
    expect(sent[0].body).toMatchObject({ model: "claude-fable-5-2", max_tokens: 1200, fallbacks: "default", output_config: { effort: "low" } });
    // Claude Fable 5.2 always thinks: any `thinking` setting but adaptive is a 400, so none is sent.
    expect(sent[0].body).not.toHaveProperty("thinking");
  });

  it("the large model is reached only by an explicit `level: \"deep\"`, and every level needs the paid tutor path", async () => {
    const { r, sent } = paidRouter(ok("Small."));
    for (let i = 0; i < 3; i++) await (await r.streamChat(tutorInput)).result.text;
    await (await r.streamChat({ ...tutorInput, level: "quick" })).result.text;
    await (await r.streamChat({ ...tutorInput, level: "balanced" })).result.text;
    expect(sent.map((x) => x.body.model)).toEqual([
      "claude-haiku-5-5",
      "claude-haiku-5-5",
      "claude-haiku-5-5",
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
    ]);
    // Without `paid`, or from another job, a level is refused before anything is sent.
    const { paid: _paid, ...unpaid } = tutorInput;
    void _paid;
    await expect(r.streamChat({ ...unpaid, level: "deep" })).rejects.toBeInstanceOf(PaidNotAllowed);
    await expect(r.streamChat({ ...unpaid, level: "balanced" })).rejects.toBeInstanceOf(PaidNotAllowed);
    await expect(r.streamChat({ ...tutorInput, level: "deep", job: "assignment-chat" })).rejects.toBeInstanceOf(PaidNotAllowed);
    expect(sent).toHaveLength(5);
  });

  it("`level: \"deep\"` with no key goes to the free providers: nothing calls Anthropic", async () => {
    ai.queue("groq", { text: "Free deeper." });
    const { r, sent } = paidRouter(ok("never"), { ANTHROPIC_API_KEY: undefined });
    const { provider, result } = await r.streamChat({ ...tutorInput, level: "deep" });
    expect(provider).toBe("groq");
    expect(await result.text).toBe("Free deeper.");
    expect(sent).toHaveLength(0);
  });

  it("a refusal before any text falls back to the free providers, with one line printed", async () => {
    ai.queue("groq", { text: "Free instead." });
    const refused = () => new Response(sse("", [], "refusal").replace(/event: content_block_delta[^\n]*\n[^\n]*\n\n/g, ""), { status: 200 });
    const { r, sent } = paidRouter(refused);
    const { provider, result } = await r.streamChat(tutorInput);
    expect(provider).toBe("groq");
    expect(await result.text).toBe("Free instead.");
    expect(sent).toHaveLength(1);
    expect(logs).toEqual([["tutor: anthropic refused 200 refusal"]]);
    // A refusal is not a limit: no cool-down.
    expect(await t.db.select().from(providerCooldowns)).toEqual([]);
  });

  it("an error event before any text is a failed attempt: free providers, a cool-down, one line", async () => {
    ai.queue("groq", { text: "Free again." });
    const overloaded = () =>
      new Response(
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", usage: { input_tokens: 1 } } })}\n\n` +
          `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "PRIVATE" } })}\n\n`,
        { status: 200 },
      );
    const { r } = paidRouter(overloaded);
    expect((await r.streamChat(tutorInput)).provider).toBe("groq");
    expect(logs).toEqual([["tutor: anthropic refused 200 overloaded_error"]]);
    expect(await t.db.select().from(providerCooldowns)).toMatchObject([{ provider: "anthropic" }]);
  });

  it("the tutor on Groq's gpt-oss sends reasoning_effort low; other jobs send nothing new", async () => {
    const LARGE = PROVIDERS.large[0];
    expect(LARGE.model).toBe("openai/gpt-oss-120b");
    const r = router([LARGE], { env: { ...ENV, ANTHROPIC_API_KEY: undefined } });
    ai.queue("groq", { text: "a" }, { text: "b" });
    await (await r.streamChat({ ...tutorInput, size: "large" })).result.text;
    await (await r.streamChat({ ...input, size: "large", job: "assignment-chat" })).result.text;
    expect(ai.calls[0].body).toMatchObject({ reasoning_effort: "low" });
    expect(ai.calls[1].body).not.toHaveProperty("reasoning_effort");
  });

  it("with no key, nothing calls Anthropic: the tutor uses the free providers", async () => {
    ai.queue("groq", { text: "Free answer." });
    const { r, sent } = paidRouter(ok("never"), { ANTHROPIC_API_KEY: undefined });
    const { provider, result } = await r.streamChat(tutorInput);
    expect(provider).toBe("groq");
    expect(await result.text).toBe("Free answer.");
    expect(sent).toHaveLength(0);
    // The free path gets the parts joined, and the answer cap.
    const first = ai.calls[0].body as { messages: { role: string; content: string }[]; max_tokens?: number; max_completion_tokens?: number };
    expect(first.messages[0]).toMatchObject({ role: "system" });
    expect(first.messages[0].content).toContain("RULES-1a2b");
    expect(first.messages[0].content).toContain("LECTURE-TEXT-3c4d");
    expect(first.max_tokens ?? first.max_completion_tokens).toBe(1500);
  });

  for (const code of [401, 403, 429, 500, 529]) {
    it(`a ${code} from Anthropic falls back to the free providers and cools Anthropic down`, async () => {
      ai.queue("groq", { text: "Free after all." });
      const { r, sent } = paidRouter(status(code));
      const { provider, result } = await r.streamChat(tutorInput);
      expect(provider).toBe("groq");
      expect(await result.text).toBe("Free after all.");
      expect(sent).toHaveLength(1);
      const [cooldown] = await t.db.select().from(providerCooldowns);
      expect(cooldown).toMatchObject({ provider: "anthropic" });
      await vi.waitFor(async () => expect(await rows()).toHaveLength(2));
      expect((await rows()).map((row) => [row.provider, row.ok])).toEqual([
        ["anthropic", false],
        ["groq", true],
      ]);
      // Exactly one line: the status and the error's type. Never its message, the key or the prompt.
      expect(logs).toEqual([[`tutor: anthropic refused ${code} x`]]);
      expect(JSON.stringify(logs)).not.toContain("PRIVATE");

      // While it cools down, the next message does not try the broken key again.
      ai.queue("groq", { text: "Again free." });
      expect((await r.streamChat(tutorInput)).provider).toBe("groq");
      expect(sent).toHaveLength(1);
    });
  }

  it("a network error, or a 400, also falls back (without a cool-down for the 400)", async () => {
    ai.queue("groq", { text: "Free one." });
    const down = paidRouter(() => {
      throw new TypeError("fetch failed");
    });
    expect((await down.r.streamChat(tutorInput)).provider).toBe("groq");

    ai.queue("groq", { text: "Free two." });
    const bad = paidRouter(status(400));
    expect((await bad.r.streamChat(tutorInput)).provider).toBe("groq");
    expect(await t.db.select().from(providerCooldowns)).toEqual([]);
    expect(logs).toEqual([["tutor: anthropic refused none network_error"], ["tutor: anthropic refused 400 x"]]);
  });

  it("Anthropic and every free provider busy: AiBusy", async () => {
    ai.queue("groq", { status: 429 });
    ai.queue("openrouter", { status: 503 });
    const { r } = paidRouter(status(529));
    await expect(r.streamChat(tutorInput)).rejects.toBeInstanceOf(AiBusy);
  });

  it("an error event part-way ends the stream with an error and onEnd is not called", async () => {
    const broken = () =>
      new Response(sse("Half an", [`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "PRIVATE" } })}\n\n`]), {
        status: 200,
      });
    const onEnd = vi.fn();
    const { r } = paidRouter(broken);
    const { provider, result } = await r.streamChat({ ...tutorInput, onEnd });
    expect(provider).toBe("anthropic");
    const seen: string[] = [];
    for await (const part of result.fullStream) seen.push(part.type);
    expect(seen).toContain("error");
    expect(onEnd).not.toHaveBeenCalled();
    expect(logs).toEqual([["tutor: anthropic refused 200 overloaded_error"]]);
  });

  it("no other job can reach it: paid with another job throws before anything is sent", async () => {
    const { r, sent } = paidRouter(ok("never"));
    await expect(r.streamChat({ ...tutorInput, job: "assignment-chat" })).rejects.toBeInstanceOf(PaidNotAllowed);
    await expect(
      r.streamChat({ ...tutorInput, paid: "anything" as unknown as "tutor" }),
    ).rejects.toBeInstanceOf(PaidNotAllowed);
    expect(sent).toHaveLength(0);
    expect(ai.calls).toHaveLength(0);
  });

  it("runText, runObject and streamChat without `paid` never fall through to it, even with the key and every free provider busy", async () => {
    const { r, sent } = paidRouter(ok("never"));
    for (const job of ["explain-card", TUTOR_JOB]) {
      ai.queue("groq", { status: 429 }, { status: 429 }, { status: 429 });
      ai.queue("openrouter", { status: 500 }, { status: 500 }, { status: 500 });
      await t.db.delete(providerCooldowns);
      await expect(r.runText({ ...input, job })).rejects.toBeInstanceOf(AiBusy);
      await t.db.delete(providerCooldowns);
      await expect(r.runObject({ ...input, job, schema: z.object({ ok: z.boolean() }) })).rejects.toBeInstanceOf(AiBusy);
      await t.db.delete(providerCooldowns);
      await expect(r.streamChat({ ...input, job })).rejects.toBeInstanceOf(AiBusy);
    }
    expect(sent).toHaveLength(0);
    expect((await rows()).some((row) => row.provider === "anthropic")).toBe(false);
  });

  it("AI_FAKE_URL sends it to the fake's `anthropic` route, under the same safety rules", async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      urls.push(String(url));
      if (String(url).includes("/anthropic/")) return new Response(sse("Faked."), { status: 200 });
      return globalThis.fetch(url, init);
    };
    const make = (env: Record<string, string | undefined>) =>
      createRouter({ providers: table([GROQ]), env: { ...ENV, ANTHROPIC_API_KEY: KEY, ...env }, database: t.db, now: () => NOW, fetch });

    const local = make({ NODE_ENV: "development", AI_FAKE_URL: ai.url });
    expect(await (await local.streamChat(tutorInput)).result.text).toBe("Faked.");
    expect(urls).toEqual([`${ai.url}/anthropic/v1/messages`]);

    // On Vercel, in production or for another host, the switch is dead: the real address is used.
    for (const env of [
      { NODE_ENV: "development", AI_FAKE_URL: ai.url, VERCEL: "1" },
      { NODE_ENV: "production", AI_FAKE_URL: ai.url },
      { NODE_ENV: "development", AI_FAKE_URL: "http://example.com:9" },
    ]) {
      urls.length = 0;
      const real: typeof globalThis.fetch = async (url) => {
        urls.push(String(url));
        throw new TypeError("no network in tests");
      };
      ai.queue("groq", { text: "free" });
      const r = createRouter({
        providers: table([GROQ]),
        env: { ...ENV, ANTHROPIC_API_KEY: KEY, ...env },
        database: t.db,
        now: () => NOW,
        fetch: real,
        baseUrlFor: () => `${ai.url}/groq/v1`,
      });
      await expect(r.streamChat(tutorInput)).rejects.toBeInstanceOf(AiBusy);
      expect(urls[0]).toBe("https://api.anthropic.com/v1/messages");
      await t.db.delete(providerCooldowns);
    }
  });
});
