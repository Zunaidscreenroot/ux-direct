/**
 * How Claude designs a screen in Figma, written as an explicit procedure so the free models
 * follow the same steps. The plugin's "improve" path runs the assess → preserve → self-check part
 * deterministically (figma-plugin/code.js, uxd-claude-polish); this playbook is for the rebuild path,
 * where a model writes the block spec. Generic: no domain or screen names.
 */
export const CLAUDE_DESIGN_PLAYBOOK = [
  "DESIGN PLAYBOOK (follow these steps silently; output only the JSON):",
  "1. Assess first: what the screen is for, its one primary task, and what already works. Keep what works; change only what improves hierarchy, grouping or clarity.",
  "2. Inventory: every section in order, and every repeated item (cards, rows, tabs) with its parts. Keep the same section order, the same number of repeated items and every source string.",
  "3. One anatomy per repeated item: all items of a kind use the identical block order, header (title and ID, with logo or status badge on the same line) then body (visual, key values side by side, chevron) then the optional alert with its action inline. An item without a part omits it; never reorder parts between siblings.",
  "4. Keep side-by-side groupings: whatever sits in one row in the source stays in one row (a visual beside its values, a label beside its value, an action beside its alert text).",
  "5. Hierarchy through weight and colour, not more sizes: at most 5 type sizes; title over value over label over caption; a status is a badge next to what it describes.",
  "6. Fit: same frame height as the source within 10%. Do not add full-width buttons, illustrations, image placeholders or sections the source did not have.",
  "7. Reuse: app bars, tabs, navigation and any repeated control come from canvas.components (component block) when the file has them.",
  "8. Colour: copy the source theme; accent colours (brand-coloured titles, status tones) keep their role and their colour.",
  "9. Self-check before answering: every source string appears exactly once, the repeated-item count matches the source, every repeated item has the same block order, nothing is invented.",
].join("\n");
