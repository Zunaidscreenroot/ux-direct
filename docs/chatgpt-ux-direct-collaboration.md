# ChatGPT ↔ UX Direct collaboration bridge

This branch adds a remote MCP endpoint so ChatGPT can consult UX Direct as a distinct participant in the same conversation, and can save explicit user-approved guidance into UX Direct's persistent website-revamp memory.

## Tools exposed

- ux_direct_consult: ask the UX Direct brain to answer the latest message or critique ChatGPT's proposal.
- ux_direct_teach: save a durable rule only when the user explicitly asks UX Direct to remember or learn it.
- ux_direct_search_memory: inspect what UX Direct has already learned in the website-revamp project.

The bridge intentionally uses the existing Model Gateway and existing Supabase memory table. It does not add another provider, model API, storage vendor, or Figma AI integration. A consultation still uses the model configured in UX Direct's gateway and may incur that provider's normal usage cost.

## Security and storage scope

1. Configure UX_DIRECT_MCP_TOKEN as a private server-side environment variable in the Vercel project. Use a fresh random token; never commit it, put it in a client bundle, or paste it into logs.
2. Configure Supabase server-side credentials already used by UX Direct: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (or the existing SUPABASE_SECRET_KEY fallback).
3. Only the website-revamp project key is exposed by these tools. The bridge does not read from the general memory bucket and must not be used to store DMI-specific client knowledge. Keep DMI knowledge in its separate repository.
4. The endpoint uses bearer-token authentication, existing gateway rate limiting, bounded request sizes, and does not log message content or credentials.
5. ux_direct_teach writes approved memory into uxd_memory_items. Only call it when the user explicitly asks to save a lasting rule or preference.

## Endpoint

After the branch is deployed, the endpoint is:

https://<your-preview-host>/api/mcp

It implements the MCP Streamable HTTP JSON-RPC methods needed by the tools flow: initialize, ping, tools/list, and tools/call. Requests require Authorization: Bearer <UX_DIRECT_MCP_TOKEN>.

## Connecting ChatGPT

In a ChatGPT account/workspace that supports custom MCP apps, create a custom app using the deployed /api/mcp endpoint and its bearer token. Scan the tools and enable the actions you want. In a conversation, invoke or mention UX Direct when you want a second participant to speak; to teach it, explicitly say something like “UX Direct, remember this rule for future website revamps” and let the ux_direct_teach action save the rule.

ChatGPT plan support varies. OpenAI's current help documentation says full MCP write/modify support is available to Business, Enterprise, and Edu; Pro has limited read/fetch access. Go-plan availability is not documented there, so verify that your account exposes custom MCP apps and write actions before relying on in-chat training. See:
- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk

## Verification checklist

- POST /api/mcp without a token returns 401.
- initialize and tools/list work with the token.
- ux_direct_consult returns a response from a configured, non-mock gateway model.
- ux_direct_teach persists a user-approved rule and the next consultation retrieves it.
- Build, typecheck, and the project's full test suite pass.
- ChatGPT can scan the tools and invoke them in a real conversation.

A successful Vercel deployment by itself does not prove the model gateway or Supabase memory credentials are configured.
