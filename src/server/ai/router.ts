/*
 * The AI router: smallest model that fits, next provider on a limit, never a paid one.
 *
 *   const { text } = await runText({ size: "small", system, messages, userId, job: "explain-card" });
 *   const { object } = await runObject({ size: "medium", system, messages, job: "split-note", schema });
 *   const { result } = await streamChat({ size: "large", system, messages, job: "assignment-chat" });
 *   return result.toUIMessageStreamResponse();
 *
 * - Providers are tried in the order `PROVIDERS[size]` lists them. One is skipped when its
 *   env key (or Cloudflare's account id) is missing, or while `provider_cooldowns` says it is
 *   cooling down.
 * - Before any network call every entry for the size is checked against `FREE_MODELS`; a model
 *   outside it throws `NotFree`.
 * - HTTP 429 or 5xx: a cool-down is written for that provider (the `retry-after` header, else
 *   60 seconds) and the next provider is tried. Any other failed call (network, 4xx) also moves
 *   on, without a cool-down. When no provider is left: `AiBusy`.
 * - `runObject` sends `response_format: json_object` where the config says `jsonMode`, always
 *   asks for JSON matching the schema, validates it with zod, and asks the same provider once to
 *   repair a bad answer. A second bad answer throws `AiBadOutput`.
 * - One `ai_calls` row per HTTP attempt (provider, model, job, ok, ms, user). Prompts, answers
 *   and keys are never logged, and thrown errors never carry the request body.
 *
 * - `streamChat` also takes plain tool definitions (`{ description, inputSchema, execute }`), wraps
 *   them for the SDK here, lets the model call them for up to `maxToolRounds` rounds, and calls
 *   `onEnd` once with the whole reply when the stream ended without an error (M2-14).
 *
 * `createRouter(deps)` takes the provider table, env, database, clock, fetch and a base URL
 * override, so tests can point it at `tests/fake-ai/server.ts`.
 *
 * The tutor's optional paid path (M2-28). `streamChat({ ..., job: "tutor", paid: "tutor" })` is the
 * ONLY way to reach the `anthropic` provider, and only when `ANTHROPIC_API_KEY` is set:
 * - `anthropic` is not in `PROVIDERS` or `FREE_MODELS`, so `withFallback` (runText, runObject,
 *   streamChat without `paid`) can never pick it, whatever the job.
 * - `paid` with any job other than `TUTOR_JOB`, or any value other than "tutor", throws
 *   `PaidNotAllowed` before anything is sent.
 * - With the key set it is tried first; a limit (429, 5xx, 529) writes its cool-down as for any
 *   provider, and then, like any other failed first response, the tutor falls back to the free
 *   providers for the same size. Without the key the paid path is skipped without a word.
 * - It speaks Anthropic's Messages API over plain `fetch` with SSE streaming (no Anthropic SDK is
 *   installed and package.json is not ours to change), as a small AI SDK model (`anthropicModel`),
 *   so the stream, `onEnd`, the cool-downs and the `ai_calls` row work exactly as for the others.
 *   `systemParts` marked `cache` get a prompt-cache breakpoint there (the free path joins them).
 *
 * Test-only switch (M2-23): `AI_FAKE_URL` points a running dev server at the fake AI, so the
 * whole-flow tests (tests/e2e/chat.spec.ts) can script replies. See `fakeAiUrl` below for when
 * it is honoured; everywhere else it is ignored without a word. The allow-list still applies,
 * and a provider still needs its env key to be picked.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  generateText,
  isStepCount,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { gt } from "drizzle-orm";
import { z } from "zod";
import { db as defaultDb, type Db } from "@/server/db/client";
import { aiCalls, providerCooldowns } from "@/server/db/schema/system";
import {
  isFreeModel,
  PROVIDERS,
  resolveBaseUrl,
  type ProviderEntry,
  type ProviderName,
  type SizeClass,
} from "./providers.config";

export const DEFAULT_COOLDOWN_MS = 60_000;

/** Every provider for the size is limited, cooling down, unconfigured or failing. */
export class AiBusy extends Error {
  constructor(readonly size: SizeClass) {
    super(`No free AI provider is available for size "${size}" right now.`);
    this.name = "AiBusy";
  }
}

