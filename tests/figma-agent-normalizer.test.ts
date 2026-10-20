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
  assert.equal(normalized.elements.length, 5, "Flat provider output should be wrapped into five named native frame sections.");
  assert.ok(normalized.elements.every((element) => element.type === "FRAME"), "The top-level tree should contain frames, not loose shapes/text.");

  const allNodes: Array<Record<string, unknown>> = [];
  const collect = (nodes: Array<Record<string, unknown>>) => {
    for (const node of nodes) {
      allNodes.push(node);
      if (Array.isArray(node.children)) collect(node.children as Array<Record<string, unknown>>);
    }
  };
  collect(normalized.elements);
  assert.ok(allNodes.filter((node) => node.type === "FRAME" && Array.isArray(node.children) && node.children.length > 0).length >= 4,
    "Multiple meaningful frame groups should contain native child layers.");

  const heading = allNodes.find((node) => node.type === "TEXT" && node.text === "Manage loans");
  assert.ok(heading, "Text content should survive the hierarchical normalization.");
  assert.equal(heading?.color, "#202124");
  assert.equal(heading?.fontSize, 96, "Oversized model typography should be clamped to the native executor schema.");
  assert.equal("fill" in (heading || {}), false);

  const button = allNodes.find((node) => node.type === "FRAME" && node.name === "Pay EMI");
  assert.ok(button, "Button aliases should normalize to styled native frames.");
  assert.equal(button?.cornerRadius, 12);

  const due = allNodes.find((node) => node.type === "TEXT" && node.text === "Next EMI due 25 Oct");
  assert.ok(due, "Nested body copy should be preserved.");
  assert.equal(due?.name, "Text · Next EMI due 25 Oct");
});
