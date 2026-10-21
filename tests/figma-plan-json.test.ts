import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeModelContent, extractPlanJson } from "../src/figma-agent/extract-plan-json";
import { FIGMA_AGENT_MODELS } from "../src/providers/openrouter-models";

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
  assert.ok(route.includes("modelIndex === 0 ? 28000 : 22000"), "Auto LOW and fallbacks use the previous short attempt deadlines.");
  assert.ok(route.includes("at least 30% of all native nodes must be TEXT"), "Prompts require content-rich native layers.");
  assert.ok(route.includes('...(!isRecovery ? { response_format: { type: "json_object" } } : {})'), "Compact retries should avoid repeating JSON-mode failures.");
  assert.ok(route.includes("payload_keys="), "Empty provider responses should report envelope shape for diagnosis.");
});

test("Figma agent uses Auto LOW first, cost-ordered fallbacks, and no plugin live QA", () => {
  const route = readFileSync(resolve(process.cwd(), "app/api/assistant/figma-agent/route.ts"), "utf8");
  const catalog = readFileSync(resolve(process.cwd(), "src/providers/openrouter-models.ts"), "utf8");
  assert.ok(route.includes("const models = FIGMA_AGENT_MODELS.map((entry) => entry.id)"), "Generation uses the shared Figma-specific chain.");
  assert.ok(route.includes('plugins: [{ id: "auto-router", cost_tier: "low" }]'), "Figma generation explicitly uses Auto LOW.");
  assert.ok(route.includes("const attemptsForModel = modelIndex === 0 ? 2 : 1"), "The primary model gets one compact retry before the fallback is tried.");
  assert.ok(route.includes("provider returned an empty response body"), "Empty provider bodies are diagnosed clearly.");
  assert.ok(route.includes("provider returned a non-JSON response body"), "Invalid response bodies are diagnosed clearly.");
  assert.equal(route.includes("Promise.all(models"), false, "Model requests stay sequential.");
  assert.deepEqual(FIGMA_AGENT_MODELS.map((entry) => entry.id), ["openrouter/auto", "qwen/qwen3.5-35b-a3b", "google/gemini-3.1-flash-lite", "qwen/qwen3.5-397b-a17b"], "Auto LOW leads; named models are sequential fallbacks.");
  assert.ok(catalog.includes('FIGMA_AGENT_DEFAULT_MODEL: FigmaAgentModelId = "openrouter/auto"'));
  assert.ok(catalog.includes('FIGMA_AGENT_QA_MODEL: FigmaAgentModelId = "openrouter/auto"'));
  const review = readFileSync(resolve(process.cwd(), "app/api/assistant/figma-agent/review/route.ts"), "utf8");
  const refine = readFileSync(resolve(process.cwd(), "app/api/assistant/figma-agent/refine/route.ts"), "utf8");
  assert.ok(review.includes("FIGMA_AGENT_MODELS.map((entry) => entry.id)"));
  assert.ok(refine.includes("FIGMA_AGENT_MODELS.map((entry) => entry.id)"));

  const ui = readFileSync(resolve(process.cwd(), "figma-plugin/ui.html"), "utf8");
  assert.equal(ui.includes('fetch(API + "/api/assistant/figma-agent/live-qa"'), false, "The plugin must not run live browser QA.");
  assert.ok(ui.includes("async function runVisualQualityLoop"), "Visual QA must use the native screenshot/readback loop.");
  assert.ok(ui.includes('fetch(API + "/api/assistant/figma-agent/review"'), "The plugin must request evidence-based visual review.");
  assert.ok(ui.includes('fetch(API + "/api/assistant/figma-agent/refine"'), "A single bounded repair pass should use the surgical refiner.");
  assert.ok(ui.includes('reviewCanvas(outputCanvas, capture.dataUrl || null, "after one bounded repair")'), "A repair must be followed by one final visual re-check.");
  assert.ok(ui.includes("refinement.patch.slice(0, 12)"), "Repairs must remain bounded.");
  assert.equal(ui.includes("/api/assistant/figma-agent/live-qa"), false, "The plugin must not run browser QA.");
  assert.equal(ui.includes("TinyFish"), false, "TinyFish should be removed from the plugin flow.");
});

test("Figma agent routes report body-read timeouts instead of empty bodies and bound Qwen reasoning", () => {
  const route = readFileSync(resolve(process.cwd(), "app/api/assistant/figma-agent/route.ts"), "utf8");
  assert.equal(route.includes('response.text().catch(() => "")'), false, "An aborted body read must not be reported as an empty body.");
  assert.ok(route.includes("if (controller.signal.aborted) throw readError;"));
  assert.ok(route.includes("const generationDeadlineMs = 135000;"), "The sequential chain has a bounded 135-second deadline.");
  assert.ok(route.includes('model.startsWith("qwen/") ? { reasoning: isRecovery ? { enabled: false } : { effort: "low" } } : {}'));
  for (const name of ["refine", "review", "actions"]) {
    const sub = readFileSync(resolve(process.cwd(), "app/api/assistant/figma-agent/" + name + "/route.ts"), "utf8");
    assert.equal(sub.includes("await response.json().catch(() => null)"), false, name + " must not hide body-read timeouts.");
    assert.ok(sub.includes('model.startsWith("qwen/") ? { reasoning: { effort: "low" } } : {}'), name + " bounds Qwen reasoning.");
  }
});
