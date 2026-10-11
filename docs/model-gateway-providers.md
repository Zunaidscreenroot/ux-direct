# Model gateway providers and free-first rollout

The gateway itself is application code and costs **$0 in gateway fees**. It calls providers directly. This file separates providers with a genuine free usage path from paid providers that must stay disabled until the user deliberately configures them.

## Four-hour MVP recommendation

Use **OpenRouter as the first upstream provider behind this gateway**, so the app keeps one internal API and can switch between exact model IDs later. The current preview code supports OpenRouter already; do not replace the internal gateway with OpenRouter-specific calls from the browser.

For a wiring/demo smoke test, start with one explicit model, `google/gemma-4-31b-it:free`, which supports text and image input. Keep the OpenRouter model allowlist fixed and paid routing disabled. OpenRouter's Free plan currently advertises 50 requests/day; its Standard plan has a 5.5% platform fee, separate from model inference costs. Verify the latest limits and charges in your account before adding credits: https://openrouter.ai/pricing/.

**Data safety:** free model endpoints are not a safe default for confidential DMI or client design files. Provider data retention and model-improvement terms vary. Use synthetic/sanitized material for the initial demo; for real client data, verify the selected provider's terms or connect the direct paid Google Gemini API (supported by the same gateway). Google's current API pricing marks Gemini 3.1 Flash-Lite at $0.25/M input tokens and $1.50/M output tokens for standard paid usage, and says paid-tier data is not used to improve its products: https://ai.google.dev/gemini-api/docs/pricing.

## Recommended rollout order

1. **Built-in mock** — always available; no credentials, network, model inference, or billing. Use for CI, API contract checks, and wiring only.
2. **Ollama local** — no model API key or per-token charge. Install Ollama on a machine with enough RAM/VRAM and pull a model. Best option for confidential client work when inference remains local. A deployed server cannot reach your laptop's `localhost`; run the gateway locally or expose a private, authenticated endpoint.
3. **Google Gemini API free tier** — create a key in Google AI Studio; no gateway fee, and a free quota is available for eligible models/accounts. Model availability, regional access, quotas, and data-use terms vary. Do not send confidential client material until the applicable data terms have been reviewed.
4. **Groq developer free tier** — requires a key; supported models and request/token quotas vary. Current gateway defaults include GPT OSS 120B and 20B, but verify exact model IDs and free-plan quotas in the provider console before enabling.
5. **Cerebras free developer access** — requires a key; availability, exact model IDs and quotas are account-specific. Treat it as optional until its model ID is confirmed from your account.
6. **OpenRouter free models** — requires a key. Use explicit model IDs ending in `:free` where offered; avoid `openrouter/auto` for cost-sensitive production because auto-routing can select a paid model depending on account/model behavior. Free model inventory and rate limits change often.
7. **Paid providers (OpenAI)** — no key is required to build or test the gateway. Add keys only in the final activation step, after tests and local/free-tier checks pass. Anthropic's native Messages API is not implemented in this gateway yet and is intentionally not advertised as supported.

Free API access still needs a provider account/key in most cases. "Free tier" does not mean unlimited, guaranteed availability, private processing, or no data retention.

## Token ledger and budget guard

The Model Gateway dashboard is available from the main UX Direct navigation. `GET /api/model-gateway/dashboard` returns sanitized provider readiness, the model catalog, monthly budget snapshot, and per-request token ledger. It never returns key values. The chat endpoint records prompt/completion/total token counts when the provider reports usage, model/provider, request ID, latency, estimated INR cost, and blocked/failed outcomes. Prompt and response text are not written to the usage ledger.

The ledger persists to Netlify Blobs in the Netlify runtime and falls back to best-effort in-process memory in local/unsupported runtimes. Read-modify-write budget checks are not transactional, so simultaneous paid requests can race the cap. Add concurrency-safe budget reservations before production paid traffic.

Set `MODEL_GATEWAY_MONTHLY_BUDGET_INR=3000` for the default ₹3,000 monthly cap. Paid providers remain unavailable unless both per-million token prices are configured, the budget is non-zero, `ALLOW_PAID_MODELS=true`, and the provider key is present. Set prices from the provider's current pricing page; do not rely on guessed values. The budget guard estimates maximum request cost before dispatch and blocks requests that would exceed the remaining budget.

## Environment configuration

Copy `.env.example` into a local environment file and leave all provider keys blank during development. Never commit a real key or use a `NEXT_PUBLIC_*` variable for a secret.

Gateway access protection:
```env
MODEL_GATEWAY_ACCESS_KEY=replace-with-a-long-random-secret
# Local-only alternative; ignored in production:
MODEL_GATEWAY_ALLOW_UNAUTHENTICATED_LOCAL=true
```

