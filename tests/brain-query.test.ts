import test from "node:test";
import assert from "node:assert/strict";
import { buildBrainQuery } from "../src/memory/brain-query";

test("brain query uses prompt, frame and meaningful labels, not canvas JSON", () => {
  const nodes = [{ id: "12:34", type: "FRAME", name: "Loan dashboard", x: 0, y: 0, fills: [{ color: "#FFFFFF" }], children: [
    { id: "12:35", type: "FRAME", name: "Frame 27", children: [
      { id: "12:36", type: "TEXT", name: "Title", text: "Personal Loan" },
      { id: "12:37", type: "TEXT", name: "Amount", text: "₹8,450" },
      { id: "12:38", type: "TEXT", name: "Pay", text: "Pay EMI" },
      { id: "12:39", type: "TEXT", name: "Again", text: "Personal Loan" },
    ] },
    { id: "12:40", type: "INSTANCE", name: "Bottom nav" },
  ] }];
  const query = buildBrainQuery({ prompt: "Improve hierarchy", frameName: "Home", designScope: "selected_screen_or_frame", nodes });
  assert.ok(query.startsWith("Improve hierarchy\nScreen: Home\nScope: selected screen or frame"));
  assert.ok(query.includes("Layers: Loan dashboard, Bottom nav"));
  assert.ok(query.includes("Text: Personal Loan, Pay EMI"));
  for (const noise of ["12:34", "#FFFFFF", "Frame 27", "₹8,450", "fills"]) assert.ok(!query.includes(noise), "noise " + noise);
  assert.equal(query.split("Personal Loan").length, 2, "texts are deduplicated");
});
