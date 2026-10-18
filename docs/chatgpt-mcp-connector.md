# ChatGPT MCP connector for UX Direct

The MCP endpoint is `/api/mcp`. It supports OAuth authorization-code flow with PKCE (S256), dynamic registration for one redirect URI, and short-lived bearer access tokens. The legacy static Bearer API key remains supported for controlled internal testing.

## OAuth endpoints

- Authorization-server metadata: `/.well-known/oauth-authorization-server`
- Protected-resource metadata: `/.well-known/oauth-protected-resource/api/mcp`
- Dynamic client registration: `/api/mcp/oauth/register`
- Authorization: `/api/mcp/oauth/authorize`
- Token exchange: `/api/mcp/oauth/token`

The OAuth approval screen asks for a dedicated UX Direct approval key. Set `UX_DIRECT_MCP_OAUTH_APPROVAL_KEY` to a unique random secret of at least 32 characters and share it only with intended internal testers. If unset, the server falls back to `UX_DIRECT_MCP_API_KEY`. Do not use Figma or model-provider credentials. Set `UX_DIRECT_MCP_OAUTH_SECRET` to a separate random secret of at least 32 characters to sign authorization codes and access tokens; if unset, `UX_DIRECT_MCP_API_KEY` is used as the signing secret. Configure all three secrets in the deployment environment; never commit their values.

## Connect and test

1. Deploy the branch once after CI is green.
2. In ChatGPT, add a custom connector using the deployed MCP URL `https://<your-deployment-host>/api/mcp`.
3. Select OAuth if the client offers it; the connector should discover the authorization server and use PKCE.
4. Approve using the dedicated approval key.
5. Run `ux_direct_status`, then `ux_direct_connection_status`, then `ux_direct_plan_task` with a small non-sensitive task.
6. To inspect Figma, open the UX Direct plugin in an approved Figma file and run the controlled plugin health check. MCP connection alone does not grant arbitrary canvas access; only the exposed tools are available.

## Current tool scope

- `ux_direct_status`: backend health.
- `ux_direct_connection_status`: recent authenticated connector activity and plugin heartbeat.
- `ux_direct_figma_plugin_queue_health_check` and status: controlled native API self-test.
- `ux_direct_plan_task`: reviewable plan only; does not perform production design edits.

No arbitrary URL fetching, direct database access, model-provider secrets, or unrestricted Figma mutation is exposed. OAuth access tokens expire after one hour; reconnect to renew access. Authorization codes expire after two minutes and require PKCE. This initial OAuth adapter is intended for controlled internal testing; production multi-user identity, revocation, and one-time code redemption should be added before broad rollout.
