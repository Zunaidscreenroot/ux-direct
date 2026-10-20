import test from "node:test";
import assert from "node:assert/strict";
import {
  ANTHROPIC_OPENROUTER_MODELS,
  ANTHROPIC_OPENROUTER_PROVIDER,
} from "../src/providers/anthropic-openrouter";

test("UX Direct uses Anthropic-only Claude models through OpenRouter", () => {
  assert.deepEqual(ANTHROPIC_OPENROUTER_MODELS, [
    "anthropic/claude-sonnet-5.5",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-haiku-5.5",
  ]);
  assert.ok(ANTHROPIC_OPENROUTER_MODELS.every((model) => model.startsWith("anthropic/")));
  assert.deepEqual(ANTHROPIC_OPENROUTER_PROVIDER.only, ["anthropic"]);
  assert.equal(ANTHROPIC_OPENROUTER_PROVIDER.allow_fallbacks, false);
});

test("fast model fallback remains an Anthropic model, not provider auto-routing", () => {
  assert.equal(ANTHROPIC_OPENROUTER_MODELS[2], "anthropic/claude-haiku-5.5");
  assert.ok(ANTHROPIC_OPENROUTER_MODELS.every((model) => !model.includes("openrouter/auto")));
});
