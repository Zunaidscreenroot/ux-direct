import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BLOCK_NODE_BUDGET, BLOCK_SPEC_EXAMPLE, contrast, ensureContrast, expandBlockSpec, isBlockSpec, resolveTheme,
} from "../src/figma-agent/block-spec";
import { normalizePlan } from "../src/figma-agent/normalize-plan";
import { auditDesignPlanQuality } from "../src/figma-agent/design-plan-quality";

type N = Record<string, unknown> & { children?: N[] };

const lightCanvas = { nodes: [{ name: "Manage loans", type: "FRAME", width: 360, height: 800, fillColors: ["#F6F7F9"], children: [] }], components: [] };
const darkCanvas = { nodes: [{ name: "Manage loans", type: "FRAME", width: 360, height: 800, fillColors: ["#0E0F12"], children: [] }], components: [] };

const kycSpec = {
  summary: "Video KYC step with status, details and a single primary action.",
  frame: { name: "VKYC" },
  theme: { background: "#FFFFFF", primary: "#E3007E" },
  sections: [
    { name: "Header", blocks: [{ type: "app_bar", title: "Video KYC", subtitle: "Step 2 of 3", action: "Help" }, { type: "tabs", items: ["Details", "Video", "Done"], active: 1 }] },
    { name: "Status", surface: "card", title: "Complete your Video KYC", badge: { text: "Pending", tone: "warning" }, blocks: [
      { type: "progress_bar", percent: 66, label: "Progress", caption: "Takes about 3 minutes" },
      { type: "list", items: [
        { label: "Agent availability", value: "9 AM – 9 PM", status: "Live", statusTone: "success" },
        { label: "Documents", caption: "Keep your PAN card ready", chevron: true, icon: "ID" },
      ] },
      { type: "banner", title: "Good lighting helps", body: "Sit in a well-lit room.", tone: "info", action: "See tips" },
    ] },
    { name: "Details", blocks: [
      { type: "stat_row", items: [{ label: "Loan amount", value: "₹2,00,000" }, { label: "Tenure", value: "24 months" }, { label: "EMI", value: "₹9,450" }] },
      { type: "input", label: "PAN number", placeholder: "ABCDE1234F", helper: "As printed on your card" },
      { type: "checkbox", label: "I agree to share my Aadhaar details for verification", checked: true },
    ] },
    { name: "Actions", blocks: [{ type: "buttons", items: [{ label: "Start Video KYC" }, { label: "Schedule for later", variant: "secondary" }] }] },
  ],
  learningCandidate: null,
};

function walk(nodes: N[], visit: (node: N, depth: number) => void, depth = 0) {
  for (const node of nodes) {
    visit(node, depth);
    if (node.children) walk(node.children, visit, depth + 1);
  }
}

function texts(nodes: N[]): string[] {
  const out: string[] = [];
  walk(nodes, (node) => { if (node.type === "TEXT") out.push(String(node.text)); });
  return out;
}

test("block spec detection only matches section-based specs", () => {
  assert.equal(isBlockSpec(JSON.parse(BLOCK_SPEC_EXAMPLE)), true);
  assert.equal(isBlockSpec({ summary: "x", frame: {}, elements: [] }), false);
  assert.equal(isBlockSpec(null), false);
});

for (const [label, spec, canvas] of [
  ["example (light)", JSON.parse(BLOCK_SPEC_EXAMPLE), lightCanvas],
  ["example (dark source)", { ...JSON.parse(BLOCK_SPEC_EXAMPLE), theme: undefined }, darkCanvas],
  ["kyc kitchen sink", kycSpec, lightCanvas],
] as const) {
  test("block spec renders a valid native plan: " + label, () => {
    const expansion = expandBlockSpec(spec, canvas);
    assert.deepEqual(expansion.errors, []);
    assert.ok(expansion.plan);
    assert.ok(expansion.nodeCount <= BLOCK_NODE_BUDGET);
    const elements = expansion.plan!.elements as N[];
    assert.ok(elements.length >= 3 && elements.length <= 8);
    walk(elements, (node, depth) => {
      assert.ok(depth <= 4, node.name + " is nested too deep");
      if (node.type === "FRAME") assert.ok(typeof node.color === "string" || node.noFill === true, node.name + " needs an explicit fill");
      assert.ok(typeof node.width === "number" && typeof node.height === "number");
    });

    // Every content string in the spec survives as a native TEXT layer.
    const output = texts(elements).join(" | ");
    for (const value of JSON.stringify(spec.sections).match(/"(?:label|value|title|text|caption|placeholder|helper|body|action)":"([^"]+)"/g) || []) {
      const content = value.split('":"')[1].slice(0, -1);
      assert.ok(output.includes(content), "missing " + content);
    }

    const normalized = normalizePlan(expansion.plan, canvas) as { elements: N[] };
    // Flow children must not be reclassified as absolute overlays by the normalizer.
    walk(normalized.elements, (node) => {
      if (node.layoutPositioning === "ABSOLUTE") assert.match(String(node.name), /^Progress/, node.name + " became absolute");
    });
    const report = auditDesignPlanQuality(normalized, canvas, "improve this screen");
    assert.equal(report.passed, true, JSON.stringify(report.findings));
  });
}

