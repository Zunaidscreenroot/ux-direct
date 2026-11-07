import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicLeadNotes, inventedTexts, lostTexts, missingFromSpec, rubricScore, sourceContentTexts, taskOwner } from "../src/figma-agent/studio";
import { detectTaskRole } from "../src/figma-agent/agent-roles";

// The studio rules are generic standards: the same checks on screens from different domains.

test("e-commerce product grid: per-item prices in one action type, merged products count as lost", () => {
  const product = (name: string, price: string) => ({ name, surface: "card", blocks: [{ type: "text", text: name }, { type: "row", label: "Price", value: price }, { type: "button", label: "Add to cart · " + price }] });
  const grid = { sections: [product("Linen shirt", "$39"), product("Denim jacket", "$89"), product("Wool scarf", "$25")] };
  assert.equal(deterministicLeadNotes(grid).filter((note) => note.code === "primary").length, 0);
  const merged = { sections: [{ name: "Products", surface: "card", blocks: [{ type: "list", items: [{ label: "Linen shirt", value: "$39" }, { label: "Denim jacket", value: "$89" }, { label: "Wool scarf", value: "$25" }] }, { type: "button", label: "Add to cart" }] }] };
  assert.deepEqual(lostTexts(grid, merged).filter((text) => text === "Price").length, 3);
});

test("settings list: chevrons and avatar initials inside small marks are decoration", () => {
  const row = (label: string) => ({ type: "FRAME", width: 360, height: 56, children: [
    { type: "FRAME", name: "avatar", width: 32, height: 32, children: [{ type: "TEXT", text: "AB", width: 16, height: 14 }] },
    { type: "TEXT", text: label, width: 200, height: 20 }, { type: "TEXT", text: "›", width: 8, height: 20 }] });
  const read = sourceContentTexts([{ type: "FRAME", width: 360, height: 640, children: [row("Notifications"), row("Privacy"), row("Language")] }]);
  assert.deepEqual(read.content, ["Notifications", "Privacy", "Language"]);
  assert.equal(read.decorative.length, 6);
});

test("insurance claim form: missing field labels are high, invented helper copy is flagged", () => {
  const source = ["File a claim", "Policy number", "Date of incident", "Describe what happened", "Submit claim"];
  const spec = { sections: [{ blocks: [
    { type: "input", label: "Policy number" }, { type: "input", label: "Date of incident" },
    { type: "text", text: "We're here to help you every step of the way" }, { type: "button", label: "Submit claim" }] }] };
  assert.deepEqual(missingFromSpec(spec, source), ["File a claim", "Describe what happened"]);
  const notes = deterministicLeadNotes(spec, source);
  assert.ok(notes.some((note) => note.code === "missing" && note.severity === "high"));
  assert.deepEqual(inventedTexts(spec, source), ["We're here to help you every step of the way"]);
});

test("routing and rubric are domain-neutral", () => {
  for (const prompt of ["improve this checkout screen", "fix this patient dashboard", "create a variation of this course page"]) {
    assert.equal(taskOwner(detectTaskRole(prompt), prompt), "product-designer", prompt);
  }
  assert.equal(taskOwner(detectTaskRole("make a wireframe for a hotel booking flow"), "make a wireframe for a hotel booking flow"), "ux-designer");
  assert.equal(rubricScore({ 1: true, 2: true, 3: false, 4: true, 5: true, 6: true, 7: false, 8: true, 9: true, 10: false }), 70);
  assert.equal(rubricScore({ 1: true }), null);
});
