# ChatGPT connector for UX Direct

This connector exposes an authenticated MCP endpoint on the existing UX Direct deployment. For the no-production-deploy test cycle, both ChatGPT and the Figma plugin must use the same PR-specific Netlify Deploy Preview. It does not create a second model gateway or expose Figma write operations.

## Tools

- `ux_direct_status`: reads the backend health/status endpoint.
- `ux_direct_plan_task`: uses the existing task planner to return a reviewable plan. This does not execute Figma edits or external writes.

The connector intentionally accepts only `general` and `express-computers`. Use `general` for BFCI website-revamp work. DMI-specific project data is not exposed through this connector.

## Deploy and configure

1. In Netlify, set `UX_DIRECT_MCP_API_KEY` as a secret **Deploy Preview** runtime/Functions environment variable. Use a unique random secret of at least 32 characters; never reuse an OpenRouter, Figma, or model-gateway key.
2. Keep the test PR open so Netlify builds its Deploy Preview. For PR #31, the MCP endpoint is `https://deploy-preview-31--uxdirect.netlify.app/api/mcp`.
3. In Figma, use the same preview host for `figma-plugin/ui.html` and `figma-plugin/manifest.json`. The ChatGPT plugin's MCP URL must use that exact preview host too.
4. The endpoint fails closed with HTTP 503 until the secret is configured and returns HTTP 401 for missing or invalid Bearer credentials.

## Connect the private ChatGPT plugin

The plugin package declares Bearer API-key authentication. In ChatGPT, open the private UX Direct plugin's connection/setup flow and enter the same value stored in Netlify as `UX_DIRECT_MCP_API_KEY`. The key is sent as an Authorization header and is never embedded in this repository or plugin archive.

## Boundaries

- No arbitrary URL fetching, direct database access, model selection, or Figma mutation is exposed.
- Planning is subject to the product's existing provider configuration, gateway policy, and rate limits. The connector adds no paid-model credentials.
- A successful plugin upload does not prove the preview is deployed or authentication works. Verify the Deploy Preview deploy SHA/status, health endpoint, authenticated MCP initialization, and one connection-status request before treating the integration as connected. Production is intentionally not used in this test flow.
