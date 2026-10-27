import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FIGMA_AGENT_DEFAULT_MODEL, FIGMA_AGENT_MODELS, FIGMA_AGENT_QA_MODEL, OPENROUTER_MODELS, OPENROUTER_MODEL_LABELS, UX_DIRECT_DESIGN_ROLE } from "../src/providers/openrouter-models";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

test("general assistant chat exposes OpenRouter Auto as its only model option", () => {
  assert.deepEqual(OPENROUTER_MODELS, ["openrouter/auto"]);
  assert.deepEqual(OPENROUTER_MODEL_LABELS, ["OpenRouter Auto · low-cost routing"]);
  assert.ok(UX_DIRECT_DESIGN_ROLE.toLowerCase().includes("ui/ux designer"));
});

test("assistant chat uses one server-selected provider/model and applies OpenRouter-only routing options conditionally", () => {
  const source = read("app/api/assistant/chat/route.ts");
  const provider = read("src/providers/active-chat-provider.ts");
  assert.ok(source.includes("OPENROUTER_MODELS"), "OpenRouter remains available as the default");
  assert.ok(source.includes("const candidates = [model];"), "only one model route is attempted");
  assert.ok(source.includes("getResolvedActiveChatProvider"), "provider selection is resolved server-side");
  assert.ok(provider.includes("FREELLMAPI_API_KEY"), "FreeLLMAPI credentials are server-side");
  assert.ok(provider.includes("FREELLMAPI_BASE_URL"), "FreeLLMAPI uses a configured OpenAI-compatible base URL");
  assert.ok(source.includes("max_tokens: 25000"), "assistant chat requests 25,000 output tokens");
  assert.ok(source.includes('activeProvider.id === "openrouter"'), "OpenRouter-specific routing is conditionally applied");
  assert.ok(source.includes('plugins: [{ id: "auto-router", cost_tier: "low" }]'), "OpenRouter Auto keeps the low-cost tier");
  assert.ok(source.includes('provider: { sort: "throughput" }'), "OpenRouter Auto keeps throughput prioritization");
  assert.ok(!source.includes("FALLBACK_MODEL"), "there is no separate named-model fallback");
  assert.ok(!source.includes("OPENROUTER_MODELS.slice(2)"), "there is no additional candidate chain");
});

test("Figma routes use GPT-6 Luna as primary and OpenRouter Auto as low-cost fallback", () => {
  assert.deepEqual(FIGMA_AGENT_MODELS.map((entry) => entry.id), [
    "openai/gpt-6-luna",
    "openrouter/auto",
  ]);
  assert.equal(FIGMA_AGENT_DEFAULT_MODEL, "openai/gpt-6-luna");
  assert.equal(FIGMA_AGENT_QA_MODEL, "openai/gpt-6-luna");
  for (const path of [
    "app/api/assistant/figma-agent/route.ts",
    "app/api/assistant/figma-agent/review/route.ts",
    "app/api/assistant/figma-agent/refine/route.ts",
    "app/api/assistant/figma-agent/actions/route.ts",
  ]) {
    const source = read(path);
    assert.ok(source.includes("FIGMA_AGENT_MODELS"), path + " retains the shared OpenRouter chain");
    assert.ok(source.includes("getResolvedActiveChatProvider"), path + " uses the shared provider setting");
    assert.ok(source.includes('activeProvider.id === "openrouter"'), path + " gates OpenRouter behavior");
    assert.ok(source.includes('plugins: [{ id: "auto-router", cost_tier: "low" }]'), path + " pins OpenRouter Auto to the low-cost tier");
    assert.equal(source.includes("ANTHROPIC_OPENROUTER_PROVIDER"), false, path + " has no stale provider allowlist");
  }
});
