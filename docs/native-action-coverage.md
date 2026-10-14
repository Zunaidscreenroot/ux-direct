# UX Direct native Figma action coverage

## Counts are different

The status chip reports **native Plugin API health checks**, not the number of action types the AI can perform. A passing API check means a Plugin API surface was executed or verified in the isolated UXD API Test Lab; it does not mean every Automator action is available in the UX Direct plan validator.

## Current AI-controlled native design action catalog

The current plan executor has 32 action types:

- **Text and naming:** `update-text`, `rename-node`, `set-text-style`, `set-description`
- **Appearance:** `set-fill`, `set-stroke`, `set-opacity`, `set-visible`, `set-locked`, `set-blend-mode`, `set-effects`, `set-corner-radius`
- **Geometry and placement:** `move-node`, `resize-node`, `set-rotation`, `reorder-node`, `clone-node`, `remove-node`
- **Layout and responsive rules:** `set-layout`, `set-layout-sizing`, `set-layout-positioning`, `set-constraints`, `set-clip-content`, `set-layout-grid`
- **New layers/vectors:** `create-text`, `create-rectangle`, `create-ellipse`, `create-line`, `create-frame`, `create-svg`
- **Components:** `create-component`, `detach-instance`

Several actions include multiple bounded properties. For example, `set-text-style` supports font family/style/size, color, alignment, letter spacing, line height, paragraph spacing, auto-resize, case and decoration. `set-layout` supports direction, gaps, padding, alignment and sizing. Effects, grid settings, visibility, locking, blend mode and constrained geometry are independently validated.

## Safety boundary

Every AI plan goes through backend schema/quality validation, UI confirmation and native Figma node-type/scope validation. Variation actions execute on clones of the selected source frame, leaving the original frame unchanged. The source frame cannot be deleted or converted into a component. SVG markup is bounded and rejects scripts, event handlers, external resources and JavaScript URLs. Pages, file settings, unrestricted scripting, external fetches, and unrestricted account/file-wide actions are not exposed through this action DSL.

## Automator parity

Automator advertises more than 100 generic actions spanning a broader automation model (including workflow control, variables, HTTP fetching, images, component/style operations and more). UX Direct does **not yet claim literal one-to-one coverage of that entire catalog**. This is the first expanded set focused on editable UX/UI screen work; missing actions should be added as typed, validated handlers—not as arbitrary model-generated JavaScript.

Reference: [Automator feature overview](https://www.producthunt.com/products/automator-for-figma), [Automator v1.1.0 notes](https://blog.diagram.com/p/whats-new-inspect-view-and-variable).
