import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FIGMA_AGENT_MODELS, OPENROUTER_MODELS, OPENROUTER_MODEL_LABELS, UX_DIRECT_DESIGN_ROLE } from "../src/providers/openrouter-models";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

test("general assistant chat exposes OpenRouter Auto as its only model option", () => {
  assert.deepEqual(OPENROUTER_MODELS, ["openrouter/auto"]);
  assert.deepEqual(OPENROUTER_MODEL_LABELS, ["OpenRouter Auto · low-cost routing"]);
  assert.ok(UX_DIRECT_DESIGN_ROLE.toLowerCase().includes("ui/ux designer"));
});

test("assistant chat forces low-cost Auto routing, requests 25k output tokens, and has no named-model fallback", () => {
  const source = read("app/api/assistant/chat/route.ts");
  assert.ok(source.includes("OPENROUTER_MODELS"), "chat uses the single-model configuration");
  assert.ok(source.includes("const candidates = [ROUTER_MODEL];"), "only one model route is attempted");
  assert.ok(source.includes("max_tokens: 25000"), "assistant chat requests 25,000 output tokens");
  assert.ok(source.includes('plugins: [{ id: "auto-router", cost_tier: "low" }]'), "Auto Router uses the low-cost tier");
  assert.ok(source.includes('provider: { sort: "throughput" }'), "compatible endpoints are throughput-prioritized");
  assert.ok(!source.includes("FALLBACK_MODEL"), "there is no separate named-model fallback");
  assert.ok(!source.includes("OPENROUTER_MODELS.slice(2)"), "there is no additional candidate chain");
});

test("Figma routes use Auto LOW first and keep cost-ordered fallbacks", () => {
  assert.deepEqual(FIGMA_AGENT_MODELS.map((entry) => entry.id), [
    "openrouter/auto",
    "qwen/qwen3.5-35b-a3b",
    "google/gemini-3.1-flash-lite",
    "qwen/qwen3.5-397b-a17b",
  ]);
  for (const path of [
    "app/api/assistant/figma-agent/route.ts",
    "app/api/assistant/figma-agent/review/route.ts",
    "app/api/assistant/figma-agent/refine/route.ts",
    "app/api/assistant/figma-agent/actions/route.ts",
  ]) {
    const source = read(path);
    assert.ok(source.includes("FIGMA_AGENT_MODELS"), path + " uses the shared Figma chain");
    assert.ok(source.includes('plugins: [{ id: "auto-router", cost_tier: "low" }]'), path + " pins Auto to the low-cost tier");
    assert.equal(source.includes("ANTHROPIC_OPENROUTER_PROVIDER"), false, path + " has no stale provider allowlist");
  }
});
