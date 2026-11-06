import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BLOCK_SPEC_EXAMPLE, expandBlockSpec } from "../src/figma-agent/block-spec";
import { normalizePlan } from "../src/figma-agent/normalize-plan";
import { auditDesignPlanQuality, missingSourceTexts } from "../src/figma-agent/design-plan-quality";
import {
  appendMissingSourceText, lockTheme, pickVerifiedExample, promptRequestsRestyle,
  sourcePalette, stabilizeBlockSpec, structuralExample,
} from "../src/figma-agent/spec-consistency";
import { aggregateModelStats } from "../src/memory/verified-specs";

const sourceCanvas = {
  nodes: [{
    name: "Manage loans", type: "FRAME", width: 360, height: 800, fillColors: ["#F6F7F9"], children: [
      { name: "Title", type: "TEXT", text: "Manage loans", fillColors: ["#14171F"] },
      { name: "Card", type: "FRAME", fillColors: ["#FFFFFF"], children: [
        { name: "Label", type: "TEXT", text: "Personal loan", fillColors: ["#14171F"] },
        { name: "Status", type: "TEXT", text: "Current", fillColors: ["#6B7280"] },
        { name: "Amount", type: "TEXT", text: "₹1,20,000 of ₹2,00,000", fillColors: ["#14171F"] },
        { name: "EMI", type: "TEXT", text: "Next EMI", fillColors: ["#14171F"] },
        { name: "EMI value", type: "TEXT", text: "₹8,450", fillColors: ["#14171F"] },
        { name: "Due", type: "TEXT", text: "Due 05 Dec", fillColors: ["#6B7280"] },
      ] },
      { name: "Primary button", type: "FRAME", fillColors: ["#C8102E"], children: [
        { name: "Label", type: "TEXT", text: "Pay EMI", fillColors: ["#FFFFFF"] },
      ] },
    ],
  }],
  components: [],
};

const prompt = "improve hierarchy of this screen";

function render(spec: unknown) {
  const expansion = expandBlockSpec(spec, sourceCanvas, {});
  assert.ok(expansion.plan, "spec renders: " + expansion.errors.join("; "));
  return normalizePlan(expansion.plan, sourceCanvas) as Record<string, unknown>;
}

test("source palette is read from the selected frame", () => {
  const palette = sourcePalette(sourceCanvas);
  assert.equal(palette.background, "#F6F7F9");
  assert.equal(palette.text, "#14171F");
  assert.equal(palette.muted, "#6B7280");
  assert.equal(palette.primary, "#C8102E");
});

test("two models choosing different colours render the same palette", () => {
  const base = JSON.parse(BLOCK_SPEC_EXAMPLE);
  const gemini = stabilizeBlockSpec({ ...base, theme: { background: "#FFFFFF", primary: "#0B5FFF", radius: 20 } }, sourceCanvas, prompt);
  const glm = stabilizeBlockSpec({ ...base, theme: { background: "#101010", primary: "#22AA55", radius: 4 }, frame: { name: "x", backgroundColor: "#000000" } }, sourceCanvas, prompt);
  assert.equal(gemini.themeLocked, true);
  assert.deepEqual(gemini.spec.theme, glm.spec.theme);
  const a = render(gemini.spec);
  const b = render(glm.spec);
  assert.equal((a.frame as Record<string, unknown>).backgroundColor, "#F6F7F9");
  assert.deepEqual(a.elements, b.elements, "same layers, colours and radius from either model");
});

test("an explicit restyle request keeps the model's colours", () => {
  assert.equal(promptRequestsRestyle("make it dark mode"), true);
  assert.equal(promptRequestsRestyle("isko dark theme me banao"), true);
  assert.equal(promptRequestsRestyle("इसका रंग बदलो"), true);
  assert.equal(promptRequestsRestyle(prompt), false);
  const locked = lockTheme({ primary: "#22AA55" }, sourceCanvas, "change the brand colour to green");
  assert.equal(locked.locked, false);
  assert.equal(locked.theme.primary, "#22AA55");
});

