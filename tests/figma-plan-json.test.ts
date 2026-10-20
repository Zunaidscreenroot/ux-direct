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

test("Figma generation uses only OpenRouter Auto LOW and never fans out to separate models", () => {
  const route = readFileSync(resolve(process.cwd(), "app/api/assistant/figma-agent/route.ts"), "utf8");
  const catalog = readFileSync(resolve(process.cwd(), "src/providers/openrouter-models.ts"), "utf8");
  assert.ok(route.includes("const models = [FIGMA_AGENT_DEFAULT_MODEL]"), "Only one OpenRouter Auto route should run.");
  assert.equal(route.includes("FIGMA_AGENT_FALLBACK_MODELS"), false, "Generation must not call separate model fallbacks.");
  assert.ok(route.includes('model === "openrouter/auto" ? { plugins: [{ id: "auto-router", cost_tier: "low" }] } : {}'), "Auto must use the LOW tier.");
  assert.ok(route.includes("const attemptsForModel = 2"), "Only one compact retry is allowed after a failed first attempt.");
  assert.ok(route.includes("const isRecovery = recoveryAttempt === 1"), "The retry must target the same Auto route.");
  assert.equal(route.includes("Promise.all(models"), false, "Model calls must never run in parallel.");
  assert.ok(catalog.includes('id: "openrouter/auto"'), "Auto is the only selectable Figma design model.");
  assert.ok(catalog.includes('FIGMA_AGENT_QA_MODEL: FigmaAgentModelId = "openrouter/auto"'), "QA uses the same LOW-cost Auto route.");
  assert.equal(catalog.includes("FIGMA_AGENT_FALLBACK_MODELS"), false, "No app-level Figma model fallback catalog should remain.");
  const ui = readFileSync(resolve(process.cwd(), "figma-plugin/ui.html"), "utf8");
  assert.equal(ui.includes('id="designModel"'), false, "The model dropdown must be removed.");
  assert.equal(ui.includes("model-picker"), false, "No model selector styling should remain.");
  assert.ok(ui.includes("OpenRouter Auto · LOW cost tier"), "The fixed route should be shown as a non-interactive label.");
  assert.equal(ui.includes("model: selectedModel"), false, "The UI must not offer model overrides.");
  assert.equal(ui.includes('fetch(API + "/api/assistant/figma-agent/refine"'), false, "Automatic refinement stays disabled.");
  assert.equal(ui.includes("for (let iteration = 1; iteration <= 2; iteration++)"), false, "Visual QA must run once.");
});
