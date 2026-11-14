/*
 * Free AI providers, per size class, in the order the router tries them.
 * Every value comes from the provider's own pages, checked 2026-11-14:
 * see `context/ai/providers.md` for the sources and what was left out.
 *
 * A provider that drops its free tier is a one-line change here.
 * `FREE_MODELS` is the allow-list: the router refuses any model not in it,
 * so a paid model can never be called.
 */

export type SizeClass = "small" | "medium" | "large";

export type ProviderName = "groq" | "openrouter" | "cloudflare";

export type ProviderEntry = {
  provider: ProviderName;
  /** OpenAI-compatible base URL. `{account_id}` is filled from `accountEnvKey`. */
  baseUrl: string;
  /** Model id exactly as the provider's model list writes it. */
  model: string;
  /** Environment variable that holds the API key. Never logged. */
  envKey: string;
  /** Only Cloudflare: environment variable that fills `{account_id}` in `baseUrl`. */
  accountEnvKey?: string;
  /** True when the provider documents `response_format` JSON for this model. */
  jsonMode: boolean;
  /** Requests per minute on the free plan. */
  rpm: number;
  /** Requests per day on the free plan; null when the cap is not counted in requests. */
  rpd: number | null;
};

const GROQ = {
  provider: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  envKey: "GROQ_API_KEY",
} as const;

const OPENROUTER = {
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  envKey: "OPENROUTER_API_KEY",
  // 50 a day until 10 credits have ever been bought, then 1,000.
  rpm: 20,
  rpd: 50,
} as const;

const CLOUDFLARE = {
  provider: "cloudflare",
  baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
  envKey: "CLOUDFLARE_API_TOKEN",
  accountEnvKey: "CLOUDFLARE_ACCOUNT_ID",
  // Cap is 10,000 Neurons a day, not a request count.
  rpm: 300,
  rpd: null,
} as const;

export const PROVIDERS: Record<SizeClass, readonly ProviderEntry[]> = {
  small: [
    { ...GROQ, model: "openai/gpt-oss-20b", jsonMode: true, rpm: 30, rpd: 1000 },
    { ...OPENROUTER, model: "inclusionai/ling-3.2-flash:free", jsonMode: true },
    { ...CLOUDFLARE, model: "@cf/meta/llama-3.1-8b-instruct-fp8", jsonMode: false },
  ],
  medium: [
    { ...GROQ, model: "qwen/qwen3.8-27b", jsonMode: true, rpm: 30, rpd: 1000 },
    { ...GROQ, model: "openai/gpt-oss-20b", jsonMode: true, rpm: 30, rpd: 1000 },
    { ...OPENROUTER, model: "google/gemma-4-26b-a4b-it:free", jsonMode: true },
  ],
  large: [
    { ...GROQ, model: "openai/gpt-oss-120b", jsonMode: true, rpm: 30, rpd: 1000 },
    { ...OPENROUTER, model: "google/gemma-4-31b-it:free", jsonMode: true },
    { ...CLOUDFLARE, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", jsonMode: true },
  ],
};

/** Every model the router may call, as `provider:model`. */
export const FREE_MODELS: ReadonlySet<string> = new Set(
  Object.values(PROVIDERS)
    .flat()
    .map((entry) => freeModelKey(entry.provider, entry.model)),
);

export function freeModelKey(provider: ProviderName, model: string): string {
  return `${provider}:${model}`;
}

export function isFreeModel(provider: ProviderName, model: string): boolean {
  return FREE_MODELS.has(freeModelKey(provider, model));
}

/** The base URL with `{account_id}` filled in, or null when that env value is missing. */
export function resolveBaseUrl(
  entry: ProviderEntry,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!entry.accountEnvKey) return entry.baseUrl;
  const accountId = env[entry.accountEnvKey];
  if (!accountId) return null;
  return entry.baseUrl.replace("{account_id}", encodeURIComponent(accountId));
}
