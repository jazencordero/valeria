// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDb, type TestDb } from "@/server/db/test-db";
import { aiCalls, providerCooldowns } from "@/server/db/schema/system";
import { BROKEN_JSON, startFakeAi, type FakeAi } from "../../../tests/fake-ai/server";
import { PROVIDERS, type ProviderEntry, type SizeClass } from "./providers.config";
import { AiBadOutput, AiBusy, createRouter, NotFree, retryAfterMs, type RouterDeps } from "./router";

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