/** The config lists a model that is not on the free allow-list. Nothing was sent. */
export class NotFree extends Error {
  constructor(
    readonly provider: string,
    readonly model: string,
  ) {
    super(`Refusing ${provider}:${model}: it is not in FREE_MODELS.`);
    this.name = "NotFree";
  }
}

/** A call asked for the paid provider from a job that may not use it. Nothing was sent. */
export class PaidNotAllowed extends Error {
  constructor(readonly job: string) {
    super(`Job "${job}" may not use the paid provider.`);
    this.name = "PaidNotAllowed";
  }
}

/** The only job that may ask for the paid provider (`paid: "tutor"`). */
export const TUTOR_JOB = "tutor";
/** Anthropic's model for the tutor (claude-api skill, model table cached 2026-11-03). */
export const ANTHROPIC_MODEL = "claude-fable-5-2";
export const ANTHROPIC_ENV_KEY = "ANTHROPIC_API_KEY";
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
/** Anthropic API version header (claude-api skill, curl examples). */
export const ANTHROPIC_VERSION = "2026-10-21";
/** Server-side refusal fallback, opted into by default for claude-fable-5-2 (claude-api skill). */
export const ANTHROPIC_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** The model's answer was not valid JSON for the schema, even after one repair. */
export class AiBadOutput extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly model: string,
    readonly issue: string,
  ) {
    super(`${provider}:${model} did not return valid JSON for the schema after one repair: ${issue}`);
    this.name = "AiBadOutput";
  }
}

export type RouterDeps = {
  providers?: Record<SizeClass, readonly ProviderEntry[]>;
  env?: Record<string, string | undefined>;
  database?: Db;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  /** Replace the resolved base URL, e.g. to point at the fake server. */
  baseUrlFor?: (entry: ProviderEntry) => string;
  /** Replace Anthropic's base URL (`https://api.anthropic.com`), e.g. in tests. */
  anthropicBaseUrl?: string;
};

/** One block of a system prompt. `cache` puts a prompt-cache breakpoint after it (Anthropic only). */
export type SystemPart = { text: string; cache?: boolean };

export type RunInput = {
  size: SizeClass;
  system?: string;
  messages: ModelMessage[];
  /** What the call is for, stored in `ai_calls.job`. */
  job: string;
  userId?: string | null;
};

/** A tool as plain data, so files outside `src/server/ai/` can define one without the AI SDK. */
export type PlainTool = {
  description: string;
  inputSchema: z.ZodType;
  // `never`: a tool that takes a narrower input than `unknown` still fits.
  execute: (input: never) => Promise<unknown>;
};

/** What `onEnd` gets: the text of every step, in order, joined by a blank line. */
export type StreamChatEnd = { text: string };

export type StreamChatInput = RunInput & {
  /** Tools the model may call. Undefined entries are skipped; none means a plain chat. */
  tools?: Record<string, PlainTool | undefined>;
  /** How many rounds of tool calls the model gets before it must answer. Default 0. */
  maxToolRounds?: number;
  /**
   * Called once when the whole reply has streamed without an error. Not called when the stream
   * failed, at the start or part-way. Awaited before the stream closes.
   */
  onEnd?: (event: StreamChatEnd) => void | Promise<void>;
  /** The answer's length cap, sent to the provider as max output tokens. */
  maxOutputTokens?: number;
  /** The system prompt in blocks; joined for the free providers. Used instead of `system` when set. */
  systemParts?: SystemPart[];
  /** "tutor": try the paid provider first when its key is set. Only for `job: TUTOR_JOB`. */
  paid?: "tutor";
};

export type Picked = { entry: ProviderEntry; provider: ProviderName; model: string };

export type RunTextResult = Picked & { text: string };
export type RunObjectResult<T> = Picked & { object: T };
/** `entry` is null and `provider` is "anthropic" when the tutor's paid path answered. */
export type StreamChatResult = {
  entry: ProviderEntry | null;
  provider: ProviderName | "anthropic";
  model: string;
  result: ReturnType<typeof streamText>;
};

/** Who is called: a free provider, or the tutor's paid path (`entry` null). */
type Target = { entry: ProviderEntry | null; provider: ProviderName | "anthropic"; model: string; baseUrl: string };

type Candidate = Picked & { baseUrl: string; apiKey: string };

