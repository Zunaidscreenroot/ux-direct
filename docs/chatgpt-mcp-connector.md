# ChatGPT connector for UX Direct

This connector exposes an authenticated MCP endpoint on the existing UX Direct deployment. It does not create a second model gateway or expose Figma write operations.

## Tools

- `ux_direct_status`: reads the backend health/status endpoint.
- `ux_direct_plan_task`: uses the existing task planner to return a reviewable plan. This does not execute Figma edits or external writes.

The connector intentionally accepts only `general` and `express-computers`. Use `general` for BFCI website-revamp work. DMI-specific project data is not exposed through this connector.

## Deploy and configure

1. In Netlify, open the existing `uxdirect` site and add `UX_DIRECT_MCP_API_KEY` as a secret environment variable available to Functions/runtime. Use a unique random secret of at least 32 characters; never reuse an OpenRouter, Figma, or model-gateway key.
2. Deploy the code containing `app/api/mcp/route.ts`. The production endpoint is `https://uxdirect.netlify.app/api/mcp`.
3. The endpoint fails closed with HTTP 503 until the secret is configured and returns HTTP 401 for missing or invalid Bearer credentials.

## Connect the private ChatGPT plugin

The plugin package declares Bearer API-key authentication. In ChatGPT, open the private UX Direct plugin's connection/setup flow and enter the same value stored in Netlify as `UX_DIRECT_MCP_API_KEY`. The key is sent as an Authorization header and is never embedded in this repository or plugin archive.

## Boundaries

- No arbitrary URL fetching, direct database access, model selection, or Figma mutation is exposed.
- Planning is subject to the product's existing provider configuration, gateway policy, and rate limits. The connector adds no paid-model credentials.
- A successful plugin upload does not prove server deployment or authentication. Verify health and one planning request after deploying and connecting.
