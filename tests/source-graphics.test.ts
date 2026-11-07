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

test("graphics next to repeated texts stay on their own card", () => {
  const card = (i: number, y: number): N => ({ id: "9:" + i, name: "Card " + i, type: "FRAME", x: 16, y, width: 328, height: 120, fillColors: ["#FFFFFF"], cornerRadius: 12, children: [
    { id: "9:" + i + "1", name: "Title", type: "TEXT", x: 16, y: 16, width: 160, height: 20, text: "Personal Loan" },
    { id: "9:" + i + "2", name: "logo", type: "GROUP", x: 260, y: 16, width: 48, height: 20, children: [{ id: "9:" + i + "3", name: "Vector", type: "VECTOR", x: 0, y: 0, width: 48, height: 20 }] },
    { id: "9:" + i + "4", name: "Amount", type: "TEXT", x: 16, y: 60, width: 160, height: 20, text: "₹" + i + "0,000" },
  ] });
  const src = { nodes: [{ id: "9:0", name: "Loans", type: "FRAME", x: 0, y: 0, width: 360, height: 400, fillColors: ["#F6F7F9"], children: [card(1, 20), card(2, 160)] }], components: [] };
  const spec = { summary: "x", frame: { name: "Loans" }, sections: [1, 2].map((i) => ({ name: "Card " + i, surface: "card", blocks: [
    { type: "heading", title: "Personal Loan" }, { type: "stat", value: "₹" + i + "0,000" },
  ] })) };
  const expansion = expandBlockSpec(spec, src, { sourceCanvas: src, allowClones: true });
  const sections = expansion.plan!.elements.filter((n) => /Card/.test(n.name));
  for (const [index, section] of sections.entries()) {
    const clones: string[] = [];
    walk([section], (n) => { if (n.type === "CLONE") clones.push(String(n.sourceNodeId)); });
    assert.deepEqual(clones, ["9:" + (index + 1) + "2"], "card " + (index + 1) + " gets its own logo");
  }
});

test("a chevron or logo beside a stat column goes into the row, not inside the column (finding 38)", () => {
  const src = { nodes: [{ id: "5:1", name: "Loans", type: "FRAME", x: 0, y: 0, width: 360, height: 300, fillColors: ["#FFFFFF"], children: [
    { id: "5:2", name: "Loan card", type: "FRAME", x: 16, y: 16, width: 328, height: 200, fillColors: ["#FFFFFF"], cornerRadius: 12, children: [
      { id: "5:3", name: "Title", type: "TEXT", x: 16, y: 16, width: 160, height: 20, text: "Personal Loan" },
      { id: "5:4", name: "Loan ID", type: "TEXT", x: 16, y: 40, width: 160, height: 16, text: "DMI1234567890" },
      { id: "5:5", name: "Lender logo", type: "VECTOR", x: 250, y: 0, width: 56, height: 14 },
      { id: "5:6", name: "Loan Amount", type: "TEXT", x: 16, y: 100, width: 100, height: 15, text: "Loan Amount" },
      { id: "5:7", name: "Amount", type: "TEXT", x: 16, y: 119, width: 100, height: 17, text: "₹12,000" },
      { id: "5:8", name: "Outstanding", type: "TEXT", x: 170, y: 100, width: 100, height: 15, text: "Outstanding" },
      { id: "5:9", name: "Value", type: "TEXT", x: 170, y: 119, width: 100, height: 17, text: "₹1,07,649" },
      { id: "5:10", name: "Chevron", type: "VECTOR", x: 300, y: 84, width: 12, height: 12 },
    ] },
  ] }], components: [] };
  const s = { summary: "x", frame: { name: "Loans" }, sections: [
    { name: "Loan", surface: "card", blocks: [
      { type: "heading", title: "Personal Loan", subtitle: "DMI1234567890" },
      { type: "stat_row", items: [{ label: "Loan Amount", value: "₹12,000" }, { label: "Outstanding", value: "₹1,07,649" }] },
    ] },
  ], learningCandidate: null };
  const expansion = expandBlockSpec(s, src, { sourceCanvas: src });
  assert.ok(expansion.plan, expansion.errors.join("; "));
  const parents = new Map<string, N | null>();
  walk(expansion.plan!.elements as N[], (n, _d, p) => { if (n.type === "CLONE") parents.set(String(n.name), p); });
  const chevronParent = parents.get("Chevron");
  assert.ok(chevronParent, "chevron cloned");
  assert.equal(chevronParent!.layoutMode, "HORIZONTAL", "chevron sits in the horizontal row, not in a vertical stat column");
  const logoParent = parents.get("Lender logo");
  assert.ok(logoParent, "logo cloned");
  assert.equal(logoParent!.layoutMode, "HORIZONTAL", "logo sits beside the heading, not between title and subtitle");
});

