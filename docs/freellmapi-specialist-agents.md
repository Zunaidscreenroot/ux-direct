# FreeLLMAPI and specialist model roles

UX Direct keeps its existing server-side control plane and uses FreeLLMAPI as its model upstream. The model catalog is fetched server-side from `FREELLMAPI_BASE_URL/v1/models`; the API key is never sent to the browser or Figma plugin.

## Cloudflare Worker configuration

- `FREELLMAPI_API_KEY`: add as a secret in Cloudflare Workers.
- `FREELLMAPI_BASE_URL`: set to the reachable FreeLLMAPI server's OpenAI-compatible base URL, normally ending in `/v1`. Do not use localhost for a deployed Worker.

The model catalog endpoint is `GET /api/assistant/models`. It returns the current model IDs and capability flags for vision, reasoning, tool calling, and context window. The API's `/v1/models` list does not guarantee complete capability metadata, so the endpoint combines provider metadata with conservative model-name heuristics. Capability flags are advisory; test a model before relying on vision or tool calls.

## Specialist roles

- **Vision analysis**: must be selected from models tagged vision-capable; used when a screenshot is attached.
- **Reasoning**: preferred for conversational analysis, UX critique, and interpretation.
- **Execution / planning**: preferred for structured native Figma plans and JSON output.

Model IDs are supplied by the live catalog and must be validated server-side. The UI must not supply provider keys. FreeLLMAPI's upstream free-tier quotas, model availability, provider data handling and rate limits remain subject to the configured FreeLLMAPI instance and its providers.

## Safety and cost controls

Use one specialist call at a time unless a multi-stage flow explicitly needs sequential vision analysis followed by planning. Never fan out to every model. Keep retries bounded and do not silently fall back to paid providers. Do not send confidential client files to a free endpoint without approval of that endpoint's data terms.
