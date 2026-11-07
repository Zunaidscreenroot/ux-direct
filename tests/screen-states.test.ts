import test from "node:test";
import assert from "node:assert/strict";
import { stateDroppableTexts, stateFallbackSpec, stateGatePrompt, stateKeepTexts } from "../src/figma-agent/screen-states";
import { missingSourceTexts } from "../src/figma-agent/design-plan-quality";
import { runStructuralLint } from "../src/figma-agent/structural-lint";
import { expandBlockSpec, sourceFallbackSpec } from "../src/figma-agent/block-spec";

const t = (id: string, text: string, y: number, x = 16) => ({ id, name: text, type: "TEXT", x, y, width: 200, height: 20, text });
const canvas = { nodes: [{ id: "1:1", name: "Manage Loans", type: "FRAME", x: 0, y: 0, width: 360, height: 760, fillColors: ["#FFFFFF"], children: [
  { id: "1:2", name: "Header", type: "FRAME", x: 0, y: 0, width: 360, height: 64, children: [t("1:3", "Manage Loans", 20)] },
  { id: "1:4", name: "Loan card", type: "FRAME", x: 16, y: 100, width: 328, height: 160, fillColors: ["#F2F4F7"], cornerRadius: 12, children: [
    t("1:5", "Loan ID SLC001", 16), t("1:6", "₹45,000 outstanding", 48), t("1:7", "Due 5 Jan", 80)] },
  { id: "1:8", name: "Nav", type: "FRAME", x: 0, y: 700, width: 360, height: 60, children: [t("1:9", "Home", 20), t("1:10", "Loans", 20, 120)] },
] }], components: [] };

test("empty/loading states keep header and nav texts but may drop content", () => {
  const keep = stateKeepTexts(canvas);
  assert.ok(keep.has("Manage Loans") && keep.has("Home") && keep.has("Loans"));
  assert.deepEqual(stateDroppableTexts(canvas, "empty").sort(), ["Due 5 Jan", "Loan ID SLC001", "₹45,000 outstanding"].sort());
  assert.deepEqual(stateDroppableTexts(canvas, "error"), [], "error keeps everything");
});

test("the source gate accepts an empty state but still requires the header", () => {
  const plan = (texts: string[]) => ({ elements: texts.map((text, i) => ({ type: "TEXT", name: text, x: 0, y: i * 30, width: 200, height: 20, text })) });
  const gate = stateGatePrompt("add empty state", "empty", canvas);
  assert.deepEqual(missingSourceTexts(plan(["Manage Loans", "Home", "Loans", "No active loans"]), canvas, gate), []);
  assert.deepEqual(missingSourceTexts(plan(["Home", "Loans", "No active loans"]), canvas, gate), ["Manage Loans"]);
});

test("lint ignores dropped content for a state", () => {
  const output = { nodes: [{ id: "9:1", name: "Out", type: "FRAME", x: 0, y: 0, width: 360, height: 760, children: [t("9:2", "Manage Loans", 20), t("9:3", "Home", 700), t("9:4", "Loans", 700, 120)] }] };
  const plain = runStructuralLint({ prompt: "add empty state", sourceCanvas: canvas, outputCanvas: output });
  assert.ok(plain.content.missingText.length >= 3);
  const state = runStructuralLint({ prompt: "add empty state", sourceCanvas: canvas, outputCanvas: output, ignoreTexts: stateDroppableTexts(canvas, "empty") });
  assert.deepEqual(state.content.missingText, []);
});

test("the deterministic empty fallback keeps the header and renders", () => {
  const base = sourceFallbackSpec(canvas)!;
  assert.ok(base);
  const spec = stateFallbackSpec(base, "empty", canvas);
  const exp = expandBlockSpec(spec, canvas, { sourceCanvas: canvas });
  assert.ok(exp.plan, exp.errors.join("; "));
  const texts: string[] = [];
  const walk = (nodes: Array<Record<string, unknown>>) => { for (const n of nodes) { if (n.type === "TEXT") texts.push(String(n.text)); walk((n.children as Array<Record<string, unknown>>) ?? []); } };
  walk(exp.plan!.elements as Array<Record<string, unknown>>);
  assert.ok(texts.includes("Manage Loans"), texts.join(" | "));
  assert.ok(!texts.includes("Loan ID SLC001"), "content dropped");
  assert.ok(texts.includes("No loans yet"), texts.join(" | "));
  assert.ok(texts.includes("Apply for a loan"), "empty state has a start CTA");
  assert.match(String((spec.frame as Record<string, unknown>).name), / \/ Empty$/);
});

