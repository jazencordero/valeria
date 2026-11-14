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
 * `createRouter(deps)` takes the provider table, env, database, clock, fetch and a base URL
 * override, so tests can point it at `tests/fake-ai/server.ts`.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText, streamText, type LanguageModel, type ModelMessage } from "ai";
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
};

export type RunInput = {
  size: SizeClass;
  system?: string;
  messages: ModelMessage[];
  /** What the call is for, stored in `ai_calls.job`. */
  job: string;
  userId?: string | null;
};

export type Picked = { entry: ProviderEntry; provider: ProviderName; model: string };

export type RunTextResult = Picked & { text: string };
export type RunObjectResult<T> = Picked & { object: T };
export type StreamChatResult = Picked & { result: ReturnType<typeof streamText> };

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
    const baseUrl = deps.baseUrlFor ? deps.baseUrlFor(entry) : resolved;
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

  async function writeCooldown(provider: ProviderName, error: APICallError) {
    const ms = retryAfterMs(error.responseHeaders, now()) ?? DEFAULT_COOLDOWN_MS;
    const until = new Date(now().getTime() + ms);
    await database()
      .insert(providerCooldowns)
      .values({ provider, until })
      .onConflictDoUpdate({ target: providerCooldowns.provider, set: { until } });
  }

  async function logCall(c: Picked, input: RunInput, ok: boolean, ms: number) {
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
   * Streams a chat answer. Falls through to the next provider when the first HTTP response is
   * not a success (a limit or server error also writes a cool-down); once a provider has
   * answered, the stream is the caller's. The `ai_calls` row is written when the stream ends.
   */
  async function streamChat(input: RunInput): Promise<StreamChatResult> {
    return withFallback(input, async (c) => {
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
        model: modelFor(c, false, watchedFetch),
        instructions: input.system,
        messages: input.messages,
        maxRetries: 0,
        // Without onError the SDK prints the error, and its error carries the request body.
        onError: async ({ error }) => {
          streamError = error;
          settle({ ended: true });
          await log(false);
        },
        onEnd: async () => {
          settle({ ended: true });
          await log(true);
        },
      });

      const answer = await first;
      if ("status" in answer && answer.status >= 200 && answer.status < 300) {
        return { entry: c.entry, provider: c.provider, model: c.model, result };
      }
      // Not usable: drain the failed stream quietly, log the attempt, and let withFallback move on.
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
    });
  }

  return { pick, runText, runObject, streamChat };
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
