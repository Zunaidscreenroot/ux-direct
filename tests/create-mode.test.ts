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
