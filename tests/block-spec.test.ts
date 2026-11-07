import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BLOCK_NODE_BUDGET, BLOCK_SPEC_EXAMPLE, contrast, ensureContrast, expandBlockSpec, isBlockSpec, resolveTheme, sourceFallbackSpec,
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
  const empty = expandBlockSpec({ sections: [{ name: "Only", blocks: [{ type: "sparkle_widget" }] }] }, lightCanvas);
  assert.equal(empty.plan, null);
  assert.match(empty.errors.join(" "), /No section produced layers/);
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

test("block renderer reuses the source header component, library text styles and type scale", () => {
  const BODY = "S:lib-body,175:871";
  const HEADING = "S:lib-heading,1763:5";
  const canvas = {
    nodes: [{ name: "Personal loan", type: "FRAME", width: 360, height: 800, fillColors: ["#121212"], children: [
      { name: "Screen header", type: "INSTANCE", x: 0, y: 0, width: 360, height: 64, mainComponentId: "507:418929",
        componentProperties: { "Property 1": "Inner" },
        children: [{ name: "Bank statements", type: "TEXT", text: "Personal Loan", fontSize: 16, fontStyle: "Semi Bold" }] },
      { name: "Screen body", type: "FRAME", y: 64, width: 360, height: 736, children: [
        { name: "Title", type: "TEXT", text: "Loan details", fontSize: 14, fontStyle: "Bold", fillColors: ["#FBFBFB"], textStyleId: HEADING },
        { name: "Label", type: "TEXT", text: "Loan product", fontSize: 14, fontStyle: "Regular", fillColors: ["#C4C4C4"], textStyleId: BODY },
        { name: "Value", type: "TEXT", text: "Consumption Loan", fontSize: 14, fontStyle: "Semi Bold", fillColors: ["#FFFFFF"] },
        { name: "Caption", type: "TEXT", text: "Loan amount", fontSize: 12, fontStyle: "Regular", fillColors: ["#C4C4C4"] },
      ] },
    ] }],
    components: [{ id: "507:418929", name: "App bar", type: "COMPONENT_SET" }],
  };
  const spec = {
    summary: "Personal loan details with EMI breakup.",
    sections: [
      { name: "Navigation", blocks: [{ type: "app_bar", title: "Personal Loan" }] },
      { name: "Loan summary", surface: "card", title: "Loan details", blocks: [
        { type: "row", label: "Loan product", value: "Consumption Loan" },
        { type: "row", label: "Flipkart loan", caption: "Loan amount: ₹30,000", value: "₹6,000" },
      ] },
      { name: "Payment action", blocks: [{ type: "button", label: "Pay ₹10,000" }] },
    ],
  };
  const result = expandBlockSpec(spec, canvas);
  assert.deepEqual(result.errors, []);
  const plan = result.plan!;
  assert.equal(plan.frame.paddingTop, 0, "the reused header sits full-bleed like the source");
  assert.equal(plan.frame.paddingLeft, 0);
  const sections = plan.elements as N[];
  assert.ok(sections.length >= 3 && sections.every((node) => node.type === "FRAME"), "sections stay framed for the normalizer");
  const header = sections[0].children![0];
  assert.equal(sections[0].width, 360);
  assert.equal(header.type, "INSTANCE");
  assert.equal(header.componentId, "507:418929");
  assert.equal(header.width, 360);
  assert.deepEqual(header.textOverrides, { "Bank statements": "Personal Loan" });
  assert.deepEqual(header.instanceProperties, { "Property 1": "Inner" });
  for (const section of sections.slice(1)) {
    assert.equal(section.width, 360);
    assert.equal(section.paddingLeft, 16, "body sections keep the 16px side margin");
  }

  const texts: N[] = [];
  walk(plan.elements as N[], (node) => { if (node.type === "TEXT") texts.push(node); });
  const byText = (value: string) => texts.find((node) => node.text === value)!;
  assert.equal(byText("Loan product").textStyleId, BODY);
  assert.equal(byText("Loan product").color, "#C4C4C4", "labels keep the source's label colour");
  assert.equal(byText("Loan details").textStyleId, HEADING, "card titles reuse the source heading style");
  assert.equal(byText("Loan details").fontSize, 14, "16px card titles snap to the source's 14px scale");
  assert.equal(byText("Consumption Loan").textStyleId, undefined);
  assert.equal(byText("Loan amount: ₹30,000").fontSize, 12);

  const normalized = normalizePlan(plan, canvas) as { elements: N[] };
  assert.equal(normalized.elements.length, sections.length, "the normalizer keeps the rendered sections");
  assert.deepEqual(normalized.elements[0].children![0].textOverrides, { "Bank statements": "Personal Loan" });
  walk(normalized.elements, (node) => assert.notEqual(node.layoutPositioning, "ABSOLUTE", node.name + " became absolute"));
  const report = auditDesignPlanQuality(normalized, canvas, "improve this screen");
  assert.equal(report.passed, true, JSON.stringify(report.findings));
  const normalizedTexts: N[] = [];
  walk(normalized.elements, (node) => { if (node.type === "TEXT") normalizedTexts.push(node); });
  assert.equal(normalizedTexts.find((node) => node.text === "Loan product")!.textStyleId, BODY);
});

