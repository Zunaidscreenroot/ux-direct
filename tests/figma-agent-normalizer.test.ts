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

test("preserves model-authored nested FRAME containers and relative child coordinates", () => {
  const input = {
    summary: "A structured Manage Loans variation with native section frames.",
    frame: { name: "Manage Loans — variation", width: 360, height: 800, backgroundColor: "#101010" },
    elements: [
      { type: "FRAME", name: "Header & navigation", x: 0, y: 12, width: 360, height: 64, noFill: true,
        children: [{ type: "TEXT", name: "Screen title", x: 18, y: 12, width: 260, height: 32, text: "Manage Loans", fontSize: 24, color: "#FFFFFF" }] },
      { type: "FRAME", name: "Loan status tabs", x: 16, y: 88, width: 328, height: 58, noFill: true,
        children: [{ type: "TEXT", name: "Active tab", x: 0, y: 8, width: 96, height: 30, text: "Active", fontSize: 15, color: "#FFFFFF" }] },
      { type: "FRAME", name: "Active loan summary", x: 16, y: 160, width: 328, height: 200, color: "#292929", cornerRadius: 8,
        children: [{ type: "TEXT", name: "Loan amount", x: 16, y: 24, width: 280, height: 26, text: "₹40,000", fontSize: 24, color: "#FFFFFF" }] },
      { type: "FRAME", name: "Loan-wise breakdown", x: 16, y: 372, width: 328, height: 130, color: "#202020",
        children: [{ type: "TEXT", name: "Outstanding", x: 16, y: 16, width: 280, height: 24, text: "Outstanding · ₹20,000", fontSize: 15, color: "#15C8F2" }] },
      { type: "FRAME", name: "Actions & support", x: 16, y: 530, width: 328, height: 110, noFill: true,
        children: [{ type: "FRAME", name: "View loan details", x: 0, y: 0, width: 328, height: 48, color: "#00AEEF", cornerRadius: 2,
          children: [{ type: "TEXT", name: "CTA label", x: 20, y: 12, width: 250, height: 24, text: "View loan details", fontSize: 15, color: "#FFFFFF" }] }] },
    ],
  };
  const normalized = normalizePlan(input, { pageName: "Loans", nodes: [] }) as {
    elements: Array<Record<string, unknown>>;
  };
  assert.equal(normalized.elements.length, 5);
  assert.ok(normalized.elements.every((node) => node.type === "FRAME"));
  assert.equal(normalized.elements[0].name, "Header & navigation");
  const title = (normalized.elements[0].children as Array<Record<string, unknown>>)[0];
  assert.equal(title.text, "Manage Loans");
  assert.equal(title.x, 18, "Nested node coordinates must remain relative to their direct parent.");
  const actions = normalized.elements[4].children as Array<Record<string, unknown>>;
  const cta = actions[0];
  assert.equal(cta.type, "FRAME");
  assert.equal((cta.children as Array<Record<string, unknown>>)[0].text, "View loan details");
});

test("flat selected card output uses component groups rather than whole-screen sections", () => {
  const elements = [
    ["Consumption Loan", 10], ["Current status", 25], ["Loan reference", 42],
    ["Loan amount", 72], ["₹40,000", 88], ["Outstanding", 108],
    ["Progress ring", 142], ["60% Paid", 154], ["View details icon", 174],
    ["Loan-wise breakdown", 198], ["Paid amount", 216], ["Due date", 234],
    ["View loan details", 252], ["Make a payment", 263], ["Support", 273],
  ].map(([text, y], index) => ({
    type: "TEXT", name: "Card content " + index, text: String(text),
    x: 16, y: Number(y), width: 280, height: 18, fontSize: 14, color: "#FFFFFF",
  }));
  const normalized = normalizePlan({
    summary: "A more legible loan card variation preserving the source information.",
    frame: { name: "Consumption loan card — variation", width: 320, height: 283, backgroundColor: "#111111" },
    elements,
  }, {
    pageName: "Loans",
    nodes: [{ id: "node-card", type: "FRAME", name: "Consumption loan card", width: 320, height: 283, x: 0, y: 0 }],
  }) as { elements: Array<Record<string, unknown>> };
  assert.equal(normalized.elements.length, 5);
  assert.deepEqual(normalized.elements.map((node) => node.name), [
    "Card header & status",
    "Primary loan information",
    "Progress & key indicators",
    "Breakdown & supporting details",
    "Actions & secondary metadata",
  ]);
  assert.ok(normalized.elements.every((node) => node.type === "FRAME"));
  const preservedTexts: string[] = [];
  for (const section of normalized.elements) {
    const children = Array.isArray(section.children) ? section.children as Array<Record<string, unknown>> : [];
    for (const child of children) if (typeof child.text === "string") preservedTexts.push(child.text);
  }
  assert.ok(preservedTexts.includes("₹40,000"), "Card values must remain in the normalized plan.");
  assert.ok(preservedTexts.includes("Due date"), "Secondary card details must not be discarded.");
  assert.ok(preservedTexts.includes("Make a payment"), "Actions must remain in the component variation.");
});