test("dropped source text is restored deterministically and passes the content gate", () => {
  const weak = {
    summary: "Loan overview.",
    frame: { name: "Manage loans" },
    sections: [
      { name: "Header", blocks: [{ type: "app_bar", title: "Manage loans" }] },
      { name: "Loan summary", surface: "card", title: "Personal loan", blocks: [{ type: "stat", value: "₹8,450", label: "Next EMI" }] },
      { name: "Actions", blocks: [{ type: "button", label: "Pay EMI", variant: "primary" }] },
    ],
  };
  const before = render(weak);
  const missing = missingSourceTexts(before, sourceCanvas, prompt);
  assert.deepEqual(missing.sort(), ["Current", "Due 05 Dec", "₹1,20,000 of ₹2,00,000"].sort());
  assert.equal(auditDesignPlanQuality(before, sourceCanvas, prompt).passed, false);
  const repairedSpec = appendMissingSourceText(weak, missing);
  const sections = repairedSpec.sections as Array<Record<string, unknown>>;
  assert.equal(sections[sections.length - 1].name, "Actions", "primary action stays last");
  assert.equal(sections[sections.length - 2].name, "More details");
  const after = render(repairedSpec);
  assert.deepEqual(missingSourceTexts(after, sourceCanvas, prompt), []);
  assert.ok(!auditDesignPlanQuality(after, sourceCanvas, prompt).findings.some((f) => f.code === "missing-source-content"));
});

test("verified examples keep structure but never another screen's text", () => {
  const spec = JSON.parse(BLOCK_SPEC_EXAMPLE);
  const example = structuralExample(spec);
  const text = JSON.stringify(example);
  assert.ok(text.includes('"progress_ring"') && text.includes('"card"') && text.includes('"success"'));
  for (const leaked of ["₹8,450", "PL12345678", "Pay EMI", "Due 05 Dec", "Current"]) assert.ok(!text.includes(leaked), "leaked " + leaked);
  assert.ok(text.includes('"percent":60'), "numbers that carry meaning survive");
  const rows = [
    { plan: spec, metadata: { lintVersion: 2, planFormat: "blocks", designScope: "selected_component_or_card", qualityScore: 100 } },
    { plan: spec, metadata: { lintVersion: 2, planFormat: "blocks", designScope: "selected_screen_or_frame", qualityScore: 90, repairedTexts: 2 } },
    { plan: { ...spec, sections: spec.sections.slice(0, 1) }, metadata: { lintVersion: 2, planFormat: "blocks", designScope: "selected_screen_or_frame", qualityScore: 80 } },
  ];
  const picked = pickVerifiedExample(rows, "selected_screen_or_frame");
  assert.equal((picked?.sections as unknown[]).length, 1, "same scope wins; repaired runs are not examples");
  assert.equal(pickVerifiedExample([], "selected_screen_or_frame"), null);
});

test("model stats group figma-agent runs by the model auto actually used", () => {
  const stats = aggregateModelStats([
    { outcome: "verified", metadata: { source: "figma-agent", model: "gemini-3.8-flash", qualityScore: 100 } },
    { outcome: "failed", metadata: { source: "figma-agent", model: "gemini-3.8-flash", qualityScore: 70 } },
    { outcome: "verified", metadata: { source: "figma-agent", model: "glm-5", qualityScore: 92, repairedTexts: 2 } },
    { outcome: "verified", metadata: { source: "other" } },
  ]);
  assert.deepEqual(stats[0], { model: "gemini-3.8-flash", runs: 2, verified: 1, failed: 1, pending: 0, repaired: 0, avgQuality: 85 });
  assert.equal(stats[1].repaired, 1);
  assert.equal(stats.length, 2);
});

test("figma route applies consistency steps for every model auto picks", () => {
  const route = readFileSync(resolve(process.cwd(), "app/api/assistant/figma-agent/route.ts"), "utf8");
  assert.ok(route.includes("stabilizeBlockSpec(rawPlan, canvas, parsedInput.data.prompt)"));
  assert.ok(route.includes("isFreeLlmApi && !paramsRejected ? { temperature: isRecovery ? 0.1 : 0.2 }"));
  assert.ok(route.includes("appendMissingSourceText(specInput, missing)"));
  assert.ok(route.includes("loadVerifiedExample(taskScope, designScope)"));
  assert.ok(route.includes("recordGeneration(taskRunId"));
  assert.ok(route.includes("if (fallback) return respond(fallback);"));
});