test("without a source header instance the app bar is still drawn natively", () => {
  const result = expandBlockSpec(kycSpec, lightCanvas);
  const first = (result.plan!.elements as N[])[0];
  assert.notEqual(first.type, "INSTANCE");
  assert.equal(result.plan!.frame.paddingTop, 16);
});

test("primary buttons keep a light label by darkening the fill just enough", () => {
  const blue = resolveTheme({ background: "#121212", primary: "#3892F6", onPrimary: "#FFFFFF" }, null);
  assert.equal(blue.onPrimary, "#FFFFFF");
  assert.notEqual(blue.primaryFill, "#3892F6");
  assert.ok(contrast(blue.onPrimary, blue.primaryFill) >= 4.6);
  assert.equal(blue.primary, "#3892F6", "accent text keeps the source primary");
  const defaulted = resolveTheme({ background: "#121212", primary: "#3892F6" }, null);
  assert.equal(defaulted.onPrimary, "#FFFFFF");
  const yellow = resolveTheme({ background: "#FFFFFF", primary: "#FFC107" }, null);
  assert.equal(yellow.primaryFill, "#FFC107", "a light primary is not muddied; the label goes dark instead");
  assert.ok(contrast(yellow.onPrimary, yellow.primaryFill) >= 4.6);
});

test("thin or loosely typed specs render instead of failing the whole run", () => {
  const thin = expandBlockSpec({ sections: [{ name: "Details", blocks: [
    { type: "header", title: "Personal Loan" }, { type: "key_value_pair", label: "Credit limit", value: "₹50,000" },
    "Full amount for both loans", { type: "cta_button", label: "Pay ₹10,000", variant: "primary" },
  ] }] }, lightCanvas);
  assert.deepEqual(thin.errors, []);
  const plan = thin.plan!;
  assert.ok(plan.elements.length >= 2, "a single plain section is split into framed sections");
  const texts: string[] = [];
  walk(plan.elements as N[], (node) => { if (node.type === "TEXT") texts.push(String(node.text)); });
  for (const expected of ["Personal Loan", "Credit limit", "₹50,000", "Full amount for both loans", "Pay ₹10,000"]) assert.ok(texts.includes(expected), expected);
  const normalized = normalizePlan(plan, lightCanvas, { trustedSections: true }) as { elements: N[] };
  assert.equal(normalized.elements.length, plan.elements.length, "trusted block sections are not re-bucketed");
});

