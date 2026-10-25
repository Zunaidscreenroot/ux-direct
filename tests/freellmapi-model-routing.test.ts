import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FREELLMAPI_MODELS, FREELLMAPI_MODEL_LABELS, FIGMA_AGENT_DEFAULT_MODEL, FIGMA_AGENT_MODELS, FIGMA_AGENT_QA_MODEL, UX_DIRECT_DESIGN_ROLE } from "../src/providers/freellmapi-models";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

test("assistant chat exposes FreeLLMAPI Auto as its only model option", () => {
  assert.deepEqual(FREELLMAPI_MODELS, ["auto"]);
  assert.deepEqual(FREELLMAPI_MODEL_LABELS, ["FreeLLMAPI Auto · provider-managed routing"]);
  assert.ok(UX_DIRECT_DESIGN_ROLE.toLowerCase().includes("ui/ux designer"));
});

test("assistant chat calls the configured FreeLLMAPI endpoint and has no named-model fallback", () => {
  const source = read("app/api/assistant/chat/route.ts");
  assert.ok(source.includes("FREELLMAPI_MODELS"), "chat uses the FreeLLMAPI model configuration");
  assert.ok(source.includes("const candidates = [ROUTER_MODEL];"), "only one provider-managed model route is attempted");
  assert.ok(source.includes("max_tokens: 25000"), "assistant chat requests 25,000 output tokens");
  assert.ok(source.includes('const endpoint = baseUrl + "/chat/completions";'), "chat uses the configured gateway URL");
  assert.ok(source.includes("stream_options: { include_usage: true }"), "chat requests usage metadata on SSE streams");
  assert.ok(!source.includes("openrouter.ai"), "chat has no OpenRouter endpoint");
  assert.ok(!source.includes("FALLBACK_MODEL"), "there is no separate named-model fallback");
});

test("Figma generation, visual review, refinement and actions use FreeLLMAPI Auto", () => {
  assert.deepEqual(FIGMA_AGENT_MODELS.map((entry) => entry.id), ["auto"]);
  assert.equal(FIGMA_AGENT_DEFAULT_MODEL, "auto");
  assert.equal(FIGMA_AGENT_QA_MODEL, "auto");
  for (const path of [
    "app/api/assistant/figma-agent/route.ts",
    "app/api/assistant/figma-agent/review/route.ts",
    "app/api/assistant/figma-agent/refine/route.ts",
    "app/api/assistant/figma-agent/actions/route.ts",
  ]) {
    const source = read(path);
    assert.ok(source.includes("FIGMA_AGENT_MODELS"), path + " uses the shared FreeLLMAPI route");
    assert.ok(source.includes("FREELLMAPI_API_KEY"), path + " uses FreeLLMAPI credentials");
    assert.ok(source.includes('"/chat/completions"'), path + " uses an OpenAI-compatible chat endpoint");
    assert.ok(!source.includes("openrouter.ai"), path + " has no OpenRouter endpoint");
    assert.ok(!source.includes("auto-router"), path + " does not send OpenRouter-only plugins");
  }
});
