# UX Direct — strict Figma access policy

**Enforcement: fail closed.** This policy is both documented here and enforced at plugin startup in `figma-plugin/code.js`.

## One permitted Figma file

- Account context: the user's own full seat inside the Screenroot organization.
- Expected location supplied by the owner: `Drafts / Zunaid_Workspace`.
- Expected file name: `Zunaid_Workspace` (the URL slug uses `Zunaid_workspace`; the runtime check ignores capitalization but still requires the exact file key).
- The plugin is allowlisted to the exact Figma file key `QJhcsebwscpdMJDNh9UsYS` from the URL provided by the owner. A matching name alone is not sufficient.
- The plugin closes at startup if the file key does not match, and performs no selection read, health check, backend heartbeat, telemetry, task request, or bridge registration.
- If the file key is missing/unavailable, mismatched, or the file name differs, access is denied.

Figma's native Plugin API exposes the current file identity to this private development plugin, but it does not prove the parent folder/category path. The exact file key is therefore the enforceable boundary; the folder location is owner-verified setup context.

## Forbidden scope

- No other Figma file, page-file, folder, draft, project, workspace, account content, or Screenroot-owned content.
- No Figma REST API, Figma OAuth, or cross-file API access.
- No `teamlibrary` permission and no querying/importing team-library assets.
- No design-document mutations. Health checks must remain read-only and label operations that would modify content as `NOT TESTED`.
- No telemetry, selected-node metadata, prompt, or task data leaves Figma unless the exact allowlisted file identity is verified first.

## Change-control rules

1. Changes for this product must stay in `Zunaidscreenroot/ux-direct`; never edit `figma-design-agent` or any other repository.
2. Any broader Figma permissions, another file key, file access, library access, or write operation needs the owner's explicit approval before implementation.
3. Keep allowlist checks at the earliest plugin entry point. Do not add a fallback that permits filename-only access.
4. Review the changed-file list before merging; production deploys only after the owner chooses to merge.

## Health-check behavior

The native health check deliberately reports Team Library access as `NOT TESTED`. Do not add `"teamlibrary"` to `manifest.json` to silence an error: that would grant a wider library capability that is outside the approved scope.

## No full-document loading

- The manifest must set `"documentAccess": "dynamic-page"`. Without it, Figma may load all pages when the plugin runs and show “Loading n pages for plugin…”.
- Before the key is approved, startup may read only `figma.fileKey`; it must not access `figma.root`, `figma.currentPage`, selection, page lists, or any node tree.
- If the key does not match, the plugin closes immediately before creating UI or accessing pages.
