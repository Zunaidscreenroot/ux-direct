/**
 * Per-file design rules ("DESIGN.md" for a Figma file): spacing/radius/type scales, colours and
 * tone the designer set in chat, stored in the Figma file and sent by the plugin on every call.
 */
export function cleanDesignRules(value: unknown): string {
  if (typeof value !== "string") return "";
  // Plain text only: drop control characters and our own prompt markers, keep markdown.
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/<\/?UXD_[A-Z_]*>/g, "").trim().slice(0, 4000);
}

/** The system-prompt block, or "" when the file has no rules. */
export function designRulesBlock(value: unknown): string {
  const rules = cleanDesignRules(value);
  if (!rules) return "";
  return "\nFILE DESIGN RULES (set by the design team for this Figma file; must follow, they override generic defaults and team examples but never the user's explicit request):\n" + rules + "\nEND FILE DESIGN RULES";
}
