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
    "qwen/qwen3.5-397b-a17b",
    "google/gemini-3.5-flash-lite",
  ]);
  assert.deepEqual(OPENROUTER_MODEL_LABELS, [
    "Gemini 3.7 Flash · primary",
    "Qwen 3.5 35B-A3B · cheapest fallback",
    "Qwen 3.5 397B-A17B · quality fallback",
    "Gemini 3.5 Flash Lite · final fallback",
  ]);
  assert.ok(UX_DIRECT_DESIGN_ROLE.toLowerCase().includes("ui/ux designer"));
  assert.equal(OPENROUTER_MODELS.includes("openrouter/auto" as never), false);
});

test("chat, design generation, visual QA and refinement use the shared explicit model chain", () => {
  const paths = [
    "app/api/assistant/chat/route.ts",
    "app/api/assistant/figma-agent/route.ts",
    "app/api/assistant/figma-agent/review/route.ts",
    "app/api/assistant/figma-agent/refine/route.ts",
  ];
  for (const path of paths) {
    const source = read(path);
    assert.ok(source.includes("OPENROUTER_MODELS"), path + " uses the shared model order");
    assert.ok(source.includes("UX_DIRECT_DESIGN_ROLE"), path + " uses the UI/UX designer role");
    assert.equal(source.includes('"openrouter/auto"'), false, path + " never invokes OpenRouter Auto");
    assert.equal(source.includes("ANTHROPIC_OPENROUTER_PROVIDER"), false, path + " has no provider allowlist");
  }
});
