import { test } from "node:test";
import assert from "node:assert/strict";
import { runStructuralLint } from "../src/figma-agent/structural-lint";
import { buildFigmaFailureLesson } from "../src/memory/task-learning";
import { pickVerifiedExample } from "../src/figma-agent/spec-consistency";
import { expandBlockSpec } from "../src/figma-agent/block-spec";
import { normalizePlan } from "../src/figma-agent/normalize-plan";
import { readFileSync } from "node:fs";

type N = Record<string, unknown>;
const text = (id: string, value: string, y: number): N => ({ id, name: value, type: "TEXT", x: 16, y, width: 200, height: 20, text: value });
const icon = (id: string, y: number): N => ({ id, name: "Chevron", type: "VECTOR", x: 300, y, width: 12, height: 12 });
const button = (id: string, label: string, y: number, filled: boolean): N => ({ id, name: "CTA", type: "FRAME", x: 16, y, width: 120, height: 40,
  ...(filled ? { fillColors: ["#0B5FFF"], cornerRadius: 8 } : {}), children: [text(id + "t", label, 10)] });
const frame = (children: N[]) => ({ nodes: [{ id: "r", name: "Screen", type: "FRAME", x: 0, y: 0, width: 360, height: 700, children }] });

const source = frame([text("a", "Loan A", 10), icon("i1", 10), text("b", "Loan B", 60), icon("i2", 60), text("c", "Loan C", 110), icon("i3", 110),
  text("d", "Loan D", 160), icon("i4", 160), text("e", "Loan E", 210), icon("i5", 210), button("p", "Pay now", 300, true)]);

test("lint fails a variation that dropped some icons or turned a button into a link", () => {
  const output = frame([text("a", "Loan A", 10), icon("o1", 10), text("b", "Loan B", 60), icon("o2", 60), text("c", "Loan C", 110), icon("o3", 110),
    text("d", "Loan D", 160), text("e", "Loan E", 210), button("p", "Pay now", 300, false)]);
  const result = runStructuralLint({ prompt: "Improve hierarchy", sourceCanvas: source, outputCanvas: output });
  assert.equal(result.passed, false);
  const issues = result.issues.map((i) => i.issue).join(" | ");
  assert.match(issues, /Icons, logos or graphics from the source were dropped/, "3 of 5 icons is below the 80% floor");
  assert.match(issues, /source button\(s\) are no longer buttons/);
  const lesson = buildFigmaFailureLesson("Structural lint blocked the variation: " + issues);
  assert.equal(lesson?.category, "dropped-visual-assets", "quality failures now teach the brain");
  assert.equal(buildFigmaFailureLesson("[high] 1 source button(s) are no longer buttons in the output.")?.category, "cta-downgraded");
});

test("lint passes a faithful variation", () => {
  const output = frame([text("a", "Loan A", 10), icon("o1", 10), text("b", "Loan B", 60), icon("o2", 60), text("c", "Loan C", 110), icon("o3", 110),
    text("d", "Loan D", 160), icon("o4", 160), text("e", "Loan E", 210), icon("o5", 210), button("p", "Pay now", 300, true)]);
  const result = runStructuralLint({ prompt: "Improve hierarchy", sourceCanvas: source, outputCanvas: output });
  assert.equal(result.passed, true, JSON.stringify(result.issues));
});

test("source-fallback runs are never used as the verified few-shot example", () => {
  const plan = { sections: [{ name: "A", blocks: [{ type: "text", text: "x" }] }] };
  assert.equal(pickVerifiedExample([{ plan, metadata: { lintVersion: 2, planFormat: "blocks", sourceFallback: true } }], "s"), null);
  assert.equal(pickVerifiedExample([{ plan, metadata: { lintVersion: 2, planFormat: "blocks", model: "source-fallback" } }], "s"), null);
  assert.ok(pickVerifiedExample([{ plan, metadata: { lintVersion: 2, planFormat: "blocks", model: "gemini" } }], "s"));
  // Runs verified under the older, looser lint are never served as examples.
  assert.equal(pickVerifiedExample([{ plan, metadata: { planFormat: "blocks", model: "gemini" } }], "s"), null);
  assert.equal(pickVerifiedExample([{ plan, metadata: { lintVersion: 1, planFormat: "blocks", model: "gemini" } }], "s"), null);
});

test("plugins without the clone capability get no CLONE elements", () => {
  const canvas = { nodes: [{ id: "r", name: "Screen", type: "FRAME", x: 0, y: 0, width: 360, height: 700, fillColors: ["#FFFFFF"], children: [
    text("a", "Loan A", 10), icon("i1", 10), text("b", "Loan B", 60), text("c", "Loan C", 110)] }], components: [] };
  const spec = { summary: "Three loans listed clearly.", sections: [
    { name: "One", blocks: [{ type: "text", text: "Loan A" }] }, { name: "Two", blocks: [{ type: "text", text: "Loan B" }] }, { name: "Three", blocks: [{ type: "text", text: "Loan C" }] }] };
  const hasClone = (allowClones: boolean) => JSON.stringify(expandBlockSpec(spec, canvas, { sourceCanvas: canvas, allowClones }).plan).includes("\"CLONE\"");
  assert.equal(hasClone(true), true);
  assert.equal(hasClone(false), false);
});

