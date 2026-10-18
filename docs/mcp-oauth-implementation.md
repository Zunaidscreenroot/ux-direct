# MCP OAuth implementation notes

This adapter provides discovery, dynamic registration, authorization-code exchange with PKCE S256, and signed short-lived bearer tokens without adding a database dependency. It deliberately allows only HTTPS redirect URIs on ChatGPT/OpenAI domains (or localhost HTTP for local development). Dynamic registration currently supports one redirect URI per client. OAuth signing uses `UX_DIRECT_MCP_OAUTH_SECRET`; approval uses `UX_DIRECT_MCP_OAUTH_APPROVAL_KEY`.

**Important limitations:** the initial signed authorization code is time-limited and PKCE-bound, but redemption is not persisted as one-time state in a durable store. A valid code could be replayed during its two-minute lifetime. Access-token revocation and per-user identity are not implemented. This is a controlled internal test adapter, not a public multi-tenant identity provider. Add durable single-use code tracking and user-scoped authorization before broad rollout.

The MCP endpoint retains the legacy API-key bearer path for backward compatibility. Prefer OAuth for ChatGPT connector setup and keep secrets in deployment environment variables only.
