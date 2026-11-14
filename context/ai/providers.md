# Free AI providers, checked on their own pages

Checked 2026-11-14 by build-ai (ticket M2-02). Every number below comes from the provider's own docs, model list or API, never a directory site. Re-check before trusting a number older than a month; free tiers change without notice.

The router config built from this is `src/server/ai/providers.config.ts`.

## Summary

| Provider | Free models we use (ids copied from the provider) | Requests per minute | Requests per day | Trains on prompts? How to opt out | EU users | OpenAI-compatible base URL | Source (checked 2026-11-14) |
|---|---|---|---|---|---|---|---|
| Groq | `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.8-27b` (preview) | 30 each | 1,000 each (also 8K tokens/min, 200K tokens/day) | No: "does not retain customer data for inference requests" by default; reliability logs up to 30 days. Turn on Zero Data Retention in Data Controls to stop even those. | Allowed: privacy policy and DPA cover EEA users (standard contractual clauses); processing mainly in the US. | `https://api.groq.com/openai/v1` | https://console.groq.com/docs/rate-limits (Free Plan Limits tab), https://console.groq.com/docs/models, https://console.groq.com/docs/your-data, https://console.groq.com/docs/structured-outputs, https://console.groq.com/docs/legal/customer-data-processing-addendum |
| OpenRouter (free `:free` models) | `inclusionai/ling-3.2-flash:free`, `google/gemma-4-31b-it:free`, `google/gemma-4-26b-a4b-it:free` | 20 | 50 with under 10 credits ever bought; 1,000 with 10 or more | OpenRouter stores nothing by default. Each free model is served by one provider with its own policy: Ant Digital (Ling) zero retention, does not train; Google AI Studio (Gemma) retains 55 days, does not train; NVIDIA and Liquid "may train" (not used). In account settings, switch off training for free models so OpenRouter never routes to a provider that trains. | Allowed: DPA with standard contractual clauses; EU-only routing is a paid Business feature. | `https://openrouter.ai/api/v1` | https://openrouter.ai/docs/api-reference/limits, https://openrouter.ai/api/v1/models (filtered on `:free`), https://openrouter.ai/docs/guides/privacy/provider-logging, https://openrouter.ai/docs/guides/privacy/data-collection, https://openrouter.ai/privacy |
| Mistral (La Plateforme) | none | n/a | n/a | Free mode may train on inputs and outputs; opt-out exists. | n/a | `https://api.mistral.ai/v1` | https://docs.mistral.ai/admin/user-management-finops/tier, https://help.mistral.ai/en/articles/323757-do-you-use-my-user-data-to-train-your-artificial-intelligence-models |
| Cloudflare Workers AI | `@cf/meta/llama-3.1-8b-instruct-fp8`, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 300 for text generation | No request cap; 10,000 Neurons per day free, resets 00:00 UTC | No: "Cloudflare does not use Customer Content processed by Workers AI to train AI models." | Allowed (Cloudflare account terms; no EU exclusion found). | `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1` (header `Authorization: Bearer <token>`) | https://developers.cloudflare.com/workers-ai/platform/pricing/, https://developers.cloudflare.com/workers-ai/platform/limits/, https://developers.cloudflare.com/workers-ai/models/, https://developers.cloudflare.com/workers-ai/features/json-mode/, https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/, https://developers.cloudflare.com/workers-ai/platform/data-usage/ |

## What changed from `context/decisions.md`

- **Mistral has no free API any more.** Its docs say Free mode "doesn't include API access"; API keys need billing and pay-as-you-go. So Mistral is out of the config. The decision's order (Groq, OpenRouter, Mistral, Cloudflare) becomes Groq, OpenRouter, Cloudflare. `MISTRAL_API_KEY` from M2-01 is not needed.
- **Groq's free plan no longer lists the Llama models.** The Free Plan Limits tab has `openai/gpt-oss-20b`, `openai/gpt-oss-120b` and `qwen/qwen3.8-27b` (plus speech and guard models). `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` are on the production model list but not on the free limits table, so we do not use them.
- **`qwen/qwen3.8-27b` is a Groq preview model.** Groq says preview models "may be discontinued at short notice". It is the medium first choice because it is free and supports strict JSON; the router falls through to the next entry if it disappears.
- **OpenRouter free models that may train are left out:** `nvidia/*:free` (NVIDIA, "may train") and `liquid/lfm-3-1.7b:free` (Liquid, "may train"). Models whose endpoint does not take `response_format` are left out too.
- **Gemma via OpenRouter is served by Google AI Studio.** OpenRouter lists it as "does not train", retained 55 days. The decision ruled out the free Gemini API for EU users; this is a different contract (OpenRouter is Google's customer), but it is the one entry to drop first if Aalto's rules (M0-13, `context/moodle/terms.md`) or M2-26 say otherwise. It sits after Ling and Groq so it is rarely reached.

## JSON mode

- Groq: JSON object mode on all models; strict `json_schema` on `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`.
- OpenRouter: each chosen `:free` endpoint lists `response_format` in its supported parameters (`/api/v1/models/<id>/endpoints`).
- Cloudflare: the JSON mode page lists `@cf/meta/llama-3.3-70b-instruct-fp8-fast` and `@cf/meta/llama-3.1-8b-instruct`, not the `-fp8` variant we use for small, so small Cloudflare is marked `jsonMode: false` (the router asks for JSON and validates).

## Not checked here

- Live account limits: Groq and Mistral both say the account's own limits page is authoritative. No keys on this machine, so not looked at.
- Whether a no-training API counts as allowed for teachers' material under Aalto's rules: that is M0-10 / M2-21 / M2-26, not this ticket.