test("text-bearing app bar and tab instances rebuilt as native blocks are not dropped graphics (finding 39)", () => {
  const tab = (id: string, label: string, x: number): N => ({ id, name: "Component " + id, type: "INSTANCE", x, y: 80, width: 107, height: 29,
    children: [{ id: id + "t", name: label, type: "TEXT", x: 8, y: 6, width: 80, height: 16, text: label }, { id: id + "v", name: "Vector 193", type: "VECTOR", x: 90, y: 10, width: 8, height: 8 }] });
  const src = frame([
    { id: "ab", name: "App bar", type: "INSTANCE", x: 0, y: 0, width: 360, height: 64, children: [
      { id: "abt", name: "Title", type: "TEXT", x: 56, y: 20, width: 200, height: 24, text: "Manage Loans" },
      { id: "abi", name: "arrow-left", type: "VECTOR", x: 16, y: 20, width: 24, height: 24 }] },
    tab("2", "Active", 16), tab("3", "Closed", 126), tab("4", "All", 236),
    text("a", "Loan A", 140), icon("i1", 140), text("b", "Loan B", 190), icon("i2", 190)]);
  const out = frame([
    { id: "h", name: "App bar", type: "FRAME", x: 0, y: 0, width: 360, height: 64, children: [
      { id: "ht", name: "Title", type: "TEXT", x: 56, y: 20, width: 200, height: 24, text: "Manage Loans" }] },
    { id: "tb", name: "Tabs", type: "FRAME", x: 16, y: 80, width: 328, height: 36, children: [
      text("t1", "Active", 0), text("t2", "Closed", 0), text("t3", "All", 0)] },
    text("a", "Loan A", 140), icon("o1", 140), text("b", "Loan B", 190), icon("o2", 190)]);
  const result = runStructuralLint({ prompt: "Improve hierarchy", sourceCanvas: src, outputCanvas: out });
  const issues = result.issues.map((i) => i.issue).join(" | ");
  assert.doesNotMatch(issues, /Icons, logos or graphics from the source were dropped/, issues);
});

test("wireframe renders mark copied graphics for monochrome recolouring", () => {
  const canvas = { nodes: [{ id: "r", name: "Screen", type: "FRAME", x: 0, y: 0, width: 360, height: 700, fillColors: ["#FFFFFF"], children: [
    text("a", "Loan A", 10), icon("i1", 10), text("b", "Loan B", 60), text("c", "Loan C", 110)] }], components: [] };
  const spec = { summary: "Three loans listed clearly.", sections: [{ name: "Loans", blocks: [
    { type: "text", text: "Loan A" }, { type: "text", text: "Loan B" }, { type: "text", text: "Loan C" }] }], learningCandidate: null };
  const mono = expandBlockSpec(spec, canvas, { sourceCanvas: canvas, monochrome: true });
  const clones: N[] = [];
  const walk = (nodes: N[]) => nodes.forEach((n) => { if (n.type === "CLONE") clones.push(n); walk((n.children as N[]) || []); });
  walk(mono.plan!.elements as N[]);
  assert.ok(clones.length > 0);
  assert.ok(clones.every((c) => c.monochrome && typeof (c.monochrome as N).ink === "string"));
});

test("wireframes also mark reused source component instances (finding 52)", () => {
  const canvas = { nodes: [{ id: "r", name: "Screen", type: "FRAME", x: 0, y: 0, width: 360, height: 700, fillColors: ["#FFFFFF"], children: [
    text("a", "Loan A", 10)] }], components: [] };
  const plan = normalizePlan({ frame: { name: "W" }, elements: [
    { type: "INSTANCE", name: "App bar", componentId: "9:1", width: 360, height: 56, monochrome: { ink: "#18181B", placeholder: "#E4E4E7" } },
  ] }, canvas) as { elements: N[] };
  const found: N[] = [];
  const walkAll = (nodes: N[]) => nodes.forEach((n) => { if (n.type === "INSTANCE") found.push(n); walkAll((n.children as N[]) || []); });
  walkAll(plan.elements);
  assert.deepEqual(found[0]?.monochrome, { ink: "#18181B", placeholder: "#E4E4E7" });
  const code = readFileSync("figma-plugin/code.js", "utf8");
  assert.ok(code.includes('if (type === "INSTANCE" && spec.monochrome && typeof spec.monochrome === "object") await monochromeClone(node, spec.monochrome);'));
  assert.ok(code.includes("delete solid.boundVariables"), "variable-bound colours are unbound");
});

