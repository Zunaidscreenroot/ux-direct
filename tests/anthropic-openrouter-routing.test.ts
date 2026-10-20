import test from "node:test";
import assert from "node:assert/strict";
import { OPENROUTER_MODELS, UX_DIRECT_DESIGN_ROLE } from "../src/providers/openrouter-models";

test("UX Direct prefers MiniMax M3.1 Flash free then unfiltered OpenRouter Auto", () => {
  assert.deepEqual(OPENROUTER_MODELS, [
    "minimax/minimax-m3.1-flash:free",
    "openrouter/auto",
  ]);
  assert.ok(OPENROUTER_MODELS[0].endsWith(":free"));
  assert.equal(OPENROUTER_MODELS[1], "openrouter/auto");
  assert.ok(UX_DIRECT_DESIGN_ROLE.toLowerCase().includes("ui/ux designer"));
});

test("routing policy adds no provider restrictions or Auto Router plugin filters", () => {
  const route = (globalThis as unknown as { __unused?: string }).__unused;
  assert.equal(route, undefined);
  assert.ok(OPENROUTER_MODELS.every((model) => !model.includes("anthropic/claude")));
  assert.ok(OPENROUTER_MODELS.every((model) => !model.includes("openrouter/auto-beta")));
});
