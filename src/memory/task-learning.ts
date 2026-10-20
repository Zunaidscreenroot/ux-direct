export type FigmaFailureCategory =
  | "file-scope"
  | "stale-node-id"
  | "timeout-or-expired"
  | "unsupported-api"
  | "invalid-payload";

export type FigmaFailureLesson = {
  category: FigmaFailureCategory;
  title: string;
  rawFeedback: string;
  normalizedRule: string;
  rationale: string;
  keywords: string[];
  idempotencyKey: string;
};

/**
 * Convert a verified native-plugin failure into a small reusable recovery rule.
 * Never return/store the raw error text because it may contain client or canvas data.
 */
export function buildFigmaFailureLesson(errorMessage: string): FigmaFailureLesson | null {
  const value = String(errorMessage || "").toLowerCase();
  let category: FigmaFailureCategory | null = null;

  if (/\b(allowlist|allowlisted|file[- ]key|approved file|permission|not authorized)\b/.test(value)) {
    category = "file-scope";
  } else if (/\b(node.{0,30}(not found|unknown|missing)|unknown node|invalid node.?id|node id.{0,30}(not found|invalid|stale))\b/.test(value)) {
    category = "stale-node-id";
  } else if (/\b(expired|timed out|timeout|no longer active|stopped responding|offline)\b/.test(value)) {
    category = "timeout-or-expired";
  } else if (/\b(unsupported|not supported|is not a function|api.{0,20}(missing|unavailable))\b/.test(value)) {
    category = "unsupported-api";
  } else if (/\b(invalid payload|payload is invalid|validation|schema|requires .{1,50}|required field|must be provided)\b/.test(value)) {
    category = "invalid-payload";
  }

  if (!category) return null;

  const rules: Record<FigmaFailureCategory, { label: string; rule: string; keywords: string[] }> = {
    "file-scope": {
      label: "file scope or permission check",
      rule: "When a Figma command fails a file-scope or permission check, verify the active file key and approved plugin session before retrying. Never bypass the file allowlist or replay writes into another file.",
      keywords: ["figma", "plugin", "file-scope", "permissions", "security"],
    },
    "stale-node-id": {
      label: "stale or unknown node ID",
      rule: "Before editing, cloning, reparenting, or styling a Figma node, refresh the active page or selection and verify the node ID. If it still fails, re-read the current canvas state rather than repeatedly retrying a stale ID.",
      keywords: ["figma", "plugin", "canvas", "node-id", "recovery"],
    },
    "timeout-or-expired": {
      label: "timed-out or expired command",
      rule: "When a Figma canvas command times out or expires, check its command status and re-read the current canvas before retrying. A write batch may partially complete, so do not blindly replay non-idempotent operations.",
      keywords: ["figma", "plugin", "execution", "timeout", "command-status", "recovery"],
    },
    "unsupported-api": {
      label: "unsupported native API operation",
      rule: "Before retrying a failed Figma operation, verify native Plugin API support and the installed UX Direct bridge version. Report unsupported capabilities explicitly instead of assuming a write succeeded.",
      keywords: ["figma", "plugin", "native-api", "execution", "recovery"],
    },
    "invalid-payload": {
      label: "invalid command payload",
      rule: "When a Figma command payload fails validation, correct its schema and required fields before retrying. Do not repeatedly submit the same invalid payload, and verify command status after any retry.",
      keywords: ["figma", "plugin", "payload", "validation", "execution"],
    },
  };

  const selected = rules[category];
  return {
    category,
    title: "Figma execution recovery · " + category,
    rawFeedback: "Sanitized task learning from a verified Figma plugin failure category: " + category + ". Raw error text, node IDs, screen text, and canvas data were not copied into the shared brain.",
    normalizedRule: selected.rule,
    rationale: "Derived from the outcome of a native Figma canvas command. Only a normalized recovery principle and the coarse failure category are retained; the raw error and design content are excluded.",
    keywords: selected.keywords,
    idempotencyKey: "uxd-figma-recovery-" + category,
  };
}
