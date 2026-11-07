import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  agencyConcurrency, agencyHandlesRole, assembleSpec, droppedTexts, groundDesignerSection, planWorkOrder, routeSection, SPECIALISTS,
} from "../src/figma-agent/agency";
import { detectTaskRole } from "../src/figma-agent/agent-roles";

const improve = detectTaskRole("improve this screen");

const text = (value: string) => ({ type: "TEXT", name: value, text: value, width: 100, height: 20 });
const frame = (name: string, children: unknown[], extra: Record<string, unknown> = {}) =>
  ({ type: "FRAME", name, width: 328, height: 80, children, ...extra });

const loanCanvas = {
  nodes: [frame("Manage loans", [
    { type: "INSTANCE", name: "App bar", width: 360, height: 56, children: [text("Manage loans")] },
    frame("Loan summary", [frame("r1", [text("Outstanding"), text("₹45,000")]), frame("r2", [text("EMI"), text("₹8,450")]), frame("r3", [text("Paid"), text("60%")])], { fillColors: ["#FFFFFF"] }),
    frame("Details", [frame("a", [text("Loan ID"), text("PL123")]), frame("b", [text("Tenure"), text("24 months")]), frame("c", [text("Status"), text("Current")])]),
    frame("Actions", [frame("btn", [text("Pay EMI")], { fillColors: ["#0B5FFF"], cornerRadius: 8, height: 48 })]),
  ], { width: 360, height: 800, fillColors: ["#F6F7F9"] })],
  components: [],
};

test("routing table: header kept, numbers → data-viz, buttons → interaction, inputs → form", () => {
  assert.equal(routeSection({ name: "Header", blocks: [{ type: "app_bar", title: "X" }] }, improve).id, "header");
  assert.equal(routeSection({ name: "Tabs", blocks: [{ type: "tabs", items: ["A", "B"] }] }, improve).id, "navigation");
  assert.equal(routeSection({ name: "Summary", blocks: [{ type: "row", label: "EMI", value: "₹8,450" }, { type: "row", label: "Paid", value: "60%" }] }, improve).id, "dataviz");
  assert.equal(routeSection({ name: "Actions", blocks: [{ type: "button", label: "Pay" }] }, improve).id, "interaction");
  assert.equal(routeSection({ name: "PAN", blocks: [{ type: "input", label: "PAN" }, { type: "checkbox", label: "Agree" }] }, improve).id, "form");
  assert.equal(routeSection({ name: "Loan details", blocks: [{ type: "list", items: [{ label: "Loan ID", value: "PL1" }] }] }, improve).id, "information");
  // A content task sends every non-structural section to the UX writer.
  assert.equal(routeSection({ name: "Summary", blocks: [{ type: "stat", value: "₹1" }] }, detectTaskRole("rewrite the copy")).id, "writer");
  assert.ok(SPECIALISTS.header.keepAsIs && SPECIALISTS.navigation.keepAsIs);
});

test("Director work order follows the source sections, in order, each with its own texts", () => {
  const order = planWorkOrder(loanCanvas, improve);
  assert.ok(order);
  assert.deepEqual(order.items.map((item) => item.designer.id), ["header", "dataviz", "information", "interaction"]);
  assert.ok(order.items[1].sourceTexts.includes("₹45,000"));
  assert.ok(!order.items[1].sourceTexts.includes("Loan ID"));
});

test("designer output is grounded: too many dropped texts → rejected, a few → restored", () => {
  const order = planWorkOrder(loanCanvas, improve)!;
  const item = order.items[2]; // Details: 6 texts
  assert.ok("error" in groundDesignerSection(item, { section: { blocks: [{ type: "text", text: "Loan ID" }] } }));
  const ok = groundDesignerSection(item, { section: { name: "Loan details", surface: "card", blocks: [
    { type: "list", items: [{ label: "Loan ID", value: "PL123" }, { label: "Tenure", value: "24 months" }, { label: "Status" }] },
  ] } });
  assert.ok(!("error" in ok));
  if (!("error" in ok)) {
    assert.equal(ok.restored, 1);
    assert.deepEqual(droppedTexts(item.sourceTexts, ok.section.blocks), []);
  }
  // An app bar inside a body section is another designer's job.
  assert.ok("error" in groundDesignerSection(item, { blocks: [{ type: "app_bar", title: "Loan ID PL123 Tenure 24 months Status Current" }] }));
});

test("assembly keeps screen order and merges split parts", () => {
  const order = planWorkOrder(loanCanvas, improve)!;
  const results = [...order.items].reverse().map((item) => ({ item, section: { name: item.name, blocks: item.source.blocks } }));
  const spec = assembleSpec(order, results, "s");
  assert.deepEqual((spec.sections as Array<{ name: string }>).map((s) => s.name), order.items.map((item) => item.name));
});

test("concurrency stays under the Worker's 6 connections; roles and route wiring", () => {
  assert.ok(agencyConcurrency() >= 1 && agencyConcurrency() <= 6);
  assert.equal(agencyHandlesRole(detectTaskRole("change the theme to dark mode")), false);
  assert.equal(agencyHandlesRole(improve), true);
  const route = readFileSync(resolve(__dirname, "../app/api/assistant/figma-agent/route.ts"), "utf8");
  assert.match(route, /agencyEnabled\(\) && blockMode && !createMode/);
  assert.match(route, /agency: agencyReport/);
  // The agency runs before the monolithic planner, which stays the fallback.
  assert.ok(route.indexOf("runAgency(canvas") < route.indexOf("modelLoop: for"));
});