test("a hug badge grows for a cloned icon instead of wrapping its label (finding 37)", () => {
  const plan = { summary: "x", frame: { name: "F", width: 360, height: 200, layoutMode: "VERTICAL" }, elements: [
    { type: "FRAME", name: "Status badge · Current", x: 0, y: 0, width: 74, height: 24, layoutMode: "HORIZONTAL", itemSpacing: 8,
      paddingLeft: 10, paddingRight: 10, paddingTop: 4, paddingBottom: 4, layoutSizingHorizontal: "HUG", primaryAxisSizingMode: "AUTO", children: [
        { type: "TEXT", name: "Badge label", x: 10, y: 4, width: 46, height: 16, text: "Current", textAutoResize: "WIDTH_AND_HEIGHT" },
        { type: "CLONE", name: "Functional Icons", sourceNodeId: "1:9", x: 64, y: 7, width: 10, height: 10, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED" },
      ] },
  ] };
  const out = normalizePlan(plan, { nodes: [] }, { trustedSections: true }) as { elements: N[] };
  let badge: N | undefined, labelNode: N | undefined;
  walk(out.elements, (n) => { if (String(n.name).startsWith("Status badge")) badge = n; if (n.name === "Badge label") labelNode = n; });
  assert.equal(labelNode?.width, 46, "label keeps its single-line width");
  assert.notEqual(labelNode?.textAutoResize, "HEIGHT", "label is not turned into a wrapping text");
  assert.ok(Number(badge?.width) >= 46 + 10 + 8 + 20, "badge grows to fit");
});

test("a donut left of a stat column joins the stats row before both stats (finding 48)", () => {
  const src = { nodes: [{ id: "6:1", name: "Loans", type: "FRAME", x: 0, y: 0, width: 360, height: 300, fillColors: ["#FFFFFF"], children: [
    { id: "6:2", name: "Loan card", type: "FRAME", x: 16, y: 16, width: 328, height: 200, fillColors: ["#FFFFFF"], cornerRadius: 12, children: [
      { id: "6:3", name: "Loan Graph", type: "INSTANCE", x: 16, y: 90, width: 59, height: 59, children: [
        { id: "6:4", name: "Track", type: "ELLIPSE", x: 0, y: 0, width: 59, height: 59 },
        { id: "6:5", name: "Arc", type: "ELLIPSE", x: 0, y: 0, width: 59, height: 59 }] },
      { id: "6:6", name: "Loan Amount", type: "TEXT", x: 90, y: 100, width: 90, height: 15, text: "Loan Amount" },
      { id: "6:7", name: "Amount", type: "TEXT", x: 90, y: 119, width: 90, height: 17, text: "₹12,000" },
      { id: "6:8", name: "Outstanding", type: "TEXT", x: 200, y: 100, width: 90, height: 15, text: "Outstanding" },
      { id: "6:9", name: "Value", type: "TEXT", x: 200, y: 119, width: 90, height: 17, text: "₹1,07,649" },
    ] },
  ] }], components: [] };
  const s = { summary: "x", frame: { name: "Loans" }, sections: [
    { name: "Loan", surface: "card", blocks: [
      { type: "stat_row", items: [{ label: "Loan Amount", value: "₹12,000" }, { label: "Outstanding", value: "₹1,07,649" }] },
    ] },
  ], learningCandidate: null };
  const expansion = expandBlockSpec(s, src, { sourceCanvas: src });
  assert.ok(expansion.plan, expansion.errors.join("; "));
  let row: N | undefined;
  walk(expansion.plan!.elements as N[], (n, _d, p) => { if (n.type === "CLONE" && n.name === "Loan Graph") row = p ?? undefined; });
  assert.ok(row, "donut cloned");
  assert.equal(row!.layoutMode, "HORIZONTAL");
  const names = (row!.children ?? []).map((c) => String(c.name));
  assert.equal(names[0], "Loan Graph", "donut comes first: " + names.join(", "));
  assert.ok(names.some((n) => n.includes("Loan Amount")) && names.some((n) => n.includes("Outstanding")), "both stats stay in the same row: " + names.join(", "));
});

test("a button label repeated across source cards is restored on the card that lost it (finding 53)", () => {
  const card = (i: number, withButton: boolean) => ({ name: "Loan " + i, surface: "card", blocks: [
    { type: "text", text: "Loan ID SLC00" + i },
    { type: "text", text: "₹" + i + "0,000 outstanding" },
    { type: "text", text: "View details " + i },
    ...(withButton ? [{ type: "button", label: "Pay now", variant: "primary" }] : []),
  ] });
  const dropped = { summary: "Loan cards.", frame: { name: "Manage Loans" }, sections: [
    { name: "Header", blocks: [{ type: "app_bar", title: "Manage Loans" }] }, card(1, true), card(2, true), card(3, false),
  ], learningCandidate: null };
  const expansion = expandBlockSpec(dropped, canvas, { sourceCanvas: canvas });
  assert.ok(expansion.plan, expansion.errors.join("; "));
  const plan = normalizePlan(expansion.plan, canvas) as { elements: N[] };
  const owners: string[] = [];
  walk(plan.elements, (node, _d, parent) => { if (node.type === "TEXT" && node.text === "Pay now") owners.push(String(parent?.name)); });
  assert.equal(owners.length, 3, "one Pay now per source card");
  let card3HasButton = false;
  walk(plan.elements, (node) => {
    if (node.type !== "FRAME") return;
    const texts: string[] = [];
    walk(node.children ?? [], (n) => { if (n.type === "TEXT") texts.push(String(n.text)); });
    if (texts.includes("Loan ID SLC003") && texts.includes("Pay now") && !texts.includes("Loan ID SLC002")) card3HasButton = true;
  });
  assert.ok(card3HasButton, "the restored button sits in card 3");
});

test("reordered cards keep their own donut when the nearest text repeats (finding 56)", () => {
  const card = (i: number, y: number): N => ({ id: "c" + i, name: "Loan card", type: "FRAME", x: 16, y, width: 328, height: 160, fillColors: ["#FFFFFF"], cornerRadius: 12, children: [
    { id: "k" + i, name: "Kind", type: "TEXT", x: 16, y: 16, width: 120, height: 20, text: "Personal Loan" },
    { id: "d" + i, name: "Donut", type: "GROUP", x: 140, y: 12, width: 60, height: 60, children: [
      { id: "e" + i, name: "Track", type: "ELLIPSE", x: 0, y: 0, width: 60, height: 60 },
      { id: "p" + i, name: "Pct", type: "TEXT", x: 16, y: 22, width: 30, height: 16, text: (i * 20) + "%" }] },
    { id: "id" + i, name: "ID", type: "TEXT", x: 16, y: 100, width: 200, height: 20, text: "Loan ID DMI00" + i },
  ] });
  const src = { nodes: [{ id: "root", name: "Loans", type: "FRAME", x: 0, y: 0, width: 360, height: 600, fillColors: ["#F6F7F9"], children: [card(1, 20), card(2, 200), card(3, 380)] }], components: [] };
  const section = (i: number) => ({ name: "Loan " + i, surface: "card", blocks: [{ type: "text", text: "Personal Loan" }, { type: "text", text: "Loan ID DMI00" + i }] });
  const exp = expandBlockSpec({ summary: "Urgent first.", sections: [section(3), section(2), section(1)], learningCandidate: null }, src, { sourceCanvas: src });
  assert.ok(exp.plan, exp.errors.join("; "));
  walk(exp.plan.elements as N[], (node) => {
    if (node.type !== "FRAME") return;
    const ids: string[] = []; const clones: string[] = [];
    walk(node.children ?? [], (n) => { if (n.type === "TEXT" && String(n.text).startsWith("Loan ID")) ids.push(String(n.text)); if (n.type === "CLONE") clones.push(String(n.sourceNodeId)); });
    if (ids.length === 1 && clones.length) assert.ok(clones.every((c) => c.endsWith(ids[0].slice(-1))), ids[0] + " got " + clones.join(","));
  });
});

test("a filled source CTA demoted to an outline button is filled again (finding 62)", () => {
  const spec2 = { summary: "Loan cards.", sections: [1, 2, 3].map((i) => ({ name: "Loan " + i, surface: "card", blocks: [
    { type: "text", text: "Loan ID SLC00" + i }, { type: "text", text: "₹" + i + "0,000 outstanding" },
    { type: "button", label: "Pay now", variant: "secondary" }] })), learningCandidate: null };
  const exp = expandBlockSpec(spec2, canvas, { sourceCanvas: canvas });
  assert.ok(exp.plan, exp.errors.join("; "));
  const buttons: N[] = [];
  walk(exp.plan.elements as N[], (node, _d, parent) => { if (node.type === "TEXT" && node.text === "Pay now" && parent) buttons.push(parent); });
  assert.equal(buttons.length, 3);
  for (const b of buttons) { assert.ok(!/secondary/i.test(String(b.name)), String(b.name)); assert.equal(b.strokeColor, undefined); }
});

test("a filled source CTA turned into a chip becomes a filled button again (finding 62)", () => {
  const spec3 = { summary: "Loan cards.", sections: [1, 2, 3].map((i) => ({ name: "Loan " + i, surface: "card", blocks: [
    { type: "text", text: "Loan ID SLC00" + i }, { type: "chips", items: ["Pay now"] }] })), learningCandidate: null };
  const exp = expandBlockSpec(spec3, canvas, { sourceCanvas: canvas });
  assert.ok(exp.plan, exp.errors.join("; "));
  const parents: N[] = [];
  walk(exp.plan.elements as N[], (node, _d, parent) => { if (node.type === "TEXT" && node.text === "Pay now" && parent) parents.push(parent); });
  assert.ok(parents.length >= 3);
  for (const p of parents) { assert.match(String(p.name), /Pay now button/); assert.ok(Number(p.height) >= 44); }
});

test("a wireframe that merged two loan cards into one section still gets both Pay now buttons (finding 53)", () => {
  const merged = { summary: "Wireframe.", frame: { name: "Manage Loans" }, sections: [
    { name: "Header", blocks: [{ type: "app_bar", title: "Manage Loans" }] },
    { name: "Loans", surface: "card", blocks: [
      { type: "text", text: "Loan ID SLC001" }, { type: "text", text: "₹10,000 outstanding" }, { type: "text", text: "View details 1" },
      { type: "button", label: "Pay now", variant: "primary" },
      { type: "text", text: "Loan ID SLC002" }, { type: "text", text: "₹20,000 outstanding" }, { type: "text", text: "View details 2" },
      { type: "text", text: "Loan ID SLC003" }, { type: "text", text: "₹30,000 outstanding" }, { type: "text", text: "View details 3" },
      { type: "button", label: "Pay now", variant: "primary" },
    ] },
  ], learningCandidate: null };
  const expansion = expandBlockSpec(merged, canvas, { sourceCanvas: canvas });
  assert.ok(expansion.plan, expansion.errors.join("; "));
  const order: string[] = [];
  walk(expansion.plan!.elements as N[], (n) => { if (n.type === "TEXT" && /^(Pay now|Loan ID)/.test(String(n.text))) order.push(String(n.text)); });
  assert.equal(order.filter((t) => t === "Pay now").length, 3, order.join(" | "));
  assert.deepEqual(order, ["Loan ID SLC001", "Pay now", "Loan ID SLC002", "Pay now", "Loan ID SLC003", "Pay now"], "restored copy sits after loan 2's own rows");
});

test("buttons keep the source CTA colour on a dark screen instead of the pale default", () => {
  const dark = { nodes: [{ ...canvas.nodes[0], fillColors: ["#101820"] }], components: [] };
  const s = { summary: "x", sections: [{ name: "Loan", surface: "card", blocks: [{ type: "text", text: "Loan ID SLC001" }, { type: "button", label: "Pay now", variant: "primary" }] }], learningCandidate: null };
  const exp = expandBlockSpec(s, dark, { sourceCanvas: dark });
  assert.ok(exp.plan, exp.errors.join("; "));
  const fills: string[] = [];
  walk(exp.plan!.elements as N[], (n) => { if (n.type === "FRAME" && n.children?.some((c) => c.text === "Pay now")) fills.push(String(n.color)); });
  assert.ok(fills.length && fills.every((f) => f.toUpperCase().startsWith("#0") ), "source blue (#0B5FFF-ish), got " + fills.join(","));
});