test("block spec keeps auto layout properties and real progress semantics", () => {
  const plan = expandBlockSpec(JSON.parse(BLOCK_SPEC_EXAMPLE), lightCanvas).plan!;
  const nodes: N[] = [];
  walk(plan.elements as N[], (node) => nodes.push(node));
  const arc = nodes.find((node) => node.type === "ELLIPSE" && /60%/.test(String(node.name)));
  assert.ok(arc, "progress arc exists");
  const arcData = arc!.arcData as { startingAngle: number; endingAngle: number };
  assert.ok(Math.abs((arcData.endingAngle - arcData.startingAngle) - Math.PI * 2 * 0.6) < 0.01, "arc spans 60%");
  const card = (plan.elements as N[]).find((node) => node.name === "Loan summary")!;
  assert.equal(card.layoutMode, "VERTICAL");
  assert.equal(card.primaryAxisSizingMode, "AUTO");
  assert.equal(card.layoutSizingHorizontal, "FILL");
  const badge = nodes.find((node) => /Status badge · Current/.test(String(node.name)));
  assert.ok(badge && badge.layoutMode === "HORIZONTAL" && badge.layoutSizingHorizontal === "HUG");
});

test("block spec rejects over-budget and too-thin specs with actionable feedback", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ type: "row", label: "Row " + i, value: "₹" + i }));
  const big = expandBlockSpec({ sections: [{ name: "A", blocks: rows }, { name: "B", blocks: rows }, { name: "C", blocks: rows }] }, lightCanvas);
  assert.equal(big.plan, null);
  assert.match(big.errors.join(" "), /layer budget/);
  const thin = expandBlockSpec({ sections: [{ name: "Only", blocks: [{ type: "text", text: "Hello" }] }] }, lightCanvas);
  assert.equal(thin.plan, null);
  assert.match(thin.errors.join(" "), /3–8 sections/);
  assert.match(expandBlockSpec({ summary: "x" }, lightCanvas).errors.join(" "), /sections must be a non-empty array/);
});

test("block spec accepts aliases, drops unknown components and passes custom nodes through", () => {
  const canvas = { ...lightCanvas, components: [{ id: "12:34", name: "Button/Primary" }] };
  const expansion = expandBlockSpec({
    sections: [
      { name: "Top", blocks: [{ type: "header", title: "Profile" }] },
      { name: "Rows", blocks: [{ type: "list_row", label: "Name", value: "Asha" }, { type: "component", componentId: "99:99" }] },
      { name: "Bottom", blocks: [
        { type: "component", componentId: "12:34", name: "Primary CTA", instanceProperties: { Label: "Save" } },
        { type: "custom", node: { type: "FRAME", name: "Signature pad", width: 999, height: 120, color: "#FFFFFF", children: [{ type: "TEXT", name: "Hint", text: "Sign here", width: 200, height: 20 }] } },
      ] },
    ],
  }, canvas);
  assert.deepEqual(expansion.errors, []);
  assert.match(expansion.warnings.join(" "), /unknown componentId 99:99/);
  const nodes: N[] = [];
  walk(expansion.plan!.elements as N[], (node) => nodes.push(node));
  const instance = nodes.find((node) => node.type === "INSTANCE");
  assert.equal(instance?.componentId, "12:34");
  assert.deepEqual(instance?.instanceProperties, { Label: "Save" });
  const custom = nodes.find((node) => node.name === "Signature pad");
  assert.ok(custom && Number(custom.width) <= 328, "custom node is clamped to the content width");
  assert.ok(nodes.some((node) => node.type === "TEXT" && node.text === "Sign here"));
  assert.ok(nodes.some((node) => node.type === "TEXT" && node.text === "Profile"));
});

test("theme resolution repairs low-contrast colours deterministically", () => {
  const theme = resolveTheme({ background: "#FFFFFF", surface: "#FFFFFF", muted: "#DDDDDD", primary: "#FFE600", onPrimary: "#FFFFFF" }, null);
  assert.ok(contrast(theme.muted, theme.surface) >= 4.5);
  assert.ok(contrast(theme.onPrimary, theme.primary) >= 4.5);
  assert.equal(resolveTheme({}, "#0E0F12").dark, true);
  assert.ok(contrast(ensureContrast("#777777", "#808080"), "#808080") >= 4.5);
});

test("figma agent route renders block specs by default with a legacy rollback switch", () => {
  const route = readFileSync(resolve(process.cwd(), "app/api/assistant/figma-agent/route.ts"), "utf8");
  assert.ok(route.includes('process.env.UXD_FIGMA_PLAN_MODE || "blocks"'));
  assert.ok(route.includes("(blockMode ? BLOCK_SYSTEM : SYSTEM)"));
  assert.ok(route.includes("isRecovery ? (blockMode ? blockRecoverySystem : recoverySystem) : system"));
  assert.ok(route.includes("if (isBlockSpec(candidateInput))"));
  assert.ok(route.includes('planFormat: candidate.blockSpec ? "blocks" : "elements"'));
});

test("plan extraction accepts block specs from fenced or prefixed model output", async () => {
  const { extractPlanJson } = await import("../src/figma-agent/extract-plan-json");
  const spec = JSON.parse(BLOCK_SPEC_EXAMPLE);
  const fenced = "Here is the design:\n```json\n" + JSON.stringify(spec, null, 2) + "\n```";
  const extracted = extractPlanJson(fenced) as Record<string, unknown>;
  assert.ok(extracted && Array.isArray(extracted.sections), "fenced block spec is extracted");
  assert.equal(isBlockSpec(extracted), true);
  const envelope = { choices: [{ message: { role: "assistant", content: "Sure. " + JSON.stringify(spec) } }] };
  assert.equal(isBlockSpec(extractPlanJson(envelope)), true, "block spec inside an OpenAI envelope is extracted");
  assert.equal(extractPlanJson('{"sections":"nope"}'), null);
});