test("source fallback rebuilds the screen natively with every source text", () => {
  const canvas = {
    nodes: [{ name: "Loan", type: "FRAME", width: 360, height: 800, fillColors: ["#121212"], children: [
      { name: "Screen header", type: "INSTANCE", width: 360, height: 64, y: 0, children: [{ name: "Title", type: "TEXT", text: "Personal Loan" }] },
      { name: "Screen body", type: "FRAME", width: 360, height: 700, children: [
        { name: "Card", type: "FRAME", fillColors: ["#1C1A24"], children: [
          { name: "Heading", type: "TEXT", text: "Loan details" },
          { name: "Row", type: "FRAME", children: [{ name: "L", type: "TEXT", text: "Credit limit" }, { name: "V", type: "TEXT", text: "₹50,000" }] },
          { name: "Row", type: "FRAME", children: [{ name: "L", type: "TEXT", text: "Due date" }, { name: "V", type: "TEXT", text: "5 Oct" }] },
        ] },
        { name: "Footer", type: "FRAME", children: [
          { name: "CTA", type: "FRAME", height: 48, cornerRadius: 12, fillColors: ["#3892F6"], children: [{ name: "Label", type: "TEXT", text: "Pay ₹10,000" }] },
          { name: "Note", type: "TEXT", text: "Full amount for both loans" },
        ] },
      ] },
    ] }],
    components: [],
  };
  const spec = sourceFallbackSpec(canvas)!;
  assert.ok(spec);
  const result = expandBlockSpec(spec, canvas);
  assert.deepEqual(result.errors, []);
  const texts: string[] = [];
  walk(result.plan!.elements as N[], (node) => { if (node.type === "TEXT") texts.push(String(node.text)); });
  for (const expected of ["Personal Loan", "Loan details", "Credit limit", "₹50,000", "Due date", "5 Oct", "Pay ₹10,000", "Full amount for both loans"]) {
    assert.ok(texts.includes(expected), expected);
  }
  const sections = (spec.sections as Array<Record<string, unknown>>);
  assert.equal(sections[1].surface, "card");
  const normalized = normalizePlan(result.plan, canvas, { trustedSections: true });
  assert.equal(auditDesignPlanQuality(normalized as never, canvas, "improve this screen").passed, true);
});

test("source fallback still renders a tiny source screen", () => {
  const canvas = { nodes: [{ name: "Tiny", type: "FRAME", width: 360, height: 400, fillColors: ["#FFFFFF"], children: [
    { name: "Title", type: "TEXT", text: "Upcoming EMI" },
    { name: "Amount", type: "TEXT", text: "₹10,000" },
  ] }], components: [] };
  const spec = sourceFallbackSpec(canvas)!;
  const result = expandBlockSpec(spec, canvas);
  assert.deepEqual(result.errors, []);
  const normalized = normalizePlan(result.plan, canvas, { trustedSections: true }) as { elements: N[] };
  assert.ok(normalized.elements.length >= 1);
  const texts: string[] = [];
  walk(normalized.elements, (node) => { if (node.type === "TEXT") texts.push(String(node.text)); });
  assert.deepEqual(texts.sort(), ["Upcoming EMI", "₹10,000"].sort());
});

