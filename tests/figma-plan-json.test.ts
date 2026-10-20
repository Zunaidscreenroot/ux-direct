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
    model: "google/gemini-3.7-flash",
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: JSON.stringify(plan) },
    }],
  };
  assert.deepEqual(extractPlanJson(envelope), plan);
});

test("extracts plans from wrapped gateway and native Gemini candidate envelopes", () => {
  assert.deepEqual(extractPlanJson({
    data: { choices: [{ message: { content: JSON.stringify(plan) } }] },
  }), plan);
  assert.deepEqual(extractPlanJson({
    response: { candidates: [{ content: { parts: [{ text: JSON.stringify(plan) }] } }] },
  }), plan);
});

test("missing final content remains invalid and is handled by the route recovery path", () => {
  assert.equal(extractPlanJson({
    choices: [{ finish_reason: "unknown", message: { role: "assistant", reasoning: "thinking only" } }],
  }), null);
  const route = readFileSync(resolve(process.cwd(), "app/api/assistant/figma-agent/route.ts"), "utf8");
  assert.ok(route.includes("for (let recoveryAttempt = 0; recoveryAttempt < attemptsForModel; recoveryAttempt += 1)"));
  assert.ok(route.includes("const wasTruncated = finishReason === \"length\" || nativeFinishReason === \"length\""));
  assert.ok(route.includes("if (!isRecovery) continue;"), "Missing content and invalid schemas must cause a compact retry.");
  assert.ok(route.includes("compactRecoveryCanvas(canvas)"), "The retry should send a bounded source layer tree.");
  assert.ok(route.includes("28–42 native nodes total INCLUDING nested children"), "The retry must explicitly cap output complexity.");
  assert.ok(route.includes("max_tokens: isRecovery ? 6500 : 12000"), "Use OpenRouter's current completion token parameter.");
  assert.ok(route.includes('reasoning: { effort: isRecovery ? "minimal" : "low" }'), "Gemini reasoning must leave room for visible JSON output.");
  assert.ok(route.includes('model === "google/gemini-3.7-flash" ? {'), "Only Gemini receives the configured low-latency reasoning setting.");
  assert.ok(route.includes('...(!isRecovery ? { response_format: { type: "json_object" } } : {})'), "Compact retries should avoid repeating JSON-mode failures.");
  assert.ok(route.includes("payload_keys="), "Empty provider responses should report envelope shape for diagnosis.");
});

test("Figma agent uses explicit cost-ordered models without Auto or plugin live QA", () => {
  const route = readFileSync(resolve(process.cwd(), "app/api/assistant/figma-agent/route.ts"), "utf8");
  const catalog = readFileSync(resolve(process.cwd(), "src/providers/openrouter-models.ts"), "utf8");
  assert.ok(route.includes("const models = [...OPENROUTER_MODELS]"), "Generation should use the explicit shared model chain.");
  assert.ok(route.includes("const attemptsForModel = modelIndex === 0 ? 2 : 1"), "Retry the primary compactly once, then move to fallbacks.");
  assert.ok(route.includes('reasoning: { effort: isRecovery ? "minimal" : "low" }'), "Gemini reasoning should leave room for design JSON.");
  assert.ok(route.includes('model === "google/gemini-3.7-flash" ? {'), "Gemini 3.7 Flash is the explicit primary route.");
  assert.equal(route.includes('"openrouter/auto"'), false, "Design generation must never invoke OpenRouter Auto.");
  assert.ok(catalog.includes('id: "google/gemini-3.7-flash"'), "Gemini 3.7 Flash is the configured primary.");
  assert.ok(catalog.includes('FIGMA_AGENT_DEFAULT_MODEL: FigmaAgentModelId = "google/gemini-3.7-flash"'));
  assert.equal(catalog.includes('"openrouter/auto"'), false, "The shared agent catalog must not use Auto.");
  assert.equal(route.includes("Promise.all(models"), false, "Model requests must remain sequential.");

  const ui = readFileSync(resolve(process.cwd(), "figma-plugin/ui.html"), "utf8");
  assert.equal(ui.includes('fetch(API + "/api/assistant/figma-agent/live-qa"'), false, "The plugin must not run live browser QA.");
  assert.equal(ui.includes('fetch(API + "/api/assistant/figma-agent/refine"'), false, "The plugin must not invoke QA-based automatic repairs.");
  assert.equal(ui.includes("TinyFish"), false, "TinyFish should be removed from the plugin flow.");
});
