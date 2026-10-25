# Model gateway providers and FreeLLMAPI rollout

UX Direct's application-side model gateway has no gateway SaaS fee. It provides a shared request interface, server-side secrets, module-level routing policy, usage logging, and an explicit deterministic mock. In the current UX Direct integration, assistant chat, Figma generation, design refinement, visual review, and IA/UX audits use FreeLLMAPI as the inference gateway.

## FreeLLMAPI setup

Configure these server-side environment variables:

    FREELLMAPI_BASE_URL=http://127.0.0.1:31415/v1
    FREELLMAPI_API_KEY=your-local-gateway-key
    FREELLMAPI_MODELS=auto

The local URL above is an example matching a development instance listening on port 31415; update it if your actual listener uses a different port or API root. Check the actual endpoints on the installed gateway:
- GET /v1/models
- GET /v1/models?available=true
- POST /v1/chat/completions with a request containing model "auto" and a user message.

Use the exact auth format required by your FreeLLMAPI installation. UX Direct currently uses Authorization: Bearer <key>, which is the OpenAI-compatible convention. If the installed router uses a different key or endpoint contract, verify and adapt it deliberately.

Localhost cannot be used as a production endpoint by a Cloudflare Worker. For production, configure a reachable HTTPS URL or a secured tunnel to the intended gateway. Use Worker secrets for FREELLMAPI_API_KEY, and protect the gateway with authentication, sensible rate limiting, and an access policy that prevents unauthorized traffic.

## Upstream availability, cost, and data safety

FreeLLMAPI is a routing layer; it is not a guarantee that every upstream model is free, available, private, or capable of vision and structured JSON output. The auto profile can only select models made available by that instance. Verify:
- Whether the configured profile routes only to free upstreams or may select paid ones.
- Quotas, rate limits, model context/output limits, vision support, and JSON-mode behavior.
- Whether token counts, the selected model ID, and cost are included in the response.
- Provider data retention, logging, and model-improvement terms before processing client materials.

For DMI or Ujjivan screenshots, prototypes, or customer information, only use upstream providers whose data terms have been approved. Use synthetic or sanitized material for initial smoke tests. Do not claim zero spend unless the selected profile and auditable usage data establish it.

## Other configured adapters

The generic gateway's adapter code still supports local Ollama and optional direct-provider adapters. Those integrations require their own credentials and explicit configuration; the user-facing UX Direct assistant and Figma agent now use FreeLLMAPI. Do not add a second inference gateway as an automatic fallback without an explicit product decision and tests.

## Monitoring and regression checks

The dashboard exposes sanitized model/provider status and usage records. It must never display API key values. Token usage and model IDs should come from actual responses when available. If cost metadata is missing, label the cost as unavailable or unverified rather than inventing a $0 balance.

Before rollout:
1. Confirm the local FreeLLMAPI API returns a model catalog.
2. Confirm a small non-streaming request with model "auto".
3. Confirm streaming, cancellation, image input, and structured JSON output for the flows that use them.
4. Run unit tests, type checks, lint, and both Next.js and Cloudflare builds.
5. Test the deployed Worker against a secured HTTPS endpoint. Local success alone does not establish production reachability.
