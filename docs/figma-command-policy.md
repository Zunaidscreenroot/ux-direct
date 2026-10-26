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

## Why batch restrictions matter

Batch execution can be partially completed if a later native operation fails. Standalone-only commands are therefore not merely a UI hint: both MCP and the bridge enforce the rule, and the batch item schema does not advertise those commands as valid steps.

## Remaining limitation

`confirm: true` is an explicit command-contract requirement, not a cryptographically independent approval receipt issued by a human in a separate UI. UX Direct should continue to use explicit user intent and scoped file access. Before offering unattended multi-user agents, add a host-issued approval/preview token bound to the exact command payload and target IDs; do not treat model-supplied confirmation alone as a human-approval mechanism.
