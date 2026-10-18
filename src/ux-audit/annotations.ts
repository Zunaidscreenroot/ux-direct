import type { AuditFinding, NormalizedRegion } from "./types";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Validate and normalize AI-proposed screenshot fractions before rendering. */
export function normalizeRegion(value: unknown): NormalizedRegion | null {
  if (!value || typeof value !== "object") return null;
  const region = value as Record<string, unknown>;
  const raw = [region.x, region.y, region.width, region.height];
  if (raw.some((part) => typeof part !== "number" || !Number.isFinite(part))) return null;
  const x = clamp01(region.x as number);
  const y = clamp01(region.y as number);
  const width = clamp01(region.width as number);
  const height = clamp01(region.height as number);
  if (width <= 0 || height <= 0 || x >= 1 || y >= 1) return null;
  return {
    x,
    y,
    width: Math.min(width, 1 - x),
    height: Math.min(height, 1 - y)
  };
}

/** CSS percentages are used so annotations stay aligned as an image resizes. */
export function regionToPercentStyle(region: NormalizedRegion): {
  left: string; top: string; width: string; height: string;
} {
  return {
    left: `${region.x * 100}%`,
    top: `${region.y * 100}%`,
    width: `${region.width * 100}%`,
    height: `${region.height * 100}%`
  };
}

export function sortFindingsBySeverity(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "issue" ? -1 : 1;
    return (b.severity ?? 0) - (a.severity ?? 0) || a.id.localeCompare(b.id);
  });
}

export function deduplicateFindings(findings: AuditFinding[]): AuditFinding[] {
  const seen = new Set<string>();
  const result: AuditFinding[] = [];
  for (const finding of sortFindingsBySeverity(findings)) {
    const key = [
      finding.kind,
      finding.category,
      finding.screenshotIndex,
      finding.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result.map((finding, index) => ({
    ...finding,
    id: finding.kind === "positive" ? `P-${String(index + 1).padStart(2, "0")}` : `F-${String(index + 1).padStart(2, "0")}`
  }));
}
