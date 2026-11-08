import test from "node:test";
import assert from "node:assert/strict";
import { auditDesignPlanQuality, isSimplifyObjective, missingSourceTexts } from "../src/figma-agent/design-plan-quality";

const texts = ["Manage Loans", "Personal Loan", "DMI1234567890", "Overdue", "₹12,570", "Pay now",
  "Get instant top-up up to 5 lakh", "Check your offers", "Your EMI is safe with us", "Track all your loans in one place"];
const source = { nodes: [{ type: "FRAME", name: "Manage Loans", children: texts.map((text, i) => ({ type: "TEXT", name: "t" + i, text })) }] };
const plan = (kept: string[], extra = 0) => ({
  frame: { name: "Manage Loans", width: 360, height: 800, layoutMode: "VERTICAL", itemSpacing: 8 },
  elements: [{ type: "FRAME", name: "Body", layoutMode: "VERTICAL", width: 360, height: 760, fills: [],
    children: [...kept.map((text, i) => ({ type: "TEXT", name: "t" + i, text, width: 320, height: 20 })),
      ...Array.from({ length: extra }, (_, i) => ({ type: "RECTANGLE", name: "deco" + i, width: 10, height: 10 }))] }],
});

test("simplify is recognised from the designer's words", () => {
  assert.equal(isSimplifyObjective("make this screen simplified"), true);
  assert.equal(isSimplifyObjective("too busy, declutter it"), true);
  assert.equal(isSimplifyObjective("add a loading state"), false);
});

test("simplify may drop secondary copy but never amounts, IDs or digits", () => {
  const prompt = "make this screen simplified";
  const lighter = plan(["Manage Loans", "Personal Loan", "DMI1234567890", "Overdue", "₹12,570", "Pay now"]);
  assert.deepEqual(missingSourceTexts(lighter, source, prompt), []);
  assert.ok(!auditDesignPlanQuality(lighter, source, prompt).findings.some((f) => f.code === "missing-source-content"));
  const lostAmount = plan(["Manage Loans", "Personal Loan", "DMI1234567890", "Overdue", "Pay now"]);
  assert.ok(auditDesignPlanQuality(lostAmount, source, prompt).findings.some((f) => f.code === "missing-source-content"));
  // Without the simplify objective every source string must stay, as before.
  assert.ok(missingSourceTexts(lighter, source, "improve this screen").length >= 4);
});

test("a simplify that keeps everything is flagged as a near copy", () => {
  const copy = plan(texts, 2);
  const report = auditDesignPlanQuality(copy, source, "make this screen simplified");
  assert.ok(report.findings.some((f) => f.code === "objective-not-met"));
  assert.ok(!auditDesignPlanQuality(copy, source, "improve this screen").findings.some((f) => f.code === "objective-not-met"));
});