export function createRouter(deps: RouterDeps = {}) {
  const providers = deps.providers ?? PROVIDERS;
  const env = () => deps.env ?? process.env;
  const database = () => deps.database ?? defaultDb;
  const now = deps.now ?? (() => new Date());

  function assertFree(size: SizeClass) {
    for (const entry of providers[size]) {
      if (!isFreeModel(entry.provider, entry.model)) throw new NotFree(entry.provider, entry.model);
    }
  }

  async function coolingProviders(): Promise<Set<string>> {
    const rows = await database()
      .select({ provider: providerCooldowns.provider })
      .from(providerCooldowns)
      .where(gt(providerCooldowns.until, now()));
    return new Set(rows.map((r) => r.provider));
  }

  function configured(entry: ProviderEntry): Candidate | null {
    const e = env();
    const apiKey = e[entry.envKey];
    if (!apiKey) return null;
    const resolved = resolveBaseUrl(entry, e);
    if (!resolved) return null;
    const fake = deps.baseUrlFor ? null : fakeAiUrl(e);
    const baseUrl = deps.baseUrlFor ? deps.baseUrlFor(entry) : fake ? `${fake}/${entry.provider}/v1` : resolved;
    return { entry, provider: entry.provider, model: entry.model, baseUrl, apiKey };
  }

  /** The first configured provider for `size` that is not cooling down, or null. */
  async function pick(size: SizeClass): Promise<Picked | null> {
    assertFree(size);
    const cooling = await coolingProviders();
    for (const entry of providers[size]) {
      if (cooling.has(entry.provider)) continue;
      const c = configured(entry);
      if (c) return { entry: c.entry, provider: c.provider, model: c.model };
    }
    return null;
  }

  async function writeCooldown(provider: string, error: APICallError) {
    const ms = retryAfterMs(error.responseHeaders, now()) ?? DEFAULT_COOLDOWN_MS;
    const until = new Date(now().getTime() + ms);
    await database()
      .insert(providerCooldowns)
      .values({ provider, until })
      .onConflictDoUpdate({ target: providerCooldowns.provider, set: { until } });
  }

  async function logCall(c: { provider: string; model: string }, input: RunInput, ok: boolean, ms: number) {
    await database()
      .insert(aiCalls)
      .values({ provider: c.provider, model: c.model, job: input.job, ok, ms: Math.round(ms), userId: input.userId ?? null });
  }

  /** One HTTP call, timed and logged. */
  async function attempt<T>(c: Picked, input: RunInput, call: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      const out = await call();
      await logCall(c, input, true, performance.now() - started);
      return out;
    } catch (error) {
      await logCall(c, input, false, performance.now() - started);
      throw error;
    }
  }

  function modelFor(c: Candidate, jsonMode: boolean, fetch = deps.fetch): LanguageModel {
    const provider = createOpenAICompatible({
      name: c.provider,
      baseURL: c.baseUrl,
      apiKey: c.apiKey,
      fetch,
      transformRequestBody: jsonMode ? (body) => ({ ...body, response_format: { type: "json_object" } }) : undefined,
    });
    return provider.chatModel(c.model);
  }

  /**
   * Runs `fn` on each usable provider in turn. A limit or server error writes a cool-down and
   * moves on; other provider failures move on; our own errors (NotFree, AiBadOutput, bugs) stop.
   */
  async function withFallback<T>(input: RunInput, fn: (c: Candidate) => Promise<T>): Promise<T> {
    assertFree(input.size);
    const cooling = await coolingProviders();
    for (const entry of providers[input.size]) {
      if (cooling.has(entry.provider)) continue;
      const c = configured(entry);
      if (!c) continue;
      try {
        return await fn(c);
      } catch (error) {
        if (!APICallError.isInstance(error)) throw error;
        if (isLimit(error.statusCode)) {
          await writeCooldown(c.provider, error);
          cooling.add(c.provider);
        }
      }
    }
    throw new AiBusy(input.size);
  }

  async function runText(input: RunInput): Promise<RunTextResult> {
    return withFallback(input, async (c) => {
      const { text } = await attempt(c, input, () =>
        generateText({ model: modelFor(c, false), instructions: input.system, messages: input.messages, maxRetries: 0 }),
      );
      return { entry: c.entry, provider: c.provider, model: c.model, text };
    });
  }

  async function runObject<T>(input: RunInput & { schema: z.ZodType<T> }): Promise<RunObjectResult<T>> {
    const instructions = [input.system, jsonInstruction(input.schema)].filter(Boolean).join("\n\n");
    return withFallback(input, async (c) => {
      const model = modelFor(c, c.entry.jsonMode);
      const ask = (messages: ModelMessage[]) =>
        attempt(c, input, () => generateText({ model, instructions, messages, maxRetries: 0 }));

      const first = await ask(input.messages);
      const parsed = parseJson(first.text, input.schema);
      if (parsed.ok) return { entry: c.entry, provider: c.provider, model: c.model, object: parsed.value };

      const repaired = await ask([
        ...input.messages,
        { role: "assistant", content: first.text },
        {
          role: "user",
          content: `That answer was not valid: ${parsed.issue}. Reply again with only the corrected JSON, nothing else.`,
        },
      ]);
      const second = parseJson(repaired.text, input.schema);
      if (second.ok) return { entry: c.entry, provider: c.provider, model: c.model, object: second.value };
      throw new AiBadOutput(c.provider, c.model, second.issue);
    });
  }

  /**
   * One streamed attempt on `c`. Resolves with the stream once the first HTTP response is a
   * success; otherwise drains it, logs the attempt and throws an `APICallError` (or our own
   * error when nothing was sent). The `ai_calls` row is written when the stream ends.
   */
  async function streamOn(
    c: Target,
    input: StreamChatInput,
    model: (fetch: typeof globalThis.fetch) => LanguageModel,
    system: string | undefined,
  ): Promise<StreamChatResult> {
    const tools = sdkTools(input.tools);
    const rounds = tools ? Math.max(0, Math.floor(input.maxToolRounds ?? 0)) : 0;
    const started = performance.now();
    let logged = false;
    const log = async (ok: boolean) => {
      if (logged) return;
      logged = true;
      await logCall(c, input, ok, performance.now() - started);
    };

    type First = { status: number; headers: Record<string, string> } | { error: unknown } | { ended: true };
    let settle!: (first: First) => void;
    const first = new Promise<First>((resolve) => (settle = resolve));
    const baseFetch = deps.fetch ?? globalThis.fetch;
    const watchedFetch: typeof globalThis.fetch = async (url, init) => {
      try {
        const res = await baseFetch(url, init);
        settle({ status: res.status, headers: Object.fromEntries(res.headers.entries()) });
        return res;
      } catch (error) {
        settle({ error });
        throw error;
      }
    };

    let streamError: unknown;
    const result = streamText({
      model: model(watchedFetch),
      instructions: system,
      messages: input.messages,
      maxRetries: 0,
      maxOutputTokens: input.maxOutputTokens,
      tools,
      // One step per round of tool calls, plus the step that writes the answer.
      stopWhen: isStepCount(rounds + 1),
      // Without onError the SDK prints the error, and its error carries the request body.
      onError: async ({ error }) => {
        streamError = error;
        settle({ ended: true });
        await log(false);
      },
      onEnd: async ({ steps }) => {
        settle({ ended: true });
        await log(true);
        if (input.onEnd && streamError === undefined) {
          await input.onEnd({ text: steps.map((step) => step.text).filter(Boolean).join("\n\n") });
        }
      },
    });

    const answer = await first;
    if ("status" in answer && answer.status >= 200 && answer.status < 300) {
      return { entry: c.entry, provider: c.provider, model: c.model, result };
    }
    // Not usable: drain the failed stream quietly, log the attempt, and let the caller move on.
    await result.consumeStream({ onError: () => {} });
    await log(false);
    // Failed before any HTTP call (e.g. a bad prompt): our error, not the provider's.
    if ("ended" in answer && streamError !== undefined && !APICallError.isInstance(streamError)) throw streamError;
    throw new APICallError({
      message: `${c.provider} answered ${"status" in answer ? answer.status : "without a response"}`,
      url: c.baseUrl,
      requestBodyValues: undefined,
      statusCode: "status" in answer ? answer.status : undefined,
      responseHeaders: "headers" in answer ? answer.headers : undefined,
    });
  }

  /** Anthropic's address for the tutor, or null when there is no key. Same fake switch as the rest. */
  function anthropicTarget(): (Target & { apiKey: string }) | null {
    const e = env();
    const apiKey = e[ANTHROPIC_ENV_KEY];
    if (!apiKey) return null;
    const fake = deps.anthropicBaseUrl ? null : fakeAiUrl(e);
    const baseUrl = deps.anthropicBaseUrl ?? (fake ? `${fake}/anthropic` : ANTHROPIC_BASE_URL);
    return { entry: null, provider: "anthropic", model: ANTHROPIC_MODEL, baseUrl, apiKey };
  }

  /**
   * The tutor's paid attempt: null when there is no key, Anthropic is cooling down, or it failed
   * in any way before the answer started (then the free providers take over). A limit, or a key
   * it refuses (401, 403), writes a cool-down so a broken key is not retried on every message.
   */
  async function tryAnthropic(input: StreamChatInput): Promise<StreamChatResult | null> {
    const target = anthropicTarget();
    if (!target) return null;
    if ((await coolingProviders()).has("anthropic")) return null;
    const parts = input.systemParts ?? (input.system ? [{ text: input.system }] : []);
    try {
      return await streamOn(
        target,
        input,
        (fetch) => anthropicModel({ baseUrl: target.baseUrl, apiKey: target.apiKey, system: parts, fetch }),
        undefined,
      );
    } catch (error) {
      if (APICallError.isInstance(error)) {
        const status = error.statusCode;
        if (isLimit(status) || status === 401 || status === 403) await writeCooldown("anthropic", error);
      }
      // Whatever went wrong (network, a bad key, a limit, a bug in the stream), the free
      // providers still answer: a key that does not work never breaks the tutor.
      return null;
    }
  }

  /**
   * Streams a chat answer. Falls through to the next provider when the first HTTP response is
   * not a success (a limit or server error also writes a cool-down); once a provider has
   * answered, the stream is the caller's. With `paid: "tutor"` the paid provider goes first
   * (see the header).
   */
  async function streamChat(input: StreamChatInput): Promise<StreamChatResult> {
    if (input.paid !== undefined) {
      if (input.paid !== "tutor" || input.job !== TUTOR_JOB) throw new PaidNotAllowed(input.job);
      const paid = await tryAnthropic(input);
      if (paid) return paid;
    }
    const system = input.systemParts ? input.systemParts.map((p) => p.text).join("\n\n") : input.system;
    return withFallback(input, (c) => streamOn(c, input, (fetch) => modelFor(c, false, fetch), system));
  }

  return { pick, runText, runObject, streamChat };
}

