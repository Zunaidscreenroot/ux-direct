# UX Direct — API-level Figma scope policy

## The only allowed document
- Exact file key: `QJhcsebwscpdMJDNh9UsYS` (`Zunaid_Workspace`).
- Native Plugin API operations are tied to the currently open Figma document. Revalidate the live `figma.fileKey` before page reads and every action.
- Multiple pages inside the approved file are allowed. Page creation, switching, reading, editing and deletion stay inside this single document.
- This never authorizes another file, even if its file or page name looks similar.

## Mandatory API guard
- `assertUxDirectFileScope(actionName)` is the fail-closed native runtime guard.
- AI execution must use an explicit action allowlist/dispatcher. Never let model output invoke arbitrary methods, supply a destination file key, or pass arbitrary URLs to `figma.openExternal`.
- The API bridge, task endpoint, telemetry endpoint, health endpoint and plugin sessions reject missing/mismatched file keys for plugin-originated requests.
- Backend key validation is defense in depth, not cryptographic proof of the live document. The authoritative runtime identity available to the native plugin is `figma.fileKey`. No Figma REST API, OAuth or cross-file API access is configured.

## Safe API smoke test
- The first self-test creates or reuses `UXD API Test Lab` in the approved file and switches to it.
- Real operations are exercised there: page create/switch/remove; shapes; text/font; grouping/flattening/boolean operations; component/instance/variant; temporary variables; client storage; export; selection event delivery; UI bridge round-trip.
- Temporary nodes, temporary pages, variable collections and storage keys are cleaned up. The lab page remains and the original active page is restored.
- Only disruptive actions remain `AVAILABLE`: close plugin, open external browser and interrupting notifications. Team Library remains `NOT TESTED`.

## Future AI executor
Build a closed dispatcher with approved action IDs (for example, inspect selection, switch page within the current file, create shape on a target page, and edit node). Validate the live file key and resolve every target node from the current document before a write. Never expose arbitrary method names or executable code to the model.
