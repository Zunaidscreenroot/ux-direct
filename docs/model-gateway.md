# UX Direct model gateway (zero gateway fees)

UX Direct includes a small, self-hosted-in-application gateway inspired by LiteLLM's provider abstraction. There is **no gateway subscription, proxy vendor, or gateway usage fee**. Requests go from the UX Direct server directly to the chosen model provider. Provider/model usage can still cost money; free model tiers and local models may have limits or infrastructure costs.

## Accountant controls and module routing

Every module has a switch, routing mode and model-selection policy. No monthly gateway/module budget is assigned by default. The internal analysis modules use OpenRouter Auto Router with its low-cost tier and request-level per-token price ceilings; the homepage chat keeps its separate explicit `:free`-only model pool. Direct provider routes remain disabled unless deliberately configured with server-side credentials and explicit pricing/budget controls.

OpenRouter chooses the model dynamically for each request, subject to the low-cost routing tier and price ceiling. The actual model and reported usage cost are recorded from the response. Per-token price ceilings reduce the cost of each request but are not a monthly spend limit; total spend can accumulate without an explicitly assigned budget. Free-tier API usage estimates as ₹0 only when the connected provider account/request truly uses a free tier.

Settings and usage keys are branch/environment scoped, so preview does not overwrite production settings or usage records. Netlify Blobs is best-effort key/value storage rather than transactional accounting; concurrent paid calls may race a cap. Use transactional reservations before relying on caps as a production financial guarantee.

## What it provides

- A common `chatCompletion()` interface for OpenAI-compatible chat-completion APIs.
- Environment-based provider configuration and explicit model allowlists.
- Provider-independent response shape with model, provider, latency and token usage.
- Request timeout, cancellation, input validation, and normalized errors.
- No database, external gateway account, telemetry service, or additional runtime dependency.

## Dashboard and usage accounting

The main dashboard includes a Model Gateway tab, provider readiness and non-editable API-key placeholders for the final setup step. It shows per-request prompt/completion/total tokens, the model actually selected by the router, provider, latency, estimated cost, month-to-date spend and whether a monthly budget has been explicitly assigned. No monthly budget is assigned by default. `GET /api/model-gateway/dashboard` returns only sanitized readiness and ledger data.

The initial usage ledger is in-memory best-effort telemetry and may reset on serverless restarts. Treat it as operational visibility rather than a durable billing source until persistent storage and concurrency-safe budget reservation are implemented.

## Configure providers

Set secrets only in the server environment; never expose them through `NEXT_PUBLIC_*` variables or commit them.

OpenRouter:
```env
OPENROUTER_API_KEY=...
OPENROUTER_MODELS=provider/model-name:free
# Internal UX/IA analysis uses dynamic low-cost routing instead of a fixed model ID.
OPENROUTER_AUTO_ROUTING=true
OPENROUTER_AUTO_MAX_INPUT_USD_PER_1M=0.10
OPENROUTER_AUTO_MAX_OUTPUT_USD_PER_1M=0.30
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

This slice implements non-streaming chat completions, a deterministic no-network mock, provider/model catalog, task-based selection, authenticated chat/model endpoints, a Model Gateway dashboard, per-request token ledger, INR cost reporting and explicit guards for fixed routes, plus a zero-cost mock smoke test. Internal UX/IA analysis is routed dynamically through OpenRouter's low-cost router with per-token price ceilings; no monthly gateway budget is assigned unless deliberately configured. Direct-provider task planning remains separately guarded. Streaming live output and concurrency-safe monthly spend controls remain follow-up work. Usage records persist to Netlify Blobs when running in Netlify and use runtime memory as a local fallback.
