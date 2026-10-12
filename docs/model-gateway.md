# UX Direct model gateway (zero gateway fees)

UX Direct includes a small, self-hosted-in-application gateway inspired by LiteLLM's provider abstraction. There is **no gateway subscription, proxy vendor, or gateway usage fee**. Requests go from the UX Direct server directly to the chosen model provider. Provider/model usage can still cost money; free model tiers and local models may have limits or infrastructure costs.

## OpenRouter balance, usage and budget planning

The UX Direct cockpit uses OpenRouter as the provider gateway. Its approved model list remains strict: two free Nemotron models followed by at most one expertise-routed paid model. OpenRouter enforces account credits, any per-key limits, provider rate limits and its own in-flight spending checks. UX Direct does not impose a separate monthly, module, model or per-request spending cap on this approved OpenRouter path. Its local usage ledger and token-price estimates are telemetry only and can differ from provider-reported billing.

The Model Gateway page can show account credits (`GET /api/v1/credits`), activity over the last 30 completed UTC days (`GET /api/v1/activity`) and usage/limits for the configured API key (`GET /api/v1/key`). The first two endpoints require `OPENROUTER_MANAGEMENT_KEY`; `/key` uses `OPENROUTER_API_KEY`. See the [OpenRouter credits API](https://openrouter.ai/docs/api/api-reference/credits/get-credits), [activity API](https://openrouter.ai/docs/api/api-reference/analytics/get-user-activity), and [current-key API](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key). Account data is accessed only by the server and the gateway account endpoint requires `MODEL_GATEWAY_ADMIN_KEY`.

The balance and runway planner are snapshots/projections, not spending locks. OpenRouter states credit totals can be cached for up to 60 seconds, and simultaneous requests may reserve estimated usage against the provider balance. UX Direct's own recent usage ledger remains helpful for per-request diagnosis but is not the source of truth for available credits.

## What it provides

- A common `chatCompletion()` interface for OpenAI-compatible chat-completion APIs.
- Environment-based provider configuration and explicit model allowlists.
- Provider-independent response shape with model, provider, latency and token usage.
- Request timeout, cancellation, input validation, and normalized errors.
- No database, external gateway account, telemetry service, or additional runtime dependency.

## Dashboard and usage accounting

The main dashboard includes a Model Gateway tab, provider readiness and non-editable API-key placeholders. It shows provider-reported credits, key-level usage, 30-day activity by date/model, a daily-spend runway planner, and UX Direct's per-request token and estimated-cost ledger. `GET /api/model-gateway/dashboard` returns sanitized readiness and local usage telemetry. `GET /api/model-gateway/openrouter-account` proxies OpenRouter's account endpoints without exposing either credential.

The usage ledger persists to Netlify Blobs when available and otherwise uses best-effort runtime memory. It is operational telemetry rather than a billing source; OpenRouter's account reporting is authoritative.

## Configure providers

Set secrets only in the server environment; never expose them through `NEXT_PUBLIC_*` variables or commit them.

OpenRouter:
```env
OPENROUTER_API_KEY=...
# Required for account credits and 30-day usage analytics. Keep server-side only.
OPENROUTER_MANAGEMENT_KEY=...
# OpenRouter :free models are discovered live by the model-status probe.
# Optional:
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

OpenAI:
```env
OPENAI_API_KEY=...
OPENAI_MODELS=gpt-4o-mini
# Optional:
OPENAI_BASE_URL=https://api.openai.com/v1
```

Any OpenAI-compatible service, including a local Ollama-compatible endpoint or a provider's compatible API:
```env
CUSTOM_OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:11434/v1
CUSTOM_OPENAI_COMPATIBLE_MODELS=default
# CUSTOM_OPENAI_COMPATIBLE_API_KEY is optional
```

For custom provider endpoints, make sure the endpoint is reachable from the deployed server. A localhost endpoint only works when the app and model server share the same host/network.

## Example server-side usage

```ts
import { chatCompletion, providersFromEnv } from "@/src/model-gateway";

const result = await chatCompletion({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Review this UX decision." }],
  max_tokens: 500
}, { providers: providersFromEnv() });

console.log(result.content, result.provider, result.usage);
```

Do not call this module directly from browser/plugin code: route requests through a server-side Next.js API handler, authenticate callers, validate request size and model allowlists, and apply per-user rate limits before exposing it. Do not automatically retry paid requests unless duplicate billing is acceptable. Never log API keys or full confidential prompts.

## Current scope and follow-up

This slice implements non-streaming chat completions, a deterministic no-network mock, provider/model catalog, task-based selection, authenticated chat/model endpoints, a Model Gateway dashboard with OpenRouter credit/activity reporting and runway planning, disabled API-key placeholders, per-request usage telemetry, and a zero-cost mock smoke test. The task-planning endpoint uses the gateway when a local/free provider is configured; otherwise it remains in deterministic mock mode. Paid OpenRouter fallback uses the server-side approved model list and OpenRouter account/key controls. Streaming live output, concurrency-safe budget reservations, and per-model pricing remain follow-up work. Usage records persist to Netlify Blobs when running in Netlify and use runtime memory as a local fallback.
