# UX Direct Figma AI Agent

UX Direct is a source-aware, native Figma editing agent. Its workflow combines a senior UI/UX design planner, a typed native-operation planner, the Figma Plugin API, bounded canvas inspection, and rendered visual review. It operates only inside the approved Figma file enforced by the plugin's file-key allowlist.

Production backend: https://ux-direct.zunaid-cb7.workers.dev

## What it can do

### Full design work
- Create a separate editable variation from a selected frame, screen, card, or component while preserving the source.
- Inspect a bounded native layer tree and a rendered screenshot together.
- Use a user-attached reference image as additional visual context for design generation.
- Build editable native frames, text, shapes, vector paths, arc-based progress indicators, and nested sections.
- Apply native Auto Layout, modern HUG/FILL/FIXED sizing, alignment, padding, wrapping, and intentional absolute overlays.
- Reuse supplied local paint/text/effect/grid styles and inspect local variables/collections when available.
- Review the created canvas against the source screenshot, read back native properties, and perform up to two bounded visual repair passes when the quality gate still fails.

### Direct native editing
For explicit, targeted requests, the agent can propose and apply a small sequence of native operations, including:
- Text content and typography updates, line height, letter spacing, fills, strokes, opacity, dimensions, effects, corner radius, and Auto Layout properties.
- Adding native layers or nested frames; inserting an actually attached image or applying it as an image fill.
- Grouping, ungrouping, reparenting, reordering, cloning, flattening, and boolean operations.
- Converting suitable frames to components, creating variants from sibling components, creating instances, swapping instances, and detaching instances.
- Creating/binding supported local variables and reusing local styles.
- Creating or renaming pages, switching to a page from the approved file's page catalogue, selecting/zooming to nodes, and exporting supported nodes as PNG, JPG, PDF, or SVG.

The supported operations are an explicit allowlist. The agent does not execute arbitrary model-generated JavaScript and never treats a rendered screenshot as an insertable image asset. Deletion is gated on explicit user intent. Actions that require a node or page ID must use IDs from the inspected selection or approved-file catalogue; unsupported or ambiguous actions fail validation instead of guessing.

## Import into Figma Desktop

1. Download the import-ready ux-direct-figma-plugin-cloudflare.zip artifact from the successful Package Figma Plugin workflow.
2. Extract the ZIP.
3. In Figma Desktop, select Plugins → Development → Import plugin from manifest…
4. Choose the extracted manifest.json.
5. Open the approved workspace file and run UX Direct from Plugins → Development.
6. Select the frame/layer you want to work on and refresh the selection if the cockpit prompts you to.

**Important:** Deploying the backend does not update a locally imported Figma Desktop plugin. Re-import or reload the plugin after downloading an updated bundle.

## Model routing and cost

Figma generation and direct action planning use the configured FreeLLMAPI Auto route. The router selects from its configured upstream pool; ensure the selected profile supports vision and structured JSON output. Fallbacks are sequential, not parallel. Full screenshot QA/repair is conditional on the quality gate, so stronger review is reserved for outputs that need it.

The API key stays on the backend; it is not exposed to the Figma plugin UI.

## Architecture

- figma-plugin/ui.html: conversation, request-intent routing, visual review, bounded repair, import-image handling, and export download flow.
- figma-plugin/code.js: the native Figma API executor, file-scope guard, bounded readback, and named write operations.
- app/api/assistant/figma-agent/route.ts: screenshot-aware full design planner, schema validation, Auto Layout planning, reference-image context, and model routing.
- app/api/assistant/figma-agent/actions/route.ts: direct native action planner with exact node/page/style/variable catalogue validation.
- app/api/plugin-bridge/route.ts and app/api/mcp/route.ts: validated queue/bridge contracts and tool dispatch.
- src/figma-agent/normalize-plan.ts: normalizes model plans into a native layout contract before any writes.
- tests/figma-canvas-bridge.test.ts and the other tests/*.test.ts files: regression checks, operation allowlists, schema constraints, intent routing, and UI syntax.

## Safety and verification

- Canvas reads are bounded by depth and node count.
- Native edits run through named operations and strict schemas.
- The original source remains untouched for full design variations.
- Destructive changes require a specific user request; the agent does not attempt bulk replacement or arbitrary document traversal.
- A successful response is not sufficient by itself: visual tasks perform native readback and, when available, rendered review.
- If a native write is rejected, the agent reports the failure rather than claiming success.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build:figma-plugin-effects
```

The import-ready package already contains ui-effects.js; the local effects build is needed after changing figma-plugin/ui-effects.tsx.
