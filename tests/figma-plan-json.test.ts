import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  assert.match(describeModelContent('{"summary":"private design text"}'), /^string\(\d+ chars\)$/);
  assert.equal(describeModelContent([{ type: "text" }, { type: "tool_use" }]), "array[text,tool_use]");
});

test("extracts a native plan from the full OpenRouter chat-completions envelope", () => {
  const envelope = {
    id: "gen-test",
    model: "minimax/minimax-m3.1-flash:free",
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: JSON.stringify(plan) },
    }],
  };
  assert.deepEqual(extractPlanJson(envelope), plan);
});

test("missing final content remains invalid and is handled by the route recovery path", () => {
  assert.equal(extractPlanJson({
    choices: [{ finish_reason: "unknown", message: { role: "assistant", reasoning: "thinking only" } }],
  }), null);
  const route = readFileSync(resolve(process.cwd(), "app/api/assistant/figma-agent/route.ts"), "utf8");
  assert.ok(route.includes("for (let recoveryAttempt = 0; recoveryAttempt < 2; recoveryAttempt += 1)"));
  assert.ok(route.includes("const wasTruncated = finishReason === \"length\" || nativeFinishReason === \"length\""));
  assert.ok(route.includes("if (!isRecovery) continue;"), "Missing content and invalid schemas must cause a compact retry.");
  assert.ok(route.includes("compactRecoveryCanvas(canvas)"), "The retry should send a bounded source layer tree.");
  assert.ok(route.includes("18–26 native nodes total INCLUDING all nested children"), "The retry must explicitly cap output complexity.");
});

test("compact recovery is model-agnostic and does not add OpenRouter provider filters", () => {
  const route = readFileSync(resolve(process.cwd(), "app/api/assistant/figma-agent/route.ts"), "utf8");
  const models = readFileSync(resolve(process.cwd(), "src/providers/openrouter-models.ts"), "utf8");
  assert.ok(route.includes("const models = OPENROUTER_MODELS;"));
  assert.ok(models.includes('"minimax/minimax-m3.1-flash:free"'));
  assert.ok(models.includes('"openrouter/auto"'));
  assert.equal(route.includes("provider: {"), false);
  assert.equal(route.includes("plugins: [{ id: \"auto-router\""), false);
});