test("source fallback keeps deep card texts, tab rows and inner-frame card fills (Manage Loans)", () => {
  const t = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, name: text, type: "TEXT", x: 0, y: 0, width: 80, height: 16, text, fillColors: ["#FFFFFF"], ...extra });
  const tab = (id: string, label: string, opacity: number) => ({ id, name: "Tab", type: "INSTANCE", x: 0, y: 0, width: 106, height: 29, layoutMode: "VERTICAL",
    children: [t(id + "t", label, { opacity }), { id: id + "v", name: "Vector", type: "VECTOR", x: 0, y: 29, width: 106, height: 0 }] });
  const deepCard = (n: number) => ({ id: "c" + n, name: "Loan Card", type: "INSTANCE", x: 20, y: 0, width: 320, height: 198, layoutMode: "VERTICAL", children: [
    { id: "c" + n + "a", name: "Frame A", type: "FRAME", x: 0, y: 0, width: 320, height: 144, fillColors: ["#383838"], cornerRadius: 12, layoutMode: "HORIZONTAL", children: [
      { id: "c" + n + "b", name: "Frame B", type: "FRAME", x: 16, y: 20, width: 288, height: 108, layoutMode: "HORIZONTAL", children: [
        { id: "c" + n + "c", name: "Frame C", type: "FRAME", x: 0, y: 0, width: 271, height: 108, layoutMode: "VERTICAL", children: [
          { id: "c" + n + "d", name: "Loan Amount", type: "INSTANCE", x: 0, y: 49, width: 271, height: 59, layoutMode: "HORIZONTAL", children: [
            { id: "c" + n + "e", name: "Frame E", type: "FRAME", x: 71, y: 11, width: 200, height: 36, layoutMode: "HORIZONTAL", children: [
              { id: "c" + n + "f", name: "Frame F", type: "FRAME", x: 0, y: 0, width: 96, height: 36, layoutMode: "VERTICAL", children: [
                t("c" + n + "g", "Loan Amount"), t("c" + n + "h", "₹1,20,00" + n),
              ] },
            ] },
          ] },
        ] },
      ] },
    ] },
  ] });
  const canvas = { nodes: [{ id: "root", name: "15", type: "FRAME", x: 0, y: 0, width: 360, height: 800, fillColors: ["#121212"], layoutMode: "VERTICAL", children: [
    { id: "tabs", name: "Frame tabs", type: "FRAME", x: 0, y: 64, width: 360, height: 41, layoutMode: "HORIZONTAL", children: [tab("t1", "Active", 1), tab("t2", "Others", 0.5), tab("t3", "Closed", 0.5)] },
    { id: "list", name: "Frame list", type: "FRAME", x: 0, y: 105, width: 360, height: 600, layoutMode: "VERTICAL", children: [deepCard(1), deepCard(2)] },
  ] }] };
  const spec = sourceFallbackSpec(canvas)!;
  const json = JSON.stringify(spec);
  assert.ok(json.includes('"type":"tabs"') && json.includes('"Others"'), "tab row becomes one tabs block");
  assert.ok(json.includes("₹1,20,001") && json.includes("₹1,20,002"), "deep texts are kept");
  const sections = spec.sections as Array<{ surface: string; blocks: unknown[] }>;
  assert.equal(sections.filter((s) => s.surface === "card").length, 2, "both cards keep a card surface");
});

test("source fallback keeps deep card texts and turns small status pills into badges (finding 42)", () => {
  const T = (id: string, text: string) => ({ id, name: text, type: "TEXT", x: 0, y: 0, width: 100, height: 15, text });
  // Card title sits 8 levels under the screen, like the "Manage Loans" loan cards.
  let deep: Record<string, unknown> = { id: "t", name: "Title stack", type: "FRAME", x: 0, y: 0, width: 200, height: 30, layoutMode: "VERTICAL", children: [T("a", "Personal Loan"), T("b", "DMI1234567890")] };
  for (let i = 0; i < 6; i++) deep = { id: "w" + i, name: "Frame " + i, type: "FRAME", x: 0, y: 0, width: 300, height: 120, layoutMode: i % 2 ? "VERTICAL" : "HORIZONTAL", children: [deep] };
  const card = { id: "c", name: "Loan Card", type: "INSTANCE", x: 20, y: 80, width: 320, height: 144, fillColors: ["#383838"], children: [deep,
    { id: "p", name: "Labels", type: "INSTANCE", x: 247, y: 0, width: 73, height: 18, fillColors: ["#2E7D6B"], cornerRadius: 4, children: [T("s", "Current")] }] };
  const canvas = { nodes: [{ id: "r", name: "15", type: "FRAME", x: 0, y: 0, width: 360, height: 800, fillColors: ["#121212"], children: [
    { id: "ab", name: "App bar", type: "INSTANCE", x: 0, y: 0, width: 360, height: 64, children: [T("h", "Manage Loans")] }, card] }] };
  const spec = sourceFallbackSpec(canvas)!;
  const json = JSON.stringify(spec);
  assert.match(json, /Personal Loan/);
  assert.match(json, /DMI1234567890/);
  assert.match(json, /"type":"badge","text":"Current"/);
});

