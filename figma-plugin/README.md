# UX Direct Figma plugin (MVP)

This is the intended conversation cockpit inside Figma. Vercel remains the backend for planning and, as it is built out, task progress, rationale, latency, iterations, and audit history.

## Current scope
- Conversational prompt panel inside Figma.
- Reads the current page name and selected node metadata (ID, name, type, visibility, child count).
- Sends the brief and selected metadata to `https://ux-direct.vercel.app/api/tasks/plan`.
- Renders the returned mock plan and quality checks.
- Does not modify, create, delete, or move Figma nodes.
- Does not send full file contents.

## Import for local testing
1. Download/clone the `ux-direct` repository.
2. Compile the plugin TypeScript entry point to `figma-plugin/code.js` using the repo's plugin build instructions once the bundler script is added.
3. In Figma Desktop, open **Plugins → Development → Import plugin from manifest…**.
4. Select `figma-plugin/manifest.json`.
5. Open a test design file, select a frame, and run **UX Direct** from **Plugins → Development**.
6. Type a prompt and choose the matching project. Verify the plan appears in the plugin panel and that the design canvas remains unchanged.

## Important test limitation
The initial scaffold is not ready to import until `code.ts` is compiled to `code.js`. Also verify Figma's plugin manifest/network-access validation and the deployed endpoint's cross-origin request behavior before asking for user acceptance testing. Do not enable write operations or paid model APIs during this phase.
