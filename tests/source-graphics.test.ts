import { test } from "node:test";
import assert from "node:assert/strict";
import { expandBlockSpec } from "../src/figma-agent/block-spec";
import { normalizePlan } from "../src/figma-agent/normalize-plan";

type N = Record<string, unknown> & { children?: N[] };
function walk(nodes: N[], visit: (node: N, depth: number, parent: N | null) => void, depth = 0, parent: N | null = null) {
  for (const node of nodes) { visit(node, depth, parent); if (node.children) walk(node.children, visit, depth + 1, node); }
}

// "Manage Loans" (Test #1): three loan cards with a brand logo, a donut, a chevron row and a filled "Pay now" button.
function loanCard(i: number, y: number): N {
  const id = (n: number) => "2:" + (i * 100 + n);
  return { id: id(0), name: "Loan card " + i, type: "FRAME", x: 16, y, width: 328, height: 200, fillColors: ["#FFFFFF"], cornerRadius: 12, children: [
    { id: id(1), name: "slice logo", type: "GROUP", x: 16, y: 16, width: 48, height: 20, children: [
      { id: id(2), name: "Vector", type: "VECTOR", x: 0, y: 0, width: 48, height: 20 },
    ] },
    { id: id(3), name: "Loan ID", type: "TEXT", x: 72, y: 16, width: 160, height: 20, text: "Loan ID SLC00" + i },
    { id: id(4), name: "Donut", type: "GROUP", x: 240, y: 40, width: 72, height: 72, children: [
      { id: id(5), name: "Track", type: "ELLIPSE", x: 0, y: 0, width: 72, height: 72 },
      { id: id(6), name: "Arc", type: "ELLIPSE", x: 0, y: 0, width: 72, height: 72 },
      { id: id(7), name: "Pct", type: "TEXT", x: 20, y: 28, width: 32, height: 16, text: (i * 20) + "%" },
    ] },
    { id: id(8), name: "Amount", type: "TEXT", x: 16, y: 60, width: 200, height: 24, text: "₹" + i + "0,000 outstanding" },
    { id: id(9), name: "Chevron", type: "VECTOR", x: 300, y: 130, width: 12, height: 12 },
    { id: id(10), name: "View details", type: "TEXT", x: 16, y: 128, width: 200, height: 18, text: "View details " + i },
    { id: id(11), name: "Pay button", type: "FRAME", x: 16, y: 156, width: 120, height: 36, fillColors: ["#0B5FFF"], cornerRadius: 8, children: [
      { id: id(12), name: "Label", type: "TEXT", x: 30, y: 8, width: 60, height: 20, text: "Pay now" },
    ] },
  ] };
}
const canvas = { nodes: [{ id: "2:1", name: "Manage Loans", type: "FRAME", x: 0, y: 0, width: 360, height: 760, fillColors: ["#F6F7F9"], children: [
  { id: "2:2", name: "Title", type: "TEXT", x: 16, y: 16, width: 200, height: 28, text: "Manage Loans" },
  loanCard(1, 60), loanCard(2, 280), loanCard(3, 500),
] }], components: [] };

const spec = {
  summary: "Clearer loan cards with status, amount and actions grouped.",
  frame: { name: "Manage Loans" },
  sections: [
    { name: "Header", blocks: [{ type: "heading", title: "Manage Loans" }] },
    ...[1, 2, 3].map((i) => ({ name: "Loan " + i, surface: "card", title: "Loan ID SLC00" + i, blocks: [
      ...(i === 1 ? [{ type: "progress_ring", percent: 20, label: "₹10,000 outstanding" }] : [{ type: "text", text: "₹" + i + "0,000 outstanding" }]),
      { type: "text", text: "View details " + i },
      { type: "button", label: "Pay now", variant: "text" },
    ] })),
  ],
  learningCandidate: null,
};

test("block-rendered variations keep source logos, charts and chevrons as clones of the real layers", () => {
  const expansion = expandBlockSpec(spec, canvas, { sourceCanvas: canvas });
  assert.ok(expansion.plan, expansion.errors.join("; "));
  const clones: N[] = [];
  let generatedRings = 0;
  walk(expansion.plan!.elements as N[], (node) => {
    if (node.type === "CLONE") clones.push(node);
    if (node.name === "Progress ring") generatedRings += 1;
  });
  const ids = new Set(clones.map((c) => c.sourceNodeId));
  for (const i of [1, 2, 3]) {
    assert.ok(ids.has("2:" + (i * 100 + 1)), "logo of card " + i + " kept");
    assert.ok(ids.has("2:" + (i * 100 + 4)), "donut of card " + i + " kept");
    assert.ok(ids.has("2:" + (i * 100 + 9)), "chevron of card " + i + " kept");
  }
  assert.equal(generatedRings, 0, "the real source donut replaces the generated ring");
  // Every clone lives in the card of its own loan.
  walk(expansion.plan!.elements as N[], (node) => {
    if (!/^Loan \d$/.test(String(node.name))) return;
    const n = Number(String(node.name).slice(-1));
    walk(node.children || [], (child) => {
      if (child.type === "CLONE") assert.equal(Math.floor(Number(String(child.sourceNodeId).split(":")[1]) / 100), n, "clone in the matching card");
    });
  });
  const normalized = normalizePlan(expansion.plan, canvas, { trustedSections: true }) as { elements: N[] };
  let normalizedClones = 0;
  walk(normalized.elements, (node, depth) => {
    if (node.type === "CLONE") { normalizedClones += 1; assert.ok(typeof node.sourceNodeId === "string"); assert.ok(depth <= 4); }
  });
  assert.equal(normalizedClones, clones.length, "normalizePlan keeps every clone");
});

