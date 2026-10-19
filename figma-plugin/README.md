# UX Direct Figma plugin — Cloudflare Conversational Cockpit

The plugin's production backend is the UX Direct Cloudflare Worker:

`https://ux-direct.zunaid-cb7.workers.dev`

## What's included

- Conversational Cockpit with live status cards for Cloudflare backend, OpenRouter, authenticated ChatGPT MCP activity, and the current Figma plugin heartbeat.
- Manual cockpit refresh plus a low-frequency OpenRouter provider-status refresh.
- Conversational task planning with provider/model and shared-brain diagnostics in the result.
- A native Figma API self-test that reports results back through the Cloudflare plugin bridge.
- Bounded canvas reads for selected layers or the active page tree (up to 100 nodes).
- Explicitly confirmed, scoped canvas writes: create frames, rectangles, ellipses and text; update node name, visibility, position, size or rotation.
- Command status and execution results routed back to ChatGPT through the same bridge.
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

## Canvas read/write commands

- Read: ask ChatGPT to call `ux_direct_figma_canvas_read` with `scope=selection` or `scope=current-page`. Reads are bounded by `maxDepth` (0–4) and `maxNodes` (1–100).
- Create: `ux_direct_figma_canvas_write` supports up to 20 frame, rectangle, ellipse or text nodes per command. Use `target=test-lab` for smoke tests, `selection` for a selected container, or `current-page` for the active page.
- Update: the same write tool can update the name, visibility, position, size or rotation of a node on the active page.
- Verification: use `ux_direct_figma_canvas_command_status` with the returned `commandId`. Do not claim a change succeeded until the status contains a completed result.
- Writes require `confirm=true` and a specific owner-requested edit. Delete operations, arbitrary code, bulk replacement, page switching, variable writes and Team Library imports are not exposed.
- The plugin uses an exact file-key allowlist and never reads or writes other Figma files. Read results are bounded and include layer metadata/text only, not screenshot pixels or full file contents.
- Figma OAuth is not required for the native Plugin API path. The installed development plugin must be reloaded/re-imported after plugin source changes; deploying the Worker alone does not update a locally imported plugin.