/**
 * The fake AI's address from `AI_FAKE_URL`, or null. Honoured only when ALL of these hold:
 * - its host is exactly `localhost` or `127.0.0.1`, over plain http or https, so a provider key
 *   can never be sent to another machine through this switch;
 * - no `VERCEL*` variable has a value: Vercel sets `VERCEL=1` (and more) on every build and
 *   deploy, previews included, so the switch is dead there whatever else is configured. (An
 *   empty value counts as not set: playwright.config.ts blanks the names a pulled `.env.local`
 *   may carry, which is also what keeps Next from loading them from that file.)
 * - `NODE_ENV` is not "production" (`next build` / `next start`, anywhere).
 * Anything else: null, silently. The first path segment the router adds is the provider's name,
 * which is the fake's "route" (tests/fake-ai/server.ts).
 */
export function fakeAiUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.AI_FAKE_URL;
  if (!raw) return null;
  if (env.NODE_ENV === "production" || process.env.NODE_ENV === "production") return null;
  if (Object.keys(env).some((key) => key.startsWith("VERCEL") && env[key])) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null;
  if (url.username || url.password) return null;
  return url.origin;
}

// ---------------------------------------------------------------------------
// The tutor's paid path: Anthropic's Messages API over plain fetch (M2-28)
//
// Shapes from the claude-api skill (curl examples, prompt caching, model notes), checked
// 2026-11-15. No Anthropic SDK is installed, so this is raw HTTP:
// - POST {base}/v1/messages, headers `x-api-key`, `anthropic-version: 2026-10-21`, and
//   `anthropic-beta: server-side-fallback-2026-07-01` for `fallbacks: "default"` (on a policy
//   decline Anthropic re-runs the request on its own fallback model inside the same call).
// - `stream: true`: server-sent events `message_start`, `content_block_start`,
//   `content_block_delta` (`text_delta`), `content_block_stop`, `message_delta` (stop_reason,
//   output usage), `message_stop`, and `error`.
// - claude-fable-5-2 always thinks: `thinking` is left out (anything but adaptive is a 400) and
//   `output_config.effort` is "low", because thinking counts against `max_tokens` and the tutor's
//   answers are capped. Its thinking blocks stream with empty text by default; they are skipped.
// - No `temperature`/`top_p`/`top_k` (a 400 on 2026-10-21) and no assistant prefill.
// - Prompt caching: `cache_control: {type: "ephemeral"}` on the system block marked `cache`
//   (the lecture text). The prefix up to it (rules, then the material) is cached for 5 minutes.
//   Prefixes under 512 tokens on this model silently do not cache.
// Prompts, answers and the key are never logged; errors carry no request body.