test("a source button the model turned into a text link becomes a filled button again", () => {
  const expansion = expandBlockSpec(spec, canvas, { sourceCanvas: canvas });
  const buttons: N[] = [];
  walk(expansion.plan!.elements as N[], (node) => {
    if (node.type === "FRAME" && node.children?.length === 1 && node.children[0].text === "Pay now") buttons.push(node);
  });
  assert.equal(buttons.length, 3);
  for (const button of buttons) {
    assert.equal(typeof button.color, "string", "button has a fill");
    assert.notEqual(button.noFill, true);
  }
});

test("plans with clones pass the pre-write quality audit", async () => {
  const { auditDesignPlanQuality } = await import("../src/figma-agent/design-plan-quality");
  const expansion = expandBlockSpec(spec, canvas, { sourceCanvas: canvas });
  const normalized = normalizePlan(expansion.plan, canvas, { trustedSections: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const quality = auditDesignPlanQuality(normalized as any, canvas, "Improve hierarchy and visual clarity");
  assert.ok(quality.passed, JSON.stringify(quality.findings));
});

test("the source back icon replaces the drawn arrow, and layers bind to the file's own styles", () => {
  const src = { nodes: [{ id: "9:1", name: "Screen", type: "FRAME", x: 0, y: 0, width: 360, height: 640, fillColors: ["#F6F7F9"], children: [
    { id: "9:2", name: "Top bar", type: "FRAME", x: 0, y: 0, width: 360, height: 56, children: [
      { id: "9:3", name: "arrow-left", type: "VECTOR", x: 16, y: 18, width: 20, height: 20 },
      { id: "9:4", name: "Title", type: "TEXT", x: 48, y: 16, width: 200, height: 24, text: "My Loans" },
    ] },
    { id: "9:5", name: "Body", type: "TEXT", x: 16, y: 80, width: 300, height: 20, text: "Two active loans" },
  ] }], components: [], styles: {
    text: [{ id: "S:body", name: "Body/Regular", fontSize: 14, fontFamily: "Inter", fontStyle: "Regular" }],
    paint: [{ id: "S:bg", name: "Surface/Background", color: "#F6F7F9" }],
  } };
  const s = { summary: "Loans overview with a clear header.", sections: [
    { name: "Header", blocks: [{ type: "app_bar", title: "My Loans", back: true }] },
    { name: "Summary", blocks: [{ type: "text", text: "Two active loans" }] },
    { name: "More", blocks: [{ type: "text", text: "Pull to refresh" }] },
  ] };
  const expansion = expandBlockSpec(s, src, { sourceCanvas: src });
  const flat: N[] = [];
  walk(expansion.plan!.elements as N[], (node) => flat.push(node));
  assert.ok(flat.some((n) => n.type === "CLONE" && n.sourceNodeId === "9:3"), "back icon cloned");
  assert.ok(!flat.some((n) => n.type === "TEXT" && n.text === "←"), "drawn arrow removed");
  const body = flat.find((n) => n.type === "TEXT" && n.text === "Two active loans")!;
  assert.equal(body.textStyleId, "S:body");
});

test("geometry repair never squashes copied graphics in a crowded row", () => {
  const plan = { summary: "x", frame: { name: "F", width: 360, height: 400, layoutMode: "VERTICAL" }, elements: [
    { type: "FRAME", name: "Header row", x: 0, y: 0, width: 200, height: 40, layoutMode: "HORIZONTAL", itemSpacing: 8,
      paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, children: [
        { type: "TEXT", name: "Title", x: 0, y: 0, width: 160, height: 20, text: "Personal Loan" },
        { type: "CLONE", name: "Loan Graph", sourceNodeId: "1:2", x: 0, y: 0, width: 59, height: 59, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED" },
      ] },
  ] };
  const out = normalizePlan(plan, { nodes: [] }, { trustedSections: true }) as { elements: N[] };
  let clone: N | undefined, title: N | undefined;
  walk(out.elements, (n) => { if (n.type === "CLONE") clone = n; if (n.name === "Title") title = n; });
  assert.equal(clone?.width, 59, "clone keeps its source width");
  assert.ok(Number(title?.width) < 160, "the text gives way instead");
});