test("amounts and IDs never wrap mid-token (finding 59)", async () => {
  const { expandBlockSpec: expand } = await import("../src/figma-agent/block-spec");
  const canvas = { nodes: [{ id: "1", name: "S", type: "FRAME", width: 360, height: 800, children: [] }], components: [] };
  const spec = { summary: "x", sections: [{ name: "Loan", surface: "card", blocks: [
    { type: "stat_row", items: [{ label: "EMI", value: "₹12,000" }, { label: "Outstanding", value: "₹1,07,649" }, { label: "Paid", value: "₹88,351" }, { label: "Tenure", value: "36 months" }] },
    { type: "text", text: "DMI1234567890123456789" }] }], learningCandidate: null };
  const exp = expand(spec, canvas, {});
  assert.ok(exp.plan, exp.errors.join("; "));
  const texts: Array<Record<string, unknown>> = [];
  const walk = (ns: Array<Record<string, unknown>>) => ns.forEach((n) => { if (n.type === "TEXT") texts.push(n); walk((n.children as Array<Record<string, unknown>>) || []); });
  walk(exp.plan.elements as Array<Record<string, unknown>>);
  for (const n of texts.filter((n) => !/\s/.test(String(n.text)))) {
    assert.ok(Number(n.width) >= Math.ceil(String(n.text).length * Number(n.fontSize) * 0.56), n.text + " fits on one line");
  }
});

test("a spec with more than 8 sections is merged, not rejected (top block-spec failure)", async () => {
  const { expandBlockSpec: expand } = await import("../src/figma-agent/block-spec");
  const canvas = { nodes: [{ id: "1", name: "S", type: "FRAME", width: 360, height: 800, children: [] }], components: [] };
  const sections = Array.from({ length: 11 }, (_, i) => ({ name: "S" + i, surface: i % 3 === 0 ? "card" : "plain", blocks: [{ type: "text", text: "Item " + i }] }));
  const exp = expand({ summary: "x", sections, learningCandidate: null }, canvas, {});
  assert.ok(exp.plan, exp.errors.join("; "));
  assert.ok((exp.plan.elements as unknown[]).length <= 8);
  const text = JSON.stringify(exp.plan);
  for (let i = 0; i < 11; i += 1) assert.ok(text.includes('"Item ' + i + '"'), "kept Item " + i);
});

test("progress ring value is centred across the ring; repeated rows share one leading slot", async () => {
  const { expandBlockSpec, alignRowLeading } = await import("../src/figma-agent/block-spec");
  const spec = { sections: [
    { name: "Progress", blocks: [{ type: "progress_ring", percent: 80, label: "80% repaid" }] },
    { name: "Schedule", blocks: [
      { type: "row", label: "EMI", value: "₹4,500", icon: "✓" },
      { type: "row", label: "Due", value: "12 Nov" },
      { type: "row", label: "Paid", value: "₹36,000", icon: "✓" },
      { type: "row", label: "Outstanding", value: "₹1,07,649" },
    ] },
    { name: "Actions", blocks: [{ type: "button", label: "Pay now" }] },
  ] };
  const out = expandBlockSpec(spec, lightCanvas);
  assert.ok(out.plan, JSON.stringify(out.errors));
  const all: Array<Record<string, unknown>> = [];
  (function walk(nodes: Array<Record<string, unknown>>) { for (const n of nodes) { all.push(n); walk((n.children as never) || []); } })(out.plan!.elements as never);
  const value = all.find((n) => n.name === "Progress value" || String(n.name).includes("80%") && n.type === "TEXT" && n.textAlignHorizontal === "CENTER")!;
  assert.equal(value.width, 72);
  assert.equal(value.textAutoResize, "HEIGHT");
  const rows = all.filter((n) => n.type === "FRAME" && /\b(EMI|Due|Paid|Outstanding)\b/.test(String(n.name)) && /Row/.test(String(n.name)));
  assert.equal(rows.length, 4);
  for (const row of rows) assert.equal((row.children as Array<Record<string, unknown>>)[0].width, 36, String(row.name) + " starts with a 36px leading slot");
  assert.equal(alignRowLeading([{ type: "row", label: "A" }, { type: "row", label: "B" }]).some((b) => b.leadingSpacer), false, "no icons, no spacers");
});

