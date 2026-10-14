import test from "node:test";
import assert from "node:assert/strict";
import {
  UXD_IR_VERSION,
  compactFigmaNodes,
  parseUxdirJson,
  normalizeVisionEvidence,
  validateUxdirVariationPlan,
  summarizeUxdIrTrace,
  classifyUxdIrError,
} from "../src/figma/uxd-ir";

test("UXD-IR compact node index preserves IDs and clips the tree to its bound", () => {
  const nodes = compactFigmaNodes([{
    id: "frame-1", type: "FRAME", name: "Loan Screen", width: 360, height: 800,
    children: [
      { id: "text-1", type: "TEXT", name: "CTA", characters: "Pay ₹10,000" },
      { id: "shape-1", type: "RECTANGLE", name: "Card" },
    ],
  }], 2);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].id, "frame-1");
  assert.equal(nodes[1].id, "text-1");
  assert.equal(nodes[1].text, "Pay ₹10,000");
});

test("UXD-IR parser accepts fenced JSON but rejects prose and arrays", () => {
  assert.deepEqual(parseUxdirJson('```json\n{"v":1,"stage":"vision"}\n```'), { v: 1, stage: "vision" });
  assert.equal(parseUxdirJson("Here is the JSON: {}"), null);
  assert.equal(parseUxdirJson("[]"), null);
});

test("vision evidence is normalized and hallucinated node IDs are removed", () => {
  const normalized = normalizeVisionEvidence({
    v: UXD_IR_VERSION,
    stage: "vision",
    frame: { width: 360, height: 800 },
    facts: [{ key: "payment_total", value: "₹10,000", source: "pixels" }],
    elements: [{ id: "real", role: "primary_cta" }, { id: "invented", role: "button" }],
    observations: [{ kind: "cta_hierarchy", targets: ["real", "invented"], evidence: "CTA is visually prominent", confidence: 1.2 }],
    uncertainties: [],
  }, new Set(["real"]));
  assert.ok(normalized);
  assert.equal(normalized.elements.length, 1);
  assert.deepEqual(normalized.observations[0].targets, ["real"]);
  assert.equal(normalized.observations[0].confidence, 1);
});

test("vision evidence fails closed when the role/version or useful payload is missing", () => {
  assert.equal(normalizeVisionEvidence({ v: 1, stage: "reasoning", facts: [], observations: [] }, new Set()), null);
  assert.equal(normalizeVisionEvidence({ v: 1, stage: "vision", facts: [], observations: [], elements: [] }, new Set()), null);
});

test("variation plans must be structurally distinct and use supported operations", () => {
  const goodPlan = {
    variations: [{
      name: "Pay all EMIs",
      rationale: "Make the full amount payable in one clear primary action.",
      operations: [
        { action: "move-node", targetId: "cta", x: 12, y: 24 },
        { action: "resize-node", targetId: "cta", width: 320, height: 48 },
        { action: "set-layout", targetId: "frame", layoutMode: "VERTICAL" },
        { action: "set-fill", targetId: "cta", color: "#114488" },
        { action: "update-text", targetId: "label", text: "Pay All EMIs" },
        { action: "set-text-style", targetId: "label", fontSize: 14 },
      ],
    }],
  };
  assert.deepEqual(validateUxdirVariationPlan(goodPlan, 1), {
    valid: true, variationCount: 1, operationCount: 6,
  });
  assert.equal(validateUxdirVariationPlan({ variations: [{ ...goodPlan.variations[0], operations: goodPlan.variations[0].operations.slice(0, 5) }] }, 1).valid, false);
  assert.equal(validateUxdirVariationPlan({ variations: [{ ...goodPlan.variations[0], operations: goodPlan.variations[0].operations.map((op) => ({ ...op, action: "unknown" })) }] }, 1).reason, "unsupported_action");
});

test("trace summary is deterministic and error labels are coarse", () => {
  const trace = summarizeUxdIrTrace({
    runId: "run-1", capability: "bfci.screen-redesign", mode: "action", status: "awaiting_confirmation",
    stages: [
      { role: "vision", status: "completed" },
      { role: "reasoning", status: "failed" },
    ],
  });
  assert.match(trace, /Stages completed: 1/);
  assert.match(trace, /Stages failed: 1/);
  assert.equal(classifyUxdIrError("HTTP 429 rate limit"), "rate_limit");
  assert.equal(classifyUxdIrError("spend ledger unavailable"), "budget");
});