const ANTHROPIC_EFFORT = "low";
const DEFAULT_TUTOR_MAX_TOKENS = 1500;

type AnthropicOptions = {
  baseUrl: string;
  apiKey: string;
  system: SystemPart[];
  fetch: typeof globalThis.fetch;
};

type AnthropicMessage = { role: "user" | "assistant"; content: string };

/** The SDK prompt as Anthropic messages: text only, system messages added to `system`. */
function anthropicPrompt(prompt: LanguageModelV4CallOptions["prompt"], system: SystemPart[]) {
  const blocks = [...system];
  const messages: AnthropicMessage[] = [];
  for (const m of prompt) {
    if (m.role === "system") {
      blocks.push({ text: m.content });
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = m.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n\n");
    if (!text) continue;
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${text}`;
    else messages.push({ role: m.role, content: text });
  }
  return {
    system: blocks.map((b) => ({
      type: "text" as const,
      text: b.text,
      ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
    })),
    messages,
  };
}

function finishOf(stop: string | undefined): LanguageModelV4FinishReason {
  const unified =
    stop === "end_turn" || stop === "stop_sequence"
      ? "stop"
      : stop === "max_tokens"
        ? "length"
        : stop === "refusal"
          ? "content-filter"
          : "other";
  return { unified, raw: stop };
}

type SseData = Record<string, unknown> & { type?: string };

/** Anthropic's SSE text as the SDK's stream parts. */
function anthropicParts(): TransformStream<string, LanguageModelV4StreamPart> {
  let buffer = "";
  let stop: string | undefined;
  let usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let finished = false;
  const textBlocks = new Set<number>();

  function finish(controller: TransformStreamDefaultController<LanguageModelV4StreamPart>) {
    if (finished) return;
    finished = true;
    controller.enqueue({
      type: "finish",
      finishReason: finishOf(stop),
      usage: {
        inputTokens: {
          total: usage.input + usage.cacheRead + usage.cacheWrite,
          noCache: usage.input,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
        },
        outputTokens: { total: usage.output, text: undefined, reasoning: undefined },
      },
    });
  }

  function handle(data: SseData, controller: TransformStreamDefaultController<LanguageModelV4StreamPart>) {
    const num = (v: unknown) => (typeof v === "number" ? v : 0);
    switch (data.type) {
      case "message_start": {
        const message = (data.message ?? {}) as Record<string, unknown>;
        const u = (message.usage ?? {}) as Record<string, unknown>;
        usage = {
          input: num(u.input_tokens),
          cacheRead: num(u.cache_read_input_tokens),
          cacheWrite: num(u.cache_creation_input_tokens),
          output: num(u.output_tokens),
        };
        controller.enqueue({
          type: "response-metadata",
          id: typeof message.id === "string" ? message.id : undefined,
          modelId: typeof message.model === "string" ? message.model : undefined,
        });
        return;
      }
      case "content_block_start": {
        const block = (data.content_block ?? {}) as Record<string, unknown>;
        const index = num(data.index);
        if (block.type !== "text") return; // thinking and fallback blocks are not part of the answer
        textBlocks.add(index);
        controller.enqueue({ type: "text-start", id: String(index) });
        if (typeof block.text === "string" && block.text) {
          controller.enqueue({ type: "text-delta", id: String(index), delta: block.text });
        }
        return;
      }
      case "content_block_delta": {
        const index = num(data.index);
        const delta = (data.delta ?? {}) as Record<string, unknown>;
        if (!textBlocks.has(index) || delta.type !== "text_delta" || typeof delta.text !== "string") return;
        controller.enqueue({ type: "text-delta", id: String(index), delta: delta.text });
        return;
      }
      case "content_block_stop": {
        const index = num(data.index);
        if (textBlocks.delete(index)) controller.enqueue({ type: "text-end", id: String(index) });
        return;
      }
      case "message_delta": {
        const delta = (data.delta ?? {}) as Record<string, unknown>;
        if (typeof delta.stop_reason === "string") stop = delta.stop_reason;
        const u = (data.usage ?? {}) as Record<string, unknown>;
        if (typeof u.output_tokens === "number") usage.output = u.output_tokens;
        return;
      }
      case "message_stop":
        finish(controller);
        return;
      case "error": {
        const err = (data.error ?? {}) as Record<string, unknown>;
        // Only the error's type: its message could quote the request.
        controller.enqueue({ type: "error", error: new Error(`anthropic stream error: ${String(err.type ?? "unknown")}`) });
        return;
      }
      default:
        return;
    }
  }

  function drain(controller: TransformStreamDefaultController<LanguageModelV4StreamPart>) {
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        let data: SseData;
        try {
          data = JSON.parse(raw) as SseData;
        } catch {
          continue;
        }
        handle(data, controller);
      }
    }
  }

  return new TransformStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
    },
    transform(chunk, controller) {
      buffer += chunk.replace(/\r\n/g, "\n");
      drain(controller);
    },
    flush(controller) {
      buffer += "\n\n";
      drain(controller);
      if (!finished) {
        if (stop === undefined) controller.enqueue({ type: "error", error: new Error("anthropic stream ended early") });
        finish(controller);
      }
    },
  });
}

/** A streaming-only AI SDK model for the tutor's Anthropic path. */
export function anthropicModel(options: AnthropicOptions): LanguageModelV4 {
  const url = `${options.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  return {
    specificationVersion: "v4",
    provider: "anthropic",
    modelId: ANTHROPIC_MODEL,
    supportedUrls: {},
    async doGenerate() {
      throw new Error("The tutor's Anthropic path only streams.");
    },
    async doStream(call) {
      const { system, messages } = anthropicPrompt(call.prompt, options.system);
      const body = {
        model: ANTHROPIC_MODEL,
        max_tokens: call.maxOutputTokens ?? DEFAULT_TUTOR_MAX_TOKENS,
        stream: true,
        system,
        messages,
        output_config: { effort: ANTHROPIC_EFFORT },
        fallbacks: "default",
      };
      const res = await options.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-beta": ANTHROPIC_FALLBACK_BETA,
        },
        body: JSON.stringify(body),
        signal: call.abortSignal,
      });
      const headers = Object.fromEntries(res.headers.entries());
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new APICallError({
          message: `anthropic answered ${res.status}`,
          url,
          requestBodyValues: undefined,
          statusCode: res.status,
          responseHeaders: headers,
          isRetryable: isLimit(res.status),
        });
      }
      return {
        stream: res.body.pipeThrough(new TextDecoderStream()).pipeThrough(anthropicParts()),
        response: { headers },
      };
    },
  };
}

