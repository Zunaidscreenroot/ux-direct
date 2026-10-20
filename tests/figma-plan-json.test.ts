import test from "node:test";
import assert from "node:assert/strict";
import { describeModelContent, extractPlanJson } from "../src/figma-agent/extract-plan-json";

const plan = {
  summary: "Improve loan balance hierarchy and make active status easier to scan.",
  frame: { name: "Manage loans — variation", width: 360, height: 800, backgroundColor: "#111111" },
  elements: [
    { type: "FRAME", name: "Loan summary", x: 0, y: 0, width: 320, height: 120 },
    { type: "FRAME", name: "Status", x: 0, y: 130, width: 320, height: 60 },
    { type: "FRAME", name: "Breakdown", x: 0, y: 200, width: 320, height: 180 },
    { type: "FRAME", name: "Actions", x: 0, y: 400, width: 320, height: 70 },
    { type: "FRAME", name: "Supporting detail", x: 0, y: 490, width: 320, height: 90 },
  ],
};

test("extracts a native plan from a JSON string", () => {
  assert.deepEqual(extractPlanJson(JSON.stringify(plan)), plan);
});

test("extracts a native plan from fenced JSON and explanatory preambles", () => {
  assert.deepEqual(extractPlanJson("Here is the design plan:\n\x60\x60\x60json\n" + JSON.stringify(plan) + "\n\x60\x60\x60"), plan);
  assert.deepEqual(extractPlanJson("Planning complete. " + JSON.stringify(plan) + " End."), plan);
});

test("extracts a native plan from Anthropic/OpenRouter text content blocks", () => {
  assert.deepEqual(extractPlanJson([
    { type: "thinking", thinking: "I should preserve the original hierarchy." },
    { type: "text", text: JSON.stringify(plan) },
  ]), plan);
});

test("extracts a native plan from a structured parsed response", () => {
  assert.deepEqual(extractPlanJson({ parsed: plan }), plan);
  assert.deepEqual(extractPlanJson({ content: [{ type: "output_text", text: JSON.stringify(plan) }] }), plan);
});

test("extracts a native plan from OpenAI-compatible tool call arguments", () => {
  assert.deepEqual(extractPlanJson({
    tool_calls: [{ type: "function", function: { name: "return_design_plan", arguments: JSON.stringify(plan) } }],
  }), plan);
});

test("balanced JSON parsing preserves braces inside text strings", () => {
  const special = { ...plan, summary: "Keep copy like {Outstanding balance} literal and readable." };
  assert.deepEqual(extractPlanJson("Model result:\n" + JSON.stringify(special)), special);
});

test("rejects null, missing plan fields, arrays and unparseable provider output", () => {
  assert.equal(extractPlanJson(null), null);
  assert.equal(extractPlanJson('{"summary":"not a full plan"}'), null);
  assert.equal(extractPlanJson("[1, 2, 3]"), null);
  assert.equal(extractPlanJson(""), null);
  assert.equal(extractPlanJson({ content: null }), null);
});

test("content diagnostics describe shape only, not model output", () => {
  assert.equal(describeModelContent(null), "null");
  assert.equal(describeModelContent('{"summary":"private design text"}'), "string(35 chars)");
  assert.equal(describeModelContent([{ type: "text" }, { type: "tool_use" }]), "array[text,tool_use]");
});
