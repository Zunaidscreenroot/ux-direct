# UX Direct Figma plugin — Cloudflare Conversational Cockpit

The plugin's production backend is the UX Direct Cloudflare Worker:

`https://ux-direct.zunaid-cb7.workers.dev`

## What's included

- Conversational Cockpit with live status cards for Cloudflare backend, OpenRouter, authenticated ChatGPT MCP activity, and the current Figma plugin heartbeat.
- Manual cockpit refresh plus a low-frequency OpenRouter provider-status refresh.
- Conversational task planning with provider/model and shared-brain diagnostics in the result.
- A native Figma API self-test that reports results back through the Cloudflare plugin bridge.
- Exact allowlist protection for the approved Figma file.

## Import into Figma Desktop

1. Download and extract `UX-Direct-Figma-Plugin-Cloudflare.zip`.
2. In Figma Desktop, open **Plugins → Development → Import plugin from manifest…**
3. Select the extracted `manifest.json`.
4. Open the approved `Zunaid_Workspace` file and run **UX Direct** from **Plugins → Development**.
5. Select a frame/layer and press **Refresh selection** before asking UX Direct to plan a task.

## Status semantics

- **Cloudflare backend:** `/api/health` responds from the deployed Worker; bridge heartbeat is checked separately.
- **OpenRouter:** the server validates the configured provider key and confirms available free models. The plugin never sees the API key.
- **ChatGPT · MCP:** green means an authenticated ChatGPT MCP request was received within the previous five minutes. It is intentionally a recent-activity indicator, not a permanent socket.
- **Figma bridge:** green means this plugin session's heartbeat was received within the previous 75 seconds.

Connection/session state and plugin health reports are stored through the existing Cloudflare R2 binding. Do not add or restore Netlify/Vercel variables.

## Verify MCP → Figma

Ask ChatGPT to run the UX Direct MCP native plugin health check. The MCP tool queues a health-check command; the open plugin receives it on the next heartbeat, runs the native API test in the dedicated **UXD API Test Lab** page, and syncs the report back to Cloudflare.

- Queue: `ux_direct_figma_plugin_queue_health_check`
- Read status/result: `ux_direct_figma_plugin_health_check_status` with the returned `commandId`

The native health test may create or reuse persistent test fixtures on the dedicated test page. It does not navigate away from or intentionally change the user's active working page.

## Current limitations

- Task planning can use OpenRouter model reasoning and approved shared-brain context, but the plugin does not yet expose general-purpose Figma design read/write execution through MCP.
- The task planner currently sends the brief and selected-node metadata (ID, name, type, visibility, child count); it does not upload full file contents or screenshot pixels and does not inspect the complete layer tree automatically.
- Planning does not create, delete, move, or edit production Figma design nodes.
- Figma OAuth is not required for the native Plugin API path.
