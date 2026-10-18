import { test } from "node:test";
import assert from "node:assert/strict";
import { deduplicateFindings, normalizeRegion, regionToPercentStyle } from "../src/ux-audit/annotations";
import type { AuditFinding } from "../src/ux-audit/types";

function finding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id: "",
    kind: "issue",
    category: "CTA-AMBIGUITY",
    severity: 3,
    title: "Primary CTA is unclear",
    screenshotIndex: 0,
    evidence: "Two competing buttons have the same visual weight.",
    impact: "The user may not know which route to choose.",
    recommendation: "Give the main action a clear visual priority.",
    heuristic: "Nielsen #8",
    confidence: 0.9,
    region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
    ...overrides
  };
}

test("normalized screenshot regions are clamped to the image bounds", () => {
  assert.deepEqual(normalizeRegion({ x: 0.9, y: 0.8, width: 0.5, height: 0.7 }), {
    x: 0.9, y: 0.8, width: 0.09999999999999998, height: 0.19999999999999996
  });
  assert.equal(normalizeRegion({ x: 0, y: 0, width: 0, height: 0.2 }), null);
  assert.equal(normalizeRegion({ x: "left", y: 0, width: 0.2, height: 0.2 }), null);
});

test("annotation overlay styles stay in percentages for responsive screenshots", () => {
  assert.deepEqual(regionToPercentStyle({ x: 0.25, y: 0.1, width: 0.4, height: 0.3 }), {
    left: "25%", top: "10%", width: "40%", height: "30%"
  });
});

test("duplicate findings collapse into stable issue IDs and positives keep separate IDs", () => {
  const items = deduplicateFindings([
    finding(),
    finding({ title: "Primary CTA is unclear!", evidence: "Repeated evidence." }),
    finding({ kind: "positive", category: "POSITIVE", severity: null, title: "Clear page heading" })
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, "F-01");
  assert.equal(items[1].id, "P-02");
});