/** Plain tool definitions as SDK tools, or undefined when there are none. */
function sdkTools(plain: StreamChatInput["tools"]): ToolSet | undefined {
  const out: ToolSet = {};
  for (const [name, def] of Object.entries(plain ?? {})) {
    if (!def) continue;
    out[name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: (input: unknown) => def.execute(input as never),
    });
  }
  return Object.keys(out).length ? out : undefined;
}

function isLimit(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500);
}

/** `retry-after` as milliseconds: seconds or an HTTP date. Null when absent or unreadable. */
export function retryAfterMs(headers: Record<string, string> | undefined, now: Date): number | null {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now.getTime());
}

function jsonInstruction(schema: z.ZodType): string {
  return `Reply with only one JSON value that matches this JSON Schema, no other text:\n${JSON.stringify(z.toJSONSchema(schema))}`;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; issue: string };

function parseJson<T>(text: string, schema: z.ZodType<T>): Parsed<T> {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { ok: false, issue: "it is not valid JSON" };
  }
  const checked = schema.safeParse(value);
  if (checked.success) return { ok: true, value: checked.data };
  const first = checked.error.issues[0];
  const where = first?.path.length ? ` at ${first.path.join(".")}` : "";
  return { ok: false, issue: `it does not match the schema${where}: ${first?.message ?? "invalid"}` };
}

const router = createRouter();
export const pick = router.pick;
export const runText = router.runText;
export const runObject = router.runObject;
export const streamChat = router.streamChat;
