import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OPENROUTER_MODELS, UX_DIRECT_DESIGN_ROLE } from "../src/providers/openrouter-models";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

test("UX Direct prefers MiniMax M3.1 Flash free then unfiltered OpenRouter Auto", () => {
  assert.deepEqual(OPENROUTER_MODELS, [
    "minimax/minimax-m3.1-flash:free",
    "openrouter/auto",
  ]);
  assert.ok(OPENROUTER_MODELS[0].endsWith(":free"));
  assert.ok(UX_DIRECT_DESIGN_ROLE.toLowerCase().includes("ui/ux designer"));
});

test("chat, design generation, visual QA and refinement send no provider filters", () => {
  const paths = [
    "app/api/assistant/chat/route.ts",
    "app/api/assistant/figma-agent/route.ts",
    "app/api/assistant/figma-agent/review/route.ts",
    "app/api/assistant/figma-agent/refine/route.ts",
  ];
  for (const path of paths) {
    const source = read(path);
    assert.ok(source.includes("OPENROUTER_MODELS"), path + " uses the shared model order");
    assert.ok(source.includes("UX_DIRECT_DESIGN_ROLE"), path + " sets the UI/UX designer role");
    assert.equal(source.includes("ANTHROPIC_OPENROUTER_PROVIDER"), false, path + " has no Anthropic/provider allowlist");
    assert.equal(source.includes("allow_fallbacks"), false, path + " does not filter provider fallback behavior");
  }
});
