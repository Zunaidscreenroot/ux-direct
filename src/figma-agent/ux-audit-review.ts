/** Normalization and formatting for the model-written UX audit. */

export type UxAuditFinding = {
  severity: "high" | "medium" | "low";
  heuristic: string;
  screen: string;
  element: string;
  nodeId?: string;
  issue: string;
  fix: string;
};

export type UxAudit = { summary: string; score: number; strengths: string[]; findings: UxAuditFinding[] };

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Accepts the common shapes free models return (findings/issues/problems, priority vs severity). */
export function normalizeUxAudit(value: unknown): UxAudit | null {
  const data = rec(value);
  if (!data) return null;
  const list = [data.findings, data.issues, data.problems, data.recommendations].find(Array.isArray) as unknown[] | undefined;
  if (!list) return null;
  const findings: UxAuditFinding[] = [];
  for (const raw of list.slice(0, 12)) {
    const item = rec(raw);
    if (!item) continue;
    const issue = text(item.issue ?? item.problem ?? item.finding ?? item.description, 400);
    const fix = text(item.fix ?? item.recommendation ?? item.suggestion ?? item.solution, 400);
    if (!issue || !fix) continue;
    const level = text(item.severity ?? item.priority ?? item.impact, 20).toLowerCase();
    const severity = /high|critical|major|severe/.test(level) ? "high" : /low|minor|cosmetic/.test(level) ? "low" : "medium";
    const nodeId = text(item.nodeId, 100);
    findings.push({
      severity, issue, fix,
      heuristic: text(item.heuristic ?? item.principle ?? item.category, 120) || "Usability",
      screen: text(item.screen, 120),
      element: text(item.element ?? item.location, 160),
      ...(/^[0-9A-Za-z:;_-]+$/.test(nodeId) ? { nodeId } : {}),
    });
  }
  if (!findings.length) return null;
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const rawScore = Number(data.score ?? data.overallScore);
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore <= 10 ? rawScore * 10 : rawScore))) : 0;
  return {
    summary: text(data.summary ?? data.overview, 600) || findings.length + " UX issue(s) found.",
    score,
    strengths: Array.isArray(data.strengths) ? data.strengths.map((item) => text(item, 200)).filter(Boolean).slice(0, 3) : [],
    findings,
  };
}

export function formatUxAudit(audit: UxAudit, screenshotCount: number, screenCount: number): string {
  const lines = ["**UX audit" + (screenCount > 1 ? " · " + screenCount + "-screen flow" : "") + (audit.score ? " · " + audit.score + "/100" : "") + "**", audit.summary];
  if (audit.strengths.length) lines.push("", "Working well: " + audit.strengths.join("; "));
  lines.push("");
  audit.findings.forEach((finding, index) => {
    const where = [finding.screen, finding.element].filter(Boolean).join(" › ");
    lines.push((index + 1) + ". **" + finding.severity.toUpperCase() + "** · " + finding.heuristic + (where ? " · " + where : "") +
      "\n   " + finding.issue + "\n   Fix: " + finding.fix);
  });
  if (!screenshotCount) lines.push("", "Note: no screenshot was available, so this audit is based on the layer structure only.");
  return lines.join("\n");
}

/** Small layer tree for the model: names, types, text and sizes only. */
export function compactAuditCanvas(canvas: unknown, maxNodes = 160): unknown[] {
  const root = rec(canvas);
  const nodes = root && Array.isArray(root.nodes) ? root.nodes : [];
  let count = 0;
  const walk = (value: unknown, depth: number): Record<string, unknown> | null => {
    const node = rec(value);
    if (!node || count >= maxNodes || node.visible === false) return null;
    count += 1;
    const out: Record<string, unknown> = { id: node.id, type: node.type, name: text(node.name, 60) };
    if (typeof node.text === "string") out.text = node.text.slice(0, 160);
    if (typeof node.width === "number" && typeof node.height === "number") out.size = Math.round(node.width) + "x" + Math.round(node.height);
    if (Array.isArray(node.children) && depth < 6) {
      const kids = node.children.map((child) => walk(child, depth + 1)).filter(Boolean);
      if (kids.length) out.children = kids;
    }
    return out;
  };
  return nodes.slice(0, 6).map((node) => walk(node, 0)).filter(Boolean) as unknown[];
}