Local Ollama:
```env
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_MODELS=qwen2.5:7b,gemma4:31b
```

Gemini free tier:
```env
GEMINI_API_KEY=
GEMINI_MODELS=gemini-3.5-flash
```

Groq:
```env
GROQ_API_KEY=
GROQ_MODELS=openai/gpt-oss-120b,openai/gpt-oss-20b
```

Cerebras:
```env
CEREBRAS_API_KEY=
CEREBRAS_MODELS=gpt-oss-120b
```

OpenRouter:
```env
OPENROUTER_API_KEY=
# OpenRouter :free models are discovered live by the model-status probe.
```

Set only providers that are available to your account. The gateway rejects models outside the configured allowlist.

## API

- `GET /api/model-gateway/models` — lists supported catalog entries and configured providers. Requires gateway access authentication.
- `POST /api/model-gateway/chat` — accepts `{ "model": "...", "messages": [{ "role": "user", "content": "..." }] }`. Requires gateway access authentication.

Use `Authorization: Bearer <MODEL_GATEWAY_ACCESS_KEY>` or `x-model-gateway-key`. The read-only dashboard endpoint `GET /api/model-gateway/dashboard` exposes sanitized status and token/budget records only; it does not expose secrets. Model aliases `uxd/classify`, `uxd/extract`, `uxd/summarize`, `uxd/reasoning`, `uxd/vision`, and `uxd/critique` select from configured providers using the built-in task policy; if no real provider is configured, they return the deterministic mock rather than silently calling a paid API. The gateway endpoints stay locked if no access key is configured, except when explicitly allowing unauthenticated local development outside production. Do not expose this as a public, unrestricted relay. Chat requests have a 30-request/minute in-memory limit per client IP; this is a best-effort single-runtime guard, not a distributed quota system.

## Routing policy

The `routeTask()` helper prefers local/free models for classification, extraction and summaries; stronger free-tier candidates for reasoning and critique; and falls back to deterministic mock when no real provider is configured. Model IDs and free quotas are not stable guarantees; check provider consoles before enabling. Task aliases can fail over between configured local/free providers; they never automatically fall back to paid providers. The task-planning endpoint uses the gateway when a local/free provider is configured, otherwise it safely stays in mock mode. Paid task planning requires both the paid-mode switch and an explicit exact `MODEL_GATEWAY_TASK_MODEL` selection.

## Before enabling paid billing

- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
- [ ] Verify the model list against your provider accounts.
- [ ] Verify the gateway access key is configured on the server.
- [ ] Run the mock suite and at least one local/free-tier smoke test.
- [ ] Confirm free-tier data-use terms are acceptable for the prompts you send.
- [ ] Only then add paid-provider credentials and set `ALLOW_PAID_MODELS=true` alongside an explicit paid-model allowlist. A paid key alone does not enable paid routing.


## Module-level accounting

Each module (reasoning, classification, extraction, summarization, vision, critique and general) has its own on/off switch, mode, exact model selection, monthly cap and per-request cap. Every catalog model has editable monthly/per-request caps and INR input/output rates. Published USD suggestions convert using an editable INR rate and link to their source. Verify current rates and account plans before enabling billing.

Routing is strict: a disabled module, disconnected explicit model, incompatible mode, or exceeded budget blocks the request—there is no silent failover. Auto mode chooses only within the selected mode. The recommendation is a deterministic task-fit/cost heuristic, not a live benchmark or provider API call.


## Additional available free and paid choices

The curated OpenRouter free catalogue was refreshed from its official Free Models collection on 2026-10-11, with free routing IDs for NVIDIA Nemotron 3 Ultra, Nemotron 3.5 Lightning, Nemotron 3 Super, Nemotron Nano Omni, Poolside Laguna S 2.1, Thinking Machines Inkling and Cohere North Mini Code. Free endpoints are subject to availability, throughput and provider data terms. Some listed endpoints explicitly mention input logging or model-improvement use; do not route confidential client data through them unless the relevant terms are approved. Catalog visibility is not a guarantee that the user's account can use a model; the live probe selects only a model that returns a real response.

DeepSeek's OpenAI-compatible API is supported as a native paid provider. The catalog shows conservative peak-hour rates to avoid underestimating spend: `deepseek-flash` $0.30/M input and $1.20/M output, and `deepseek-v4-pro` $1.32/M input and $3.96/M output. Off-peak and cache-hit inputs can be lower; see the provider's current pricing page before activation. Sources: https://api-docs.deepseek.com/quick_start/pricing/ and https://openrouter.ai/collections/free-models/.
