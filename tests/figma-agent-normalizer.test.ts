import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlan } from "../src/figma-agent/normalize-plan";

test("normalizes OpenRouter layer fields that previously failed strict Figma plan validation", () => {
  const normalized = normalizePlan({
    summary: "A more transparent multiple-loan overview.",
    frame: { name: "Manage loans · Variation", width: 393, height: 852, backgroundColor: "#fafafa" },
    elements: [
      { x: 0, y: 0, width: 393, height: 852, fill: { type: "SOLID", color: { r: 1, g: 1, b: 1 } } },
      { kind: "text", text: "Manage loans", x: 24, y: 28, width: 250, height: 36, fontSize: 120, fill: "#202124" },
      { type: "button", label: "Pay EMI", x: 24, y: 120, width: 345, height: 48, fill: "#0A6E5C", radius: 12 },
      { type: "rect", name: "Outstanding summary", x: 24, y: 190, width: 345, height: 130, fill: "#F3F6F5" },
      { content: "Next EMI due 25 Oct", x: 36, y: 215, width: 240, height: 24, fill: "#202124" },
      { type: "text", content: "View all loans", x: 24, y: 340, width: 345, height: 28, color: "#0A6E5C" }
    ]
  }, { pageName: "Loans", nodes: [] }) as {
    summary: string;
    frame: { name: string; width: number; height: number; backgroundColor: string };
    elements: Array<Record<string, unknown>>;
  };

  assert.equal(normalized.frame.name, "Manage loans · Variation");
  assert.equal(normalized.frame.backgroundColor, "#FAFAFA");
  assert.equal(normalized.elements.length, 6);

  assert.equal(normalized.elements[0].type, "RECTANGLE");
  assert.equal(normalized.elements[0].name, "Rectangle 1");
  assert.equal(normalized.elements[0].color, "#FFFFFF");
  assert.equal("fill" in normalized.elements[0], false);

  assert.equal(normalized.elements[1].type, "TEXT");
  assert.equal(normalized.elements[1].name, "Text · Manage loans");
  assert.equal(normalized.elements[1].text, "Manage loans");
  assert.equal(normalized.elements[1].color, "#202124");
  assert.equal(normalized.elements[1].fontSize, 96, "Oversized model typography should be clamped to the native executor schema.");

  assert.equal(normalized.elements[2].type, "FRAME");
  assert.equal(normalized.elements[2].name, "Pay EMI");
  assert.equal(normalized.elements[2].cornerRadius, 12);

  assert.equal(normalized.elements[4].type, "TEXT");
  assert.equal(normalized.elements[4].text, "Next EMI due 25 Oct");
  assert.equal(normalized.elements[4].name, "Text · Next EMI due 25 Oct");
});
