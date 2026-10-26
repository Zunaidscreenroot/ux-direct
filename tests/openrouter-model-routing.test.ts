import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OPENROUTER_MODELS, OPENROUTER_MODEL_LABELS, UX_DIRECT_DESIGN_ROLE } from "../src/providers/openrouter-models";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

test("general assistant chat exposes OpenRouter Auto as its only model option", () => {
  assert.deepEqual(OPENROUTER_MODELS, ["openrouter/auto"]);
  assert.deepEqual(OPENROUTER_MODEL_LABELS, ["OpenRouter Auto · low-cost routing"]);
  assert.ok(UX_DIRECT_DESIGN_ROLE.toLowerCase().includes("ui/ux designer"));
});

test("assistant chat forces low-cost Auto routing, requests 25k output tokens, and has no named-model fallback", () => {
  const source = read("app/api/assistant/chat/route.ts");
  assert.ok(source.includes("OPENROUTER_MODELS"), "chat uses the single-model configuration");
  assert.ok(source.includes("const candidates = [model];"), "only one model route is attempted");
  assert.ok(source.includes("max_tokens: 25000"), "assistant chat requests 25,000 output tokens");
  assert.ok(source.includes("...llm.bodyExtras(allowList)"), "Auto Router options come from the shared provider module");
  assert.ok(read("src/providers/figma-llm.ts").includes('cost_tier: "low"'), "Auto Router uses the low-cost tier");
  assert.ok(source.includes('provider: { sort: "throughput" }'), "compatible endpoints are throughput-prioritized");
  assert.ok(!source.includes("FALLBACK_MODEL"), "there is no separate named-model fallback");
  assert.ok(!source.includes("OPENROUTER_MODELS.slice(2)"), "there is no additional candidate chain");
});

test("Figma routes use the shared provider module: OpenRouter auto (low cost) or FreeLLMAPI auto", () => {
  const helper = read("src/providers/figma-llm.ts");
  assert.ok(helper.includes('models: ["openrouter/auto"]'), "OpenRouter uses Auto only");
  assert.ok(helper.includes('env.FREELLMAPI_FIGMA_MODEL?.trim() || "auto"'), "FreeLLMAPI uses auto");
  assert.ok(helper.includes('cost_tier: "low"'), "OpenRouter Auto is pinned to the low-cost tier");
  for (const path of [
    "app/api/assistant/figma-agent/route.ts",
    "app/api/assistant/figma-agent/review/route.ts",
    "app/api/assistant/figma-agent/refine/route.ts",
    "app/api/assistant/figma-agent/actions/route.ts",
  ]) {
    const source = read(path);
    assert.ok(source.includes("buildFigmaLlmTarget") && source.includes("selectFigmaProvider"), path + " resolves the selected provider");
    assert.ok(source.includes("llm.bodyExtras("), path + " applies provider routing options");
    assert.equal(source.includes("ANTHROPIC_OPENROUTER_PROVIDER"), false, path + " has no stale provider allowlist");
  }
});
