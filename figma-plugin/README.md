# UX Direct Figma plugin (MVP)

The conversational cockpit belongs inside Figma. Vercel remains the backend for task planning and, as it is built out, progress, rationale, latency, iterations, and audit history.

## Current scope
- Conversational prompt panel inside Figma.
- Reads the current page name and selected node metadata (ID, name, type, visibility, child count).
- Sends the brief and selected metadata to `https://ux-direct.vercel.app/api/tasks/plan`.
- Renders the returned mock plan and quality checks.
- Does not modify, create, delete, or move Figma nodes.
- Does not send full file contents.

## Import for local testing
1. Download/clone this repository.
2. In **Figma Desktop**, open **Plugins → Development → Import plugin from manifest…**.
3. Select `figma-plugin/manifest.json`.
4. Open a test design file, select a frame, and run **UX Direct** from **Plugins → Development**.
5. Type a prompt and choose the matching project. Verify the plan appears in the plugin panel and the canvas remains unchanged.

## Current limitations
- This is a mock-planning vertical slice, not model-powered UX reasoning yet.
- The plugin currently reads selection metadata only; it does not inspect screenshots or full layer trees.
- Validate Figma manifest/network permission behavior and backend CORS in the target Figma desktop/web client before acceptance testing.
- Do not enable write operations or paid model APIs during this phase.
