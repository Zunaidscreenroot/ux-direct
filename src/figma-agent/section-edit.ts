/**
 * Section edit brief for the native action planner: "make this card cleaner" on one selected card
 * or section. The planner edits that subtree in place; the plugin snapshots it for Revert and checks
 * that the layers next to it stay identical.
 */
const CLEANUP = /\b(clean(er|up)?|simplif(y|ied)|declutter|tidy|less (busy|cluttered|noisy)|minimal(ist)?|polish|neater|more breathing|breathing room|saaf|sundar)\b/i;

type Rec = Record<string, unknown>;

export function sectionEditBrief(prompt: string, canvas: unknown): string {
  const nodes = canvas && typeof canvas === "object" && Array.isArray((canvas as Rec).nodes) ? (canvas as Rec).nodes as Rec[] : [];
  if (nodes.length !== 1 || !CLEANUP.test(prompt)) return "";
  const root = nodes[0];
  if (!Array.isArray(root.children) || !root.children.length) return "";
  return [
    "SECTION EDIT (cleanup): the user selected one section (\"" + String(root.name || "selection").slice(0, 60) + "\") and asked to make it cleaner. Edit ONLY this subtree, in place:",
    "- Keep every text, value, icon and image; never delete nodes and never move layers out of the selection. Hide a purely decorative divider or duplicate border with update-node visible:false only when it adds noise.",
    "- Spacing: padding and itemSpacing on the 4/8 grid (8, 12, 16, 24), equal left/right padding, one consistent gap between rows.",
    "- Hierarchy: at most 3 type sizes (title, body, caption) and 2 weights; the key value is the single strongest element; secondary labels use a muted colour that still passes WCAG contrast.",
    "- Surfaces: one corner radius for the card and one for inner chips; at most one shadow or one border, not both; no nested card-in-card backgrounds.",
    "- Alignment: one left edge for text; numbers right-aligned in rows; use Auto Layout alignment instead of x/y nudges.",
    "- Prefer update-node, set-fills, set-effects and apply-style; use 4–12 actions.",
  ].join("\n");
}
