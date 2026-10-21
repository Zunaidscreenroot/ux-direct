import test from "node:test";
import assert from "node:assert/strict";
import { auditDesignPlanQuality } from "../src/figma-agent/design-plan-quality";
import { repairPlanGeometry } from "../src/figma-agent/normalize-plan";

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

test("does not reject FILL children using their pre-layout width", () => {
  const plan = goodPlan();
  const card = plan.elements[0];
  const fillChild = card.children[0];
  fillChild.width = card.width;
  (fillChild as Record<string, unknown>).layoutSizingHorizontal = "FILL";
  const report = auditDesignPlanQuality(plan, sourceCanvas, "Refine the selected Manage Loans screen");
  assert.equal(report.findings.some((finding) => finding.code === "child-out-of-bounds"), false,
    JSON.stringify(report.findings));
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

const hindiSourceCanvas = {
  nodes: [{
    type: "FRAME",
    name: "खाता विवरण",
    children: [
      { type: "TEXT", name: "Account title", text: "खाता विवरण" },
      { type: "TEXT", name: "Balance", text: "₹25,000" },
    ],
  }],
};

function simpleHindiPlan() {
  return {
    frame: {
      name: "Account",
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
      name: "Account content",
      x: 0,
      y: 0,
      width: 328,
      height: 160,
      color: "#252525",
      layoutMode: "VERTICAL",
      itemSpacing: 8,
      paddingLeft: 12,
      paddingRight: 12,
      paddingTop: 12,
      paddingBottom: 12,
      primaryAxisSizingMode: "FIXED",
      children: [{
        type: "TEXT",
        name: "Balance",
        x: 0,
        y: 0,
        width: 304,
        height: 20,
        text: "₹25,000",
        color: "#FFFFFF",
        fontSize: 14,
      }],
    }],
  };
}

test("detects dropped Devanagari source copy instead of normalizing it to an empty string", () => {
  const report = auditDesignPlanQuality(simpleHindiPlan(), hindiSourceCanvas, "Refine the selected account screen");
  assert.equal(report.passed, false);
  assert.ok(report.findings.some((finding) =>
    finding.code === "missing-source-content" && finding.message.includes("खाता विवरण")
  ), JSON.stringify(report.findings));
});

test("allows an explicitly requested removal of Devanagari source copy", () => {
  const report = auditDesignPlanQuality(simpleHindiPlan(), hindiSourceCanvas, "Remove खाता विवरण from this screen");
  assert.equal(report.findings.some((finding) => finding.code === "missing-source-content"), false,
    JSON.stringify(report.findings));
});


test("repairs overflowing loan-card Auto Layout geometry without removing source text", () => {
  const plan = {
    summary: "Repair the loan card layout",
    frame: { name: "Manage loans", width: 360, height: 800, backgroundColor: "#121212", layoutMode: "NONE" },
    elements: [{
      type: "FRAME", name: "Loan Card", x: 0, y: 0, width: 320, height: 180, color: "#252525",
      layoutMode: "VERTICAL", itemSpacing: 8, paddingLeft: 12, paddingRight: 12, paddingTop: 12, paddingBottom: 12,
      primaryAxisSizingMode: "FIXED",
      children: [
        {
          type: "FRAME", name: "Loan summary", x: 0, y: 0, width: 320, height: 70, noFill: true,
          layoutMode: "HORIZONTAL", itemSpacing: 4, paddingLeft: 16, paddingRight: 16, paddingTop: 8, paddingBottom: 8,
          primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "AUTO",
          children: [
            { type: "TEXT", name: "Loan label", x: 0, y: 0, width: 271, height: 18, text: "Outstanding loan balance", fontSize: 14, color: "#FFFFFF" },
            { type: "TEXT", name: "Loan amount", x: 0, y: 0, width: 271, height: 24, text: "₹1,07,649", fontSize: 20, color: "#FFFFFF" },
            { type: "FRAME", name: "Summary action", x: 0, y: 0, width: 271, height: 24, noFill: true, children: [] },
          ],
        },
        {
          type: "FRAME", name: "Loan-wise breakup", x: 0, y: 0, width: 320, height: 100, noFill: true,
          layoutMode: "VERTICAL", itemSpacing: 12, paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 16,
          primaryAxisSizingMode: "FIXED",
          children: [
            { type: "TEXT", name: "Breakup heading", x: 0, y: 0, width: 288, height: 18, text: "Loan-wise breakup", fontSize: 12, color: "#FFFFFF" },
            { type: "FRAME", name: "Breakup row 1", x: 0, y: 0, width: 288, height: 36, noFill: true, layoutMode: "HORIZONTAL", itemSpacing: 12, children: [
              { type: "TEXT", name: "Installment label", x: 0, y: 0, width: 280, height: 18, text: "Monthly installment", fontSize: 12, color: "#FFFFFF" },
              { type: "TEXT", name: "Installment amount", x: 0, y: 0, width: 280, height: 18, text: "₹12,000", fontSize: 12, color: "#FFFFFF" },
            ]},
            { type: "FRAME", name: "Breakup row 2", x: 0, y: 0, width: 288, height: 36, noFill: true, layoutMode: "HORIZONTAL", itemSpacing: 12, children: [
              { type: "TEXT", name: "Paid label", x: 0, y: 0, width: 280, height: 18, text: "Amount paid", fontSize: 12, color: "#FFFFFF" },
              { type: "TEXT", name: "Paid amount", x: 0, y: 0, width: 280, height: 18, text: "₹24,000", fontSize: 12, color: "#FFFFFF" },
            ]},
          ],
        },
        { type: "TEXT", name: "Loan status", x: 0, y: 0, width: 80, height: 14, text: "Current", fontSize: 10, color: "#FFFFFF" },
      ],
    }],
  };
  const repaired = repairPlanGeometry(plan) as typeof plan;
  const card = repaired.elements[0];
  const summary = card.children[0];
  const breakup = card.children[1];
  const firstRow = breakup.children[1];
  assert.equal(card.children.some(child => child.type === "TEXT" && child.text === "Current"), true);
  assert.ok(card.height > 180, "the parent card should grow to contain repaired nested content");
  assert.ok(summary.children.reduce((sum, child) => sum + child.width, 0) <= summary.width - summary.paddingLeft - summary.paddingRight - summary.itemSpacing * (summary.children.length - 1) + 2);
  assert.ok(breakup.height > 100, "the fixed-height breakdown should expand rather than clip its rows");
  assert.ok(firstRow.children.reduce((sum, child) => sum + child.width, 0) <= firstRow.width - firstRow.paddingLeft - firstRow.paddingRight - firstRow.itemSpacing * (firstRow.children.length - 1) + 2);
  assert.equal(summary.children.some(child => child.type === "TEXT" && child.text === "₹1,07,649"), true);
});
