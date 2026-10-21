import test from "node:test";
import assert from "node:assert/strict";
import { auditDesignPlanQuality } from "../src/figma-agent/design-plan-quality";

const sourceCanvas = {
  nodes: [{
    type: "FRAME",
    name: "Manage Loans",
    text: "",
    children: [
      { type: "TEXT", name: "Title", text: "Manage Loans" },
      { type: "TEXT", name: "Loan Type", text: "Personal Loan" },
      { type: "TEXT", name: "Reference", text: "DMI1234567890" },
      { type: "TEXT", name: "Status", text: "Current" },
      { type: "TEXT", name: "Loan Amount", text: "₹12,000" },
      { type: "TEXT", name: "Outstanding", text: "₹1,07,649" },
      { type: "TEXT", name: "CTA", text: "Pay now" },
    ],
  }],
};

function goodPlan() {
  const labels = [
    "Manage Loans",
    "Personal Loan",
    "DMI1234567890",
    "Current",
    "₹12,000",
    "₹1,07,649",
    "Pay now",
  ];
  return {
    frame: {
      name: "Manage Loans — Refined",
      width: 360,
      height: 800,
      backgroundColor: "#121212",
      layoutMode: "NONE",
      itemSpacing: 0,
      paddingLeft: 16,
      paddingRight: 16,
      paddingTop: 16,
      paddingBottom: 16,
      primaryAxisSizingMode: "FIXED",
      counterAxisSizingMode: "FIXED",
    },
    elements: [{
      type: "FRAME",
      name: "Loan Card",
      x: 0,
      y: 0,
      width: 328,
      height: 250,
      color: "#252525",
      layoutMode: "VERTICAL",
      itemSpacing: 8,
      paddingLeft: 12,
      paddingRight: 12,
      paddingTop: 12,
      paddingBottom: 12,
      primaryAxisSizingMode: "FIXED",
      children: labels.map((text, index) => ({
        type: "TEXT",
        name: "Loan detail " + index,
        x: 0,
        y: 0,
        width: 304,
        height: 20,
        text,
        color: "#FFFFFF",
        fontSize: 14,
      })),
    }],
  };
}

test("passes a complete source-faithful design with readable contrast and valid sizing", () => {
  const report = auditDesignPlanQuality(goodPlan(), sourceCanvas, "Refine the selected Manage Loans screen");
  assert.equal(report.passed, true, JSON.stringify(report.findings));
  assert.equal(report.findings.length, 0);
});

test("blocks missing source values, overflowing Auto Layout and unreadable text before canvas writes", () => {
  const plan = goodPlan();
  const card = plan.elements[0];
  card.height = 80;
  card.color = "#FFFFFF";
  card.children = card.children.slice(0, 3).map((child) => ({ ...child, color: "#FFFFFF", height: 24 }));
  const report = auditDesignPlanQuality(plan, sourceCanvas, "Refine the selected Manage Loans screen");
  assert.equal(report.passed, false);
  assert.ok(report.findings.some((finding) => finding.code === "missing-source-content"));
  assert.ok(report.findings.some((finding) => finding.code === "fixed-layout-overflow"));
  assert.ok(report.findings.some((finding) => finding.code === "low-contrast"));
});

test("allows removing a specifically named source label when explicitly requested", () => {
  const plan = goodPlan();
  plan.elements[0].children = plan.elements[0].children.filter((child) => child.text !== "Pay now");
  const report = auditDesignPlanQuality(plan, sourceCanvas, "Remove Pay now from this screen");
  assert.equal(report.findings.some((finding) => finding.code === "missing-source-content"), false);
});
