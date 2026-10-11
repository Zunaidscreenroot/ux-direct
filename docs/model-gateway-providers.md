# Model gateway providers and free-first rollout

The gateway itself is application code and costs **$0 in gateway fees**. It calls providers directly. This file separates providers with a genuine free usage path from paid providers that must stay disabled until the user deliberately configures them.

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
OPENROUTER_MODELS=provider/model-name:free
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
