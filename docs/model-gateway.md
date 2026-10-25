# UX Direct model gateway

UX Direct includes an application-side model gateway with a consistent OpenAI-compatible request/response shape, model allowlists, server-side credentials, usage logging, budget controls, and mock support. The application gateway itself does not charge a gateway fee. FreeLLMAPI's upstream providers may still have quotas, data-retention terms, or usage charges; do not assume an auto route is unlimited or free.

## Primary inference provider

The assistant chat, Figma design agent, visual review/refinement, and internal IA/UX analysis use the configured FreeLLMAPI instance. The direct routes send requests to:

- GET {FREELLMAPI_BASE_URL}/models?available=true for connection health.
- POST {FREELLMAPI_BASE_URL}/chat/completions for model inference.

Set FREELLMAPI_BASE_URL to the API root that ends in /v1, and FREELLMAPI_API_KEY to the key expected by the installed FreeLLMAPI gateway. The model identifier currently used by UX Direct is auto; the FreeLLMAPI instance must support this alias. Upstream model selection and fallback are controlled by the configured FreeLLMAPI profile, not by OpenRouter-specific plugins or provider filters.

Local development example (adjust to the port used by your instance):

    FREELLMAPI_BASE_URL=http://127.0.0.1:31415/v1
    FREELLMAPI_API_KEY=your-local-gateway-key
    FREELLMAPI_MODELS=auto

A local 127.0.0.1 address works only when the UX Direct server and FreeLLMAPI share a reachable host/network. A Cloudflare Worker cannot use your laptop's loopback address. Production must use a reachable HTTPS endpoint or secured tunnel, with the provider key configured as a server-only Worker secret. Do not expose the gateway publicly without authentication and rate limiting.

## Environment and security

- FREELLMAPI_BASE_URL: FreeLLMAPI OpenAI-compatible API root, including /v1.
- FREELLMAPI_API_KEY: server-side gateway key; never expose it to a client bundle or commit a real key.
- FREELLMAPI_MODELS: comma-separated model allowlist; currently defaults to auto.
- MODEL_GATEWAY_ACCESS_KEY: protects the generic Model Gateway API.
- MODEL_GATEWAY_ADMIN_KEY: protects server-side routing/budget settings.
- MODEL_GATEWAY_MONTHLY_BUDGET_INR, MODEL_GATEWAY_INPUT_PRICE_INR_PER_1M, MODEL_GATEWAY_OUTPUT_PRICE_INR_PER_1M: generic gateway budget and pricing controls.

The dashboard reports actual usage values only when the selected gateway returns them. If FreeLLMAPI does not expose selected model, token usage, or cost metadata, UX Direct must not invent those values; unreported upstream cost is unknown until the router supplies auditable usage data. A gateway-reported cost is evidence from the configured instance, not an independently verified bill.

## Existing gateway API

The generic gateway still supports configured providers such as local Ollama and explicitly enabled direct-provider adapters. UX Direct's chat and Figma request paths use FreeLLMAPI; do not reintroduce provider-specific upstream filters into those request bodies.

- GET /api/model-gateway/models: model catalog and configured provider status, protected by gateway access authentication.
- POST /api/model-gateway/chat: non-streaming chat completion, protected by gateway access authentication.
- GET /api/model-gateway/dashboard: sanitized provider readiness, usage ledger, and budget snapshot. This endpoint never returns API keys.
- GET /api/assistant/status: FreeLLMAPI availability plus separate UX Audit and shared-brain service health.
- GET /api/health: basic worker and configured model-provider health.

The deterministic mock/ux-direct model is a no-network test mode, not real inference. A successful mock response must never be presented as a successful FreeLLMAPI inference.

## Operational checks

1. Verify GET /v1/models from the machine where UX Direct runs.
2. Verify GET /v1/models?available=true using the configured authentication header.
3. Send a small POST /v1/chat/completions request with model "auto" and confirm a non-empty response.
4. If UX Direct chat streams, verify Server-Sent Events and cancellation with the same API root.
5. Verify that a deployed Worker can reach the configured HTTPS route; a local request does not prove production connectivity.
6. Check npm test, npm run typecheck, npm run lint, npm run build, and npm run cf:build before promotion.

FreeLLMAPI's provider catalog, alias behavior, model capabilities, rate limits, and upstream billing may vary by installation. Confirm those characteristics against the installed instance rather than assuming OpenRouter compatibility beyond the API fields tested above.