test("preserves native ellipse arcData and reunites a source compound loan card", () => {
  const input = {
    summary: "A source-faithful native Figma loan screen.",
    frame: { name: "Manage Loans", width: 360, height: 800, backgroundColor: "#101010" },
    elements: [
      { type: "FRAME", name: "Header", x: 0, y: 0, width: 360, height: 64, children: [
        { type: "TEXT", name: "Title", x: 20, y: 18, width: 200, height: 24, text: "Manage Loans" }
      ] },
      { type: "FRAME", name: "Tabs", x: 0, y: 64, width: 360, height: 44, children: [
        { type: "TEXT", name: "Active", x: 20, y: 12, width: 80, height: 20, text: "Active" }
      ] },
      { type: "FRAME", name: "Loan summary card", x: 20, y: 124, width: 320, height: 150, children: [
        { type: "ELLIPSE", name: "Progress arc", x: 16, y: 72, width: 56, height: 56, color: "#A78BFA",
          arcData: { startingAngle: -1.5707963267948966, endingAngle: 2.199114857512855, innerRadius: 0.72 } },
        { type: "TEXT", name: "Progress label", x: 24, y: 90, width: 40, height: 20, text: "60% Paid" }
      ] },
      { type: "FRAME", name: "Loan-wise breakup", x: 20, y: 274, width: 320, height: 139, children: [
        { type: "TEXT", name: "Due date", x: 16, y: 16, width: 180, height: 20, text: "Due 5 Oct" }
      ] },
      { type: "FRAME", name: "Status badge", x: 267, y: 124, width: 73, height: 18, children: [
        { type: "TEXT", name: "Current text", x: 10, y: 2, width: 53, height: 14, text: "Current" }
      ] }
    ]
  };
  const source = {
    pageName: "Loans",
    nodes: [{
      type: "FRAME", name: "Manage loans — multiple loans", width: 360, height: 800,
      children: [{
        type: "FRAME", name: "Consumption loan", x: 20, y: 124, width: 320, height: 289,
        children: [
          { type: "FRAME", name: "summary", width: 320, height: 150, children: [] },
          { type: "FRAME", name: "breakup", y: 150, width: 320, height: 139, children: [] },
          { type: "FRAME", name: "status", x: 247, width: 73, height: 18, children: [] }
        ]
      }]
    }]
  };
  const normalized = normalizePlan(input, source) as { elements: Array<Record<string, unknown>> };
  const card = normalized.elements.find((node) => node.name === "Consumption loan — variation");
  assert.ok(card, "The source card boundary should be preserved.");
  const children = card?.children as Array<Record<string, unknown>>;
  const ring = children.flatMap((node) => Array.isArray(node.children) ? node.children as Array<Record<string, unknown>> : [])
    .find((node) => node.name === "Progress arc");
  assert.deepEqual(ring?.arcData, { startingAngle: -1.5707963267948966, endingAngle: 2.199114857512855, innerRadius: 0.72 });
  assert.deepEqual(children.map((node) => node.name), ["Loan summary card", "Loan-wise breakup", "Status badge"]);
  assert.equal(children[1].y, 150);
  assert.equal(children[2].x, 247);
});
