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

/**
 * The concrete moves Claude makes for a named design objective. "Simplify" used to come back as a
 * near copy because the content rule (keep every source string) left the model no idea what else
 * to change; these moves cut visual noise while every fact stays.
 */
export function objectivePlaybook(prompt: string): string {
  const text = String(prompt || "");
  const lines: string[] = [];
  if (/\b(simplif\w*|simple|simpler|declutter\w*|clutter\w*|minimal\w*|cleaner|less busy|calm\w*|saaf|aasan)\b/i.test(text)) {
    lines.push(
      "OBJECTIVE: SIMPLIFY. Keep every fact, cut the noise; the result must look clearly calmer than the source at a glance.",
      "- One primary action style per screen; other actions become secondary or text buttons.",
      "- Drop decoration that groups nothing: extra borders, shadows, tinted panels, divider lines. One surface colour for all cards.",
      "- Fewer colours: neutral text, one accent, status tones only. At most 4 type sizes and 2 weights.",
      "- Secondary detail (IDs, captions, helper text) goes into one muted caption line under its title.",
      "- Flatten: no card inside a card; simple items become list rows instead of heavy cards.",
      "- More space between groups, less inside them.",
    );
  }
  if (/\b(hierarchy|scannab\w*|clarity|clearer|readab\w*|focus)\b/i.test(text)) {
    lines.push(
      "OBJECTIVE: HIERARCHY. The eye must land on the one most important value or action first.",
      "- Biggest weight on the key value of each item; labels muted and smaller; one accent for the primary action.",
      "- Group related values side by side; status next to the title it describes.",
    );
  }
  if (/FEEDBACK ON THE PREVIOUS ATTEMPT/.test(text)) {
    lines.push("The designer rejected the previous attempt. Read their feedback literally and make that exact change obvious; do not return a near copy of the source.");
  }
  return lines.join("\n");
}