test("an empty state never brings back the cards' Pay now buttons", () => {
  const btn = (id: string, y: number) => ({ id, name: "Pay button", type: "FRAME", x: 16, y, width: 120, height: 36, fillColors: ["#0B5FFF"], cornerRadius: 8,
    children: [t(id + "t", "Pay now", 8, 30)] });
  const card = (i: number, y: number) => ({ id: "c" + i, name: "Loan card", type: "FRAME", x: 16, y, width: 328, height: 160, fillColors: ["#F2F4F7"], cornerRadius: 12,
    children: [t("c" + i + "a", "Loan ID SLC00" + i, 16), t("c" + i + "b", "₹" + i + "0,000", 48), btn("c" + i + "p", 110)] });
  const src = { nodes: [{ ...canvas.nodes[0], children: [canvas.nodes[0].children[0], card(1, 100), card(2, 300), canvas.nodes[0].children[2]] }], components: [] };
  const spec = stateFallbackSpec(sourceFallbackSpec(src)!, "empty", src);
  const exp = expandBlockSpec(spec, src, { sourceCanvas: src, contentDropped: true });
  assert.ok(exp.plan, exp.errors.join("; "));
  const texts: string[] = [];
  const walk = (nodes: Array<Record<string, unknown>>) => { for (const n of nodes) { if (n.type === "TEXT") texts.push(String(n.text)); walk((n.children as Array<Record<string, unknown>>) ?? []); } };
  walk(exp.plan!.elements as Array<Record<string, unknown>>);
  assert.ok(!texts.includes("Pay now"), texts.join(" | "));
});

test("loading fallback keeps tabs, uses text-free skeletons in the dark source theme (round 8)", async () => {
  const { auditDesignPlanQuality } = await import("../src/figma-agent/design-plan-quality");
  const { normalizePlan } = await import("../src/figma-agent/normalize-plan");
  const tab = (id: string, label: string, x: number, opacity = 1) => ({ id, name: "Tab", type: "FRAME", x, y: 0, width: 100, height: 44, opacity,
    children: [{ ...t(id + "t", label, 12, 20), width: 60 }] });
  const dark = { nodes: [{ ...canvas.nodes[0], fillColors: ["#121212"], children: [
    canvas.nodes[0].children[0],
    { id: "1:20", name: "Tabs", type: "FRAME", x: 16, y: 72, width: 328, height: 44, layoutMode: "HORIZONTAL", children: [tab("1:21", "Active", 0), tab("1:22", "Closed", 110)] },
    { ...canvas.nodes[0].children[1], y: 140, fillColors: ["#2A2A2A"] },
    canvas.nodes[0].children[2],
  ] }], components: [] };
  const spec = stateFallbackSpec(sourceFallbackSpec(dark)!, "loading", dark);
  const exp = expandBlockSpec(spec, dark, { sourceCanvas: dark, contentDropped: true, skeleton: true });
  assert.ok(exp.plan, exp.errors.join("; "));
  const texts: string[] = [];
  const rects: Array<Record<string, unknown>> = [];
  const walk = (nodes: Array<Record<string, unknown>>) => { for (const n of nodes) {
    if (n.type === "TEXT") texts.push(String(n.text));
    if (String(n.name).startsWith("Skeleton")) rects.push(n);
    walk((n.children as Array<Record<string, unknown>>) ?? []);
  } };
  walk(exp.plan!.elements as Array<Record<string, unknown>>);
  assert.ok(texts.includes("Active") && texts.includes("Closed"), "tabs kept: " + texts.join(" | "));
  assert.ok(!texts.some((x) => /Illustration|Loading/.test(x)), "no labels in skeletons: " + texts.join(" | "));
  assert.ok(rects.length >= 2, "skeleton shapes drawn");
  const shade = String(rects.find((r) => typeof r.color === "string")?.color);
  const lum = parseInt(shade.slice(1, 3), 16);
  assert.ok(lum < 0x80, "skeleton shade follows the dark theme, got " + shade);
  const plan = normalizePlan(exp.plan, dark, { trustedSections: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const quality = auditDesignPlanQuality(plan as any, dark, stateGatePrompt("loading state", "loading", dark));
  assert.ok(quality.passed, JSON.stringify(quality.findings));
});
