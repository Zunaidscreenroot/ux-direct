# Security Boundary and Spend Policy

## Figma scope: deny by default

The only intended workspace label is `zunaid_workspace`. This label is not, by itself, an authorization control: Figma operations must be checked against explicit file IDs because Figma API calls are scoped to files/nodes and the workspace label may not be an enforceable API boundary.

- `FIGMA_ALLOWED_FILE_IDS` is a comma-separated allowlist of explicitly approved file keys.
- An empty or missing allowlist denies every file.
- A file not in the allowlist is denied, even if it was returned by search or selected in the UI.
- The workspace label must match `zunaid_workspace`.
- Every future read/write adapter must call `assertFigmaFileAccess` immediately before the operation.
- Start read-only. Writes require a separate explicit approval path and an audit record.
- Never store Figma access tokens in source control or browser-visible code.
- Never enumerate, read, or modify other company folders/files to discover the desired file.
- Add negative tests for an empty allowlist, wrong file ID, and wrong workspace.

**Current status:** no file keys have been supplied to this code, so Figma access must remain disabled. The current helper is a security primitive, not a claim that the Figma adapter is already connected.

## Paid usage gate

- Default provider is `mock`; no model API calls occur in mock mode.
- Paid model capabilities must be disabled until the owner explicitly approves the provider and budget.
- Target combined variable spend: INR 100/day maximum, including all model APIs and metered services. Subscription charges are separate fixed costs and must be considered in the total monthly spend.
- Add per-provider cost estimates, daily budget accounting, hard request limits, and a kill switch before enabling paid calls.
- Do not add billing credentials, payment details, or real API keys until the free/local MVP and its tests pass and the owner approves.

## Repository scope

All product changes belong in `Zunaidscreenroot/ux-direct`. Do not read or modify the separate `figma-design-agent` repository as part of this work.