test("a squeezed row keeps amounts on one line (finding 59, model path)", () => {
  const canvas = { nodes: [{ id: "r", name: "Screen", type: "FRAME", x: 0, y: 0, width: 360, height: 700, children: [] }], components: [] };
  const plan = normalizePlan({ frame: { name: "W", width: 360 }, elements: [{ type: "FRAME", name: "Card", width: 328, height: 80, layoutMode: "VERTICAL", children: [
    { type: "FRAME", name: "Row", width: 200, height: 40, layoutMode: "HORIZONTAL", itemSpacing: 8, children: [
      { type: "CLONE", name: "Logo", sourceNodeId: "9:9", width: 60, height: 20 },
      { type: "TEXT", name: "Label", text: "Outstanding amount", width: 140, height: 20, fontSize: 14 },
      { type: "TEXT", name: "Value", text: "₹12,000", width: 90, height: 20, fontSize: 14 }] }] }] }, canvas) as { elements: N[] };
  const found: N[] = [];
  const walkAll = (nodes: N[]) => nodes.forEach((n) => { if (n.text === "₹12,000") found.push(n); walkAll((n.children as N[]) || []); });
  walkAll(plan.elements);
  assert.ok(Number(found[0]?.width) >= Math.ceil(7 * 14 * 0.56), "amount width " + found[0]?.width);
});

test("a row whose rigid parts are too wide wraps instead of failing preflight (finding 65)", async () => {
  const { auditDesignPlanQuality } = await import("../src/figma-agent/design-plan-quality");
  const canvas = { nodes: [{ id: "r", name: "Screen", type: "FRAME", x: 0, y: 0, width: 360, height: 700, children: [
    { id: "t", type: "TEXT", name: "t", text: "DMI1234567890", x: 0, y: 0, width: 100, height: 20 }] }], components: [] };
  const plan = normalizePlan({ frame: { name: "W", width: 360 }, elements: [{ type: "FRAME", name: "Card", width: 328, height: 120, layoutMode: "VERTICAL", children: [
    { type: "FRAME", name: "Card header", width: 296, height: 40, layoutMode: "HORIZONTAL", itemSpacing: 12, primaryAxisSizingMode: "FIXED", children: [
      { type: "CLONE", name: "Logo", sourceNodeId: "9:9", width: 120, height: 32 },
      { type: "TEXT", name: "ID", text: "DMI1234567890", width: 150, height: 20, fontSize: 16 },
      { type: "CLONE", name: "Badge", sourceNodeId: "9:8", width: 90, height: 24 }] }] }] }, canvas) as { elements: N[] };
  const report = auditDesignPlanQuality(plan, canvas, "improve this screen");
  assert.ok(!report.findings.some((f) => f.code === "fixed-layout-overflow"), JSON.stringify(report.findings));
});

test("a row pushed wide by a child that grew during repair still wraps (finding 65, round 5)", async () => {
  const { auditDesignPlanQuality } = await import("../src/figma-agent/design-plan-quality");
  const canvas = { nodes: [{ id: "r", name: "Screen", type: "FRAME", x: 0, y: 0, width: 360, height: 700, children: [
    { id: "t", type: "TEXT", name: "t", text: "Personal Loan", x: 0, y: 0, width: 100, height: 20 }] }], components: [] };
  const plan = normalizePlan({ frame: { name: "W", width: 360 }, elements: [{ type: "FRAME", name: "Card", width: 328, height: 120, layoutMode: "VERTICAL", children: [
    { type: "FRAME", name: "Card header", width: 296, height: 40, layoutMode: "HORIZONTAL", itemSpacing: 12, primaryAxisSizingMode: "FIXED", layoutSizingHorizontal: "FILL", children: [
      { type: "TEXT", name: "Title", text: "Personal Loan", width: 150, height: 20, fontSize: 16, layoutSizingHorizontal: "FILL" },
      { type: "FRAME", name: "Status badge", width: 74, height: 24, layoutMode: "HORIZONTAL", itemSpacing: 4, paddingLeft: 10, paddingRight: 10, layoutSizingHorizontal: "HUG", primaryAxisSizingMode: "AUTO", children: [
        { type: "CLONE", name: "Icon", sourceNodeId: "9:1", width: 60, height: 16 },
        { type: "TEXT", name: "Badge label", text: "Overdue", width: 54, height: 16, fontSize: 12 }] }] }] }] }, canvas) as { elements: N[] };
  const report = auditDesignPlanQuality(plan, canvas, "improve this screen");
  assert.ok(!report.findings.some((f) => f.code === "fixed-layout-overflow"), JSON.stringify(report.findings));
});
