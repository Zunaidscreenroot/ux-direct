# UX Direct Figma plugin (MVP)

The conversational cockpit belongs inside Figma. Acceptance testing uses the Netlify branch preview at `https://main--uxdirect.netlify.app`, never the production site.

## Current scope
- Conversational prompt panel inside Figma.
- Reads the current page name and selected node metadata (ID, name, type, visibility, child count).
- Sends the brief and selected metadata to `https://main--uxdirect.netlify.app/api/tasks/plan`.
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

The panel displays the UX Direct backend/bridge status, recent authenticated ChatGPT connector activity, and whether this exact Figma plugin session has a fresh heartbeat. ChatGPT activity is considered recent for five minutes; a Figma plugin session is online while its heartbeat is younger than 75 seconds. ChatGPT does not keep a permanent tool socket open, so the ChatGPT label represents recent authenticated activity, not a continuous network socket.

The activity timestamp and plugin heartbeat are stored in Netlify Blobs because serverless memory does not survive across requests. They are namespaced by Netlify branch/deploy context, so preview testing cannot overwrite production connection state. The ChatGPT API key is never sent to the Figma plugin. Connection status requests are restricted to the approved Figma file key and expected Figma plugin origins.

## Switching previews

`ui.html` deliberately accepts only a Netlify branch/Deploy Preview hostname of the form `branch--uxdirect.netlify.app` or `deploy-preview-<number>--uxdirect.netlify.app`. To test a PR, replace the `API` value in that file with its generated Netlify Deploy Preview URL, re-import the manifest in Figma, and open the plugin panel again. Do not set it to `uxdirect.netlify.app`.

## Current limitations
- This is a mock-planning vertical slice, not model-powered UX reasoning yet.
- The plugin currently reads selection metadata only; it does not inspect screenshots or full layer trees.
- Validate Figma manifest/network permission behavior and backend CORS in the target Figma desktop/web client before acceptance testing.
- Do not enable write operations or paid model APIs during this phase.
