# UX Direct Figma plugin (MVP)

The conversational cockpit is inside Figma. **For this test branch, the plugin is intentionally pinned to the PR #31 Netlify Deploy Preview** at https://deploy-preview-31--uxdirect.netlify.app. It does not call the production host.

## Current scope
- Conversational prompt panel inside Figma.
- Reads the current page name and selected node metadata (ID, name, type, visibility, child count).
- Sends the brief and selected metadata to `https://deploy-preview-31--uxdirect.netlify.app/api/tasks/plan`.
- Renders the returned mock plan and quality checks.
- Does not modify, create, delete, or move Figma nodes.
- Does not send full file contents.

## Import for local testing
1. Download/clone this repository.
2. In **Figma Desktop**, open **Plugins → Development → Import plugin from manifest…**.
3. Select `figma-plugin/manifest.json`.
4. Open a test design file, select a frame, and run **UX Direct** from **Plugins → Development**.
5. Type a prompt and choose the matching project. Verify the plan appears in the plugin panel and the canvas remains unchanged.

## Connection status

The panel displays separate statuses for the Deploy Preview backend/bridge, recent authenticated ChatGPT connector activity, and whether this exact Figma plugin session has a fresh heartbeat. The ChatGPT plugin's MCP URL must point to the same preview host. ChatGPT activity is considered recent for five minutes; a Figma plugin session is online while its heartbeat is younger than 75 seconds. ChatGPT does not keep a permanent tool socket open, so the ChatGPT label represents recent authenticated activity, not a continuous network socket.

The activity timestamp and Figma heartbeat are stored in Netlify Blobs. Preview storage names are isolated by Netlify deploy context and review ID so test heartbeat data does not overwrite production connection-state blobs. The ChatGPT API key is never sent to the Figma plugin. Connection status requests are restricted to the approved Figma file key and expected Figma plugin origins.

To move to a different open PR preview, update both `figma-plugin/manifest.json`, `figma-plugin/ui.html`, and the ChatGPT plugin MCP URL to that PR's exact `deploy-preview-<number>--uxdirect.netlify.app` host. Do not point this test build at production.

## Current limitations
- This is a mock-planning vertical slice, not model-powered UX reasoning yet.
- The plugin currently reads selection metadata only; it does not inspect screenshots or full layer trees.
- Validate Figma manifest/network permission behavior and backend CORS in the target Figma desktop/web client before acceptance testing.
- Do not enable write operations or paid model APIs during this phase.