test("card keeps a ring beside its metrics and an alert's single CTA inline", () => {
  const spec = {
    summary: "Loan cards keep their row groupings and fit the screen.",
    frame: { name: "Loans" },
    sections: [
      { name: "Header", blocks: [{ type: "app_bar", title: "Manage loans" }] },
      { name: "Personal loan", surface: "card", title: "Personal Loan", badge: { text: "Delinquent", tone: "danger" }, blocks: [
        { type: "progress_ring", percent: 40 },
        { type: "stat_row", items: [{ label: "Outstanding", value: "₹1,20,000" }, { label: "Next EMI", value: "₹8,450" }] },
        { type: "banner", body: "EMI overdue by 5 days", tone: "danger" },
        { type: "button", label: "Pay now", variant: "primary" },
      ] },
      { name: "Home loan", surface: "card", title: "Home Loan", blocks: [
        { type: "progress_ring", percent: 70, label: "70% paid" },
        { type: "list", items: [{ label: "Outstanding", value: "₹9,00,000" }] },
        { type: "text", text: "Statement ready" },
        { type: "buttons", items: [{ label: "View" }] },
      ] },
    ],
    learningCandidate: null,
  };
  const out = expandBlockSpec(spec, lightCanvas);
  assert.ok(out.plan, out.errors.join("; "));
  const cards = (out.plan!.elements as N[]).filter((n) => n.name === "Personal loan" || n.name === "Home loan");
  assert.equal(cards.length, 2);
  for (const card of cards) {
    const body = card.children!.find((n) => n.name === "Body")!;
    assert.ok(body, "ring and metrics share one row");
    assert.equal(body.layoutMode, "HORIZONTAL");
    assert.equal(body.children![0].name, "Progress ring");
    const alert = card.children!.find((n) => n.name === "Alert")!;
    assert.ok(alert, "alert and CTA share one row");
    assert.equal(alert.layoutMode, "HORIZONTAL");
    const btn = alert.children![alert.children!.length - 1];
    assert.equal(btn.height, 36);
    assert.equal(btn.layoutSizingHorizontal, "HUG");
    assert.ok((btn.width as number) < 140);
  }
  // Ring without a label: stat cells sit straight beside the ring.
  const first = cards.find((n) => n.name === "Personal loan")!.children!.find((n) => n.name === "Body")!;
  assert.equal(first.children!.length, 3);
  // The screen keeps the source height (800) instead of growing.
  assert.equal(out.plan!.frame.height, 800);
});

test("ring pairing leaves long metric lists and long CTA labels stacked", () => {
  const spec = {
    summary: "Stacked fallback.",
    frame: { name: "Loans" },
    sections: [
      { name: "A", blocks: [{ type: "heading", title: "Loans" }] },
      { name: "B", surface: "card", title: "Loan", blocks: [
        { type: "progress_ring", percent: 50 },
        { type: "list", items: [{ label: "a", value: "1" }, { label: "b", value: "2" }, { label: "c", value: "3" }, { label: "d", value: "4" }] },
        { type: "banner", body: "Overdue", tone: "danger" },
        { type: "button", label: "Pay the full outstanding amount" },
      ] },
      { name: "C", blocks: [{ type: "text", text: "Footer" }] },
    ],
    learningCandidate: null,
  };
  const out = expandBlockSpec(spec, lightCanvas);
  assert.ok(out.plan, out.errors.join("; "));
  const card = (out.plan!.elements as N[]).find((n) => n.name === "B")!;
  assert.ok(!card.children!.some((n) => n.name === "Body"));
  assert.ok(!card.children!.some((n) => n.name === "Alert"));
});
