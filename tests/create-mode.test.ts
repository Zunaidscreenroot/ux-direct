import { test } from "node:test";
import assert from "node:assert/strict";
import { createFrameName, createFrameSize, createModeCanvas } from "../src/figma-agent/create-mode";
import { expandBlockSpec } from "../src/figma-agent/block-spec";
import { normalizePlan } from "../src/figma-agent/normalize-plan";
import { auditDesignPlanQuality, missingSourceTexts } from "../src/figma-agent/design-plan-quality";

test("create mode picks a frame size and name from the prompt", () => {
  assert.deepEqual(createFrameSize("create a loan dashboard"), { width: 360, height: 800, platform: "mobile" });
  assert.equal(createFrameSize("design a web admin page for KYC review").width, 1440);
  assert.equal(createFrameSize("anything", { width: 390, height: 844 }).width, 390);
  assert.equal(createFrameName("Create a loan dashboard"), "Loan dashboard");
  assert.equal(createFrameName("make me a new EMI calculator screen"), "EMI calculator");
});

test("a new screen from a prompt passes the gates against the empty virtual frame", () => {
  const canvas = createModeCanvas({ nodes: [], components: [] }, { width: 360, height: 800 }, "create a loan dashboard");
  const spec = { summary: "Loan dashboard with outstanding summary, active loans and a pay action.", frame: { name: "Loan dashboard" }, sections: [
    { name: "Header", blocks: [{ type: "app_bar", title: "My Loans" }] },
    { name: "Summary", surface: "card", blocks: [
      { type: "heading", title: "₹1,25,000", subtitle: "Total outstanding" },
      { type: "stats", items: [{ label: "Next EMI", value: "₹8,450" }, { label: "Due on", value: "12 Mar 2026" }] },
    ] },
    { name: "Active loans", blocks: [{ type: "list", items: [
      { title: "Personal Loan", subtitle: "XXXX 4821", value: "₹82,000", badge: "Current" },
      { title: "Two-wheeler Loan", subtitle: "XXXX 1907", value: "₹43,000", badge: "Due soon" },
    ] }] },
    { name: "Action", blocks: [{ type: "button", label: "Pay EMI", variant: "primary" }] },
  ] };
  const expansion = expandBlockSpec(spec, canvas, { sourceCanvas: canvas });
  assert.ok(expansion.plan, expansion.errors.join("; "));
  const plan = normalizePlan(expansion.plan, canvas, { trustedSections: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const quality = auditDesignPlanQuality(plan as any, canvas, "create a loan dashboard");
  assert.ok(quality.passed, JSON.stringify(quality.findings));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(missingSourceTexts(plan as any, canvas, "create a loan dashboard").length, 0);
});

test("create mode uses the file's background and reuses its app bar component with the new title", () => {
  const raw = {
    nodes: [],
    pageBackground: "#0e0f12",
    styles: { paint: [{ id: "S:bg", name: "DMI / Observed / Colors / Background", color: "#0E0F12" }, { id: "S:primary", name: "Primary", color: "#22D3EE" }] },
    components: [
      { id: "C:bottom", name: "Bottom nav bar", width: 360, height: 64, uses: 9 },
      { id: "C:appbar", name: "App bar", width: 360, height: 56, uses: 7, properties: {} },
      { id: "C:card", name: "Loan card", width: 320, height: 120, uses: 3 },
    ],
  };
  const canvas = createModeCanvas(raw, { width: 360, height: 800 }, "create a loan dashboard");
  const root = (canvas.nodes as Record<string, unknown>[])[0];
  assert.deepEqual(root.fillColors, ["#0E0F12"]);
  const kids = root.children as Record<string, unknown>[];
  assert.equal(kids.length, 1);
  assert.equal(kids[0].mainComponentId, "C:appbar");
  assert.equal(kids[0].type, "INSTANCE");

  const spec = { summary: "Loan dashboard.", sections: [
    { name: "Header", blocks: [{ type: "app_bar", title: "Loan dashboard" }] },
    { name: "Summary", surface: "card", title: "Total outstanding", blocks: [{ type: "stat", value: "₹4,20,000" }] },
    { name: "Loans", blocks: [{ type: "list", items: [{ label: "Personal loan", value: "₹1,20,000" }] }] },
  ], learningCandidate: null };
  const out = expandBlockSpec(spec, { ...canvas, components: raw.components });
  assert.ok(out.plan, out.errors.join("; "));
  const header = (out.plan!.elements as Record<string, unknown>[])[0];
  const instance = ((header.children as Record<string, unknown>[] | undefined)?.[0] ?? header) as Record<string, unknown>;
  assert.equal(instance.type, "INSTANCE");
  assert.equal(instance.componentId, "C:appbar");
  assert.deepEqual(instance.textOverrides, { __title: "Loan dashboard" });
  assert.equal(String(out.plan!.frame.backgroundColor).toUpperCase(), "#0E0F12");
});

test("create mode without page fill falls back to a background paint style, else white; no header without a fitting app bar", () => {
  const styled = createModeCanvas({ styles: { paint: [{ id: "a", name: "Button / bg", color: "#FF0000" }, { id: "b", name: "Colors/Background", color: "#101820" }] }, components: [{ id: "x", name: "Header", width: 1440, height: 80 }] },
    { width: 360, height: 800 }, "create a profile screen");
  const root = (styled.nodes as Record<string, unknown>[])[0];
  assert.deepEqual(root.fillColors, ["#101820"]);
  assert.deepEqual(root.children, []);
  const plain = createModeCanvas({}, { width: 360, height: 800 }, "create a profile screen");
  assert.deepEqual((plain.nodes as Record<string, unknown>[])[0].fillColors, ["#FFFFFF"]);
});
