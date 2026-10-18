# ChatGPT MCP connector for UX Direct

UX Direct exposes an authenticated Model Context Protocol (MCP) endpoint from its Cloudflare Worker. The connector uses OAuth 2.1 authorization-code flow with PKCE and the existing UX Direct authorization screen. It is not a second model gateway and does not expose arbitrary Figma write operations.

## Endpoint

- MCP server URL: `https://ux-direct.zunaid-cb7.workers.dev/api/mcp`
- Protected-resource metadata: `https://ux-direct.zunaid-cb7.workers.dev/.well-known/oauth-protected-resource/api/mcp`
- Authorization-server metadata: `https://ux-direct.zunaid-cb7.workers.dev/.well-known/oauth-authorization-server`

The MCP endpoint advertises its protected-resource metadata URL in the `WWW-Authenticate` challenge. The well-known routes are required for clients to discover the OAuth authorization and token endpoints.

## Cloudflare secrets

The `ux-direct` Worker must have these secret bindings configured:

- `UX_DIRECT_MCP_OAUTH_SECRET`: high-entropy signing secret, at least 32 characters.
- `UX_DIRECT_MCP_CONNECTION_CODE`: private code entered once on the UX Direct authorization page.
- `UX_DIRECT_MCP_API_KEY`: legacy service-to-service compatibility only; don't use it for the ChatGPT OAuth connection.

Never commit these values or paste them into source control. Keep the connection code private. If it is unavailable, rotate only `UX_DIRECT_MCP_CONNECTION_CODE` to a new unique value in Cloudflare, then use that new value when authorizing. Do not rotate the OAuth signing secret casually; that invalidates existing tokens and connections.

## Connect ChatGPT

1. In ChatGPT, open the Apps/connectors settings and create a custom MCP connector (the exact menu label may vary by account).
2. Set the server URL to `https://ux-direct.zunaid-cb7.workers.dev/api/mcp` and choose OAuth when prompted.
3. Start the connection. ChatGPT should discover the OAuth metadata and open the UX Direct authorization page.
4. Enter the current `UX_DIRECT_MCP_CONNECTION_CODE`, review the listed access, select the consent checkbox, and authorize.
5. Back in ChatGPT, verify the connector exposes tools such as `ux_direct_status`, `ux_direct_uxaudit_status`, and `ux_direct_uxaudit_discover_site`.

The initial authorization grants the configured UX Direct scopes. UX Audit screenshot audits and benchmarking can incur OpenRouter model charges. Learning/approval tools can write to the shared product database; reusable lessons should remain drafts until the owner explicitly approves them.

## Verification checklist

- The two metadata endpoints return JSON with the same canonical issuer.
- A token-free `GET /api/mcp` returns HTTP 401 with a `WWW-Authenticate` challenge pointing to the path-specific protected-resource metadata.
- OAuth registration, PKCE authorization, and token exchange succeed without embedding secrets in ChatGPT settings or source code.
- An authenticated `initialize` request returns MCP server information, and `tools/list` returns tools filtered by the granted scopes.
- Test read-only status and discovery tools before invoking any audit or learning action.

## Boundaries

- No arbitrary URL fetching, direct database access, model selection, or Figma mutation is exposed through this connector.
- Public-site audits and benchmarking are allowed; client-specific Past Findings must not be promoted to the global Knowledge Base without a separate approved generalized rule.
- A successful code push or Worker deployment does not prove the ChatGPT connection works. Verify one read-only MCP request after authorization.
