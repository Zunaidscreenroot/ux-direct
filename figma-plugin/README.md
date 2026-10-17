# UX Direct Figma plugin (MVP)

The conversational cockpit belongs inside Figma. The current backend preview is hosted on Vercel at https://ux-direct-git-feat-netlify-uxdirect-oauth-mcp-screenroot.vercel.app.

## Current scope
- Conversational prompt panel inside Figma.
- Reads the current page name and selected node metadata (ID, name, type, visibility, child count).
- Sends the brief and selected metadata to `https://ux-direct-git-feat-netlify-uxdirect-oauth-mcp-screenroot.vercel.app/api/tasks/plan`.
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

The panel displays backend reachability and whether this Figma plugin session has a fresh heartbeat. A plugin session is considered online while its heartbeat is younger than 75 seconds. Session tokens, queued health-check commands, and result reports are stored in the project's private Vercel Blob store. Requests are restricted to the approved Figma file key and expected Figma plugin origins.

## Current limitations
- This is a mock-planning vertical slice, not model-powered UX reasoning yet.
- The plugin currently reads selection metadata only; it does not inspect screenshots or full layer trees.
- Validate Figma manifest/network permission behavior and backend CORS in the target Figma desktop/web client before acceptance testing.
- Do not enable write operations or paid model APIs during this phase.
