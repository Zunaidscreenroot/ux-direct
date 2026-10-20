import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OPENROUTER_MODELS, OPENROUTER_MODEL_LABELS, UX_DIRECT_DESIGN_ROLE } from "../src/providers/openrouter-models";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

test("UX Direct prefers Gemini 3.7 Flash and orders multimodal fallbacks by estimated cost", () => {
  assert.deepEqual(OPENROUTER_MODELS, [
    "google/gemini-3.7-flash",
    "qwen/qwen3.5-35b-a3b",
    "google/gemini-3.1-flash-lite",
    "qwen/qwen3.5-397b-a17b",
  ]);
  assert.deepEqual(OPENROUTER_MODEL_LABELS, [
    "Gemini 3.7 Flash · primary",
    "Qwen 3.5 35B-A3B · cheapest fallback",
    "Gemini 3.1 Flash Lite · low-cost multimodal fallback",
    "Qwen 3.5 397B-A17B · final quality fallback",
  ]);
  assert.ok(UX_DIRECT_DESIGN_ROLE.toLowerCase().includes("ui/ux designer"));
  assert.equal(OPENROUTER_MODELS.includes("openrouter/auto" as never), false);
});

test("homepage chat is separate; Figma routes use Auto LOW and price-ordered fallbacks", () => {
  for (const path of ["app/api/assistant/chat/route.ts"]) {
    const source = read(path);
    assert.ok(source.includes("OPENROUTER_MODELS"), path + " keeps the general chat model order");
    assert.ok(source.includes("UX_DIRECT_DESIGN_ROLE"), path + " uses the UX design role");
    assert.equal(source.includes('"openrouter/auto"'), false, path + " remains on the separate chat chain");
  }

  for (const path of [
    "app/api/assistant/figma-agent/route.ts",
    "app/api/assistant/figma-agent/review/route.ts",
    "app/api/assistant/figma-agent/refine/route.ts",
  ]) {
    const source = read(path);
    assert.ok(source.includes("FIGMA_AGENT_MODELS"), path + " uses the shared Auto-first Figma chain");
    assert.ok(source.includes('model === "openrouter/auto" ? { plugins: [{ id: "auto-router", cost_tier: "low" }] } : {}'),
      path + " constrains Auto to the LOW cost tier");
    assert.equal(source.includes("ANTHROPIC_OPENROUTER_PROVIDER"), false, path + " has no stale provider allowlist");
  }
});
