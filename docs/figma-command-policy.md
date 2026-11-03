# Figma command registry and execution policy

UX Direct uses FigCraft as an architectural reference only. This implementation does not import the FigCraft editor or runtime; the native Figma Plugin API remains the executor.

## One canonical catalogue

`src/figma-agent/command-registry.ts` is the source of truth for native canvas operation IDs and policy metadata:

- `risk`: low, medium or high impact.
- `destructive`: the operation can remove or materially alter existing structure or component semantics.
- `requiresExplicitIntent`: the operation must be tied to a specific user request, not inferred from a vague goal.
- `batchable`: the operation is allowed inside a multi-step batch.

MCP's top-level write schema, MCP's nested batch schema, the server bridge's Zod validators, and the in-plugin action planner derive their operation IDs from this catalogue. The read-only `ux_direct_figma_canvas_capabilities` MCP tool exposes the same metadata to callers before they plan writes.

## Enforcement layers

1. **MCP access:** OAuth scopes distinguish read, execute and learning tools.
2. **Command contract:** every write requires `confirm: true`; inputs are limited to named operations and typed fields.
3. **Batch policy:** only operations marked `batchable: true` may be nested under `batch`. Destructive operations remain available as individual commands so they cannot be hidden among unrelated steps. The server rejects invalid batches even if a caller bypasses the advertised MCP schema.
4. **Bridge session:** writes require the live session token, exact allowlisted file key, an online plugin, command expiry and the one-active-command lock.
5. **Native executor:** the plugin independently checks the approved file scope and validates target IDs before native API access or mutation.
6. **Verification:** callers retrieve the command result and use native readback/visual review before claiming success.
7. **Structural lint:** `src/figma-agent/structural-lint.ts` runs model-free checks on the read-back (text/text and icon/text overlap, clipping by a clipping ancestor, collapsed text, and source text/value/graphic preservation). Variations are not logged as verified unless it passes; visual review merges its findings and caps the score when a high-severity defect remains.

## Why batch restrictions matter

Batch execution can be partially completed if a later native operation fails. Standalone-only commands are therefore not merely a UI hint: both MCP and the bridge enforce the rule, and the batch item schema does not advertise those commands as valid steps.

## Remaining limitation

`confirm: true` is an explicit command-contract requirement, not a cryptographically independent approval receipt issued by a human in a separate UI. UX Direct should continue to use explicit user intent and scoped file access. Before offering unattended multi-user agents, add a host-issued approval/preview token bound to the exact command payload and target IDs; do not treat model-supplied confirmation alone as a human-approval mechanism.

## Extended native actions

`src/figma-agent/native-action-schema.ts` holds the Zod fields for the richer native actions. The bridge, the MCP tool schema (via `z.toJSONSchema`) and the AI action planner all spread the same fields, and `extendedActionIssues` holds the per-operation required-field rules, so a field the planner can emit is always one the bridge accepts.

| Operation | Native API | Notes |
|---|---|---|
| `wrap-in-auto-layout` | `createFrame` + `layoutMode` + `appendChild` | Wraps loose siblings without changing content. Keeps visual order and infers `itemSpacing` from current gaps when omitted. Refuses to restructure inside instances. |
| `set-fills` | `fills` / `strokes` | Solid and linear/radial/angular/diamond gradients. `angle` 0° = left→right, 90° = top→bottom. |
| `set-effects` | `effects` | Drop/inner shadows, layer and background blur. |
| `set-layout-grids` | `layoutGrids` | Columns, rows and square grids. |
| `add-component-property` | `addComponentProperty`, `componentPropertyReferences` | A linked TEXT property defaults to the layer's current text. |
| `set-instance-properties` | `setProperties` | Accepts property names without the `#id` suffix. |
| `set-reactions` | `setReactionsAsync` | Appends by default (`reactionMode: "replace"` to overwrite). http(s) URLs only. |
| `set-flow-start` | `flowStartingPoints` | Top-level frames only. |
| `create-styles` | `createPaintStyle` / `createTextStyle` / `createEffectStyle` | Upserts by name. |
| `set-variable-mode` | `setExplicitVariableModeForCollection` | For Light/Dark previews. |

`create-elements` also accepts `type: "INSTANCE"` with `componentId` and `instanceProperties`, and `create-instance` accepts `parentNodeId`/`index`. `read-canvas` with `includeComponents: true` returns the component catalogue: components used on the page, ranked by use (library components included), plus local components and sets. Both AI paths (edit planner and screen generator) get this catalogue and are told to place instances before drawing primitives. Component IDs in a plan must come from the catalogue or the inspected selection.
