# UX Direct model gateway (zero gateway fees)

UX Direct includes a small, self-hosted-in-application gateway inspired by LiteLLM's provider abstraction. There is **no gateway subscription, proxy vendor, or gateway usage fee**. Requests go from the UX Direct server directly to the chosen model provider. Provider/model usage can still cost money; free model tiers and local models may have limits or infrastructure costs.

## What it provides

- A common `chatCompletion()` interface for OpenAI-compatible chat-completion APIs.
- Environment-based provider configuration and explicit model allowlists.
- Provider-independent response shape with model, provider, latency and token usage.
- Request timeout, cancellation, input validation, and normalized errors.
- No database, external gateway account, telemetry service, or additional runtime dependency.

## Dashboard and usage accounting

The main dashboard includes a Model Gateway tab, provider readiness and non-editable API-key placeholders for the final setup step. It shows per-request prompt/completion/total tokens, model, provider, latency, estimated cost, month-to-date spend and the ₹3,000 default budget. `GET /api/model-gateway/dashboard` returns only sanitized readiness and ledger data.

The initial usage ledger is in-memory best-effort telemetry and may reset on serverless restarts. Treat it as operational visibility rather than a durable billing source until persistent storage and concurrency-safe budget reservation are implemented.

## Configure providers

Set secrets only in the server environment; never expose them through `NEXT_PUBLIC_*` variables or commit them.

OpenRouter:
```env
OPENROUTER_API_KEY=...
OPENROUTER_MODELS=provider/model-name:free
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

This slice implements non-streaming chat completions, a deterministic no-network mock, provider/model catalog, task-based selection, authenticated chat/model endpoints, a high-level Model Gateway dashboard, disabled API-key placeholders, per-request token ledger, INR budget tracker and budget guard, and a zero-cost mock smoke test. The task-planning endpoint uses the gateway when a local/free provider is configured; otherwise it remains in deterministic mock mode. Paid task planning requires an exact model ID in `MODEL_GATEWAY_TASK_MODEL`, `ALLOW_PAID_MODELS=true`, a nonzero budget, and configured token prices. Streaming live output, concurrency-safe budget reservations, and per-model pricing remain follow-up work. Usage records persist to Netlify Blobs when running in Netlify and use runtime memory as a local fallback.
