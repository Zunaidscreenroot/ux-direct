import test from "node:test";
import assert from "node:assert/strict";
import { readableProviderError } from "../src/figma-agent/json-model-call";

test("provider errors reach the designer as one readable line, never raw JSON", () => {
  const gemini = '[{\n  "error": {\n    "code": 429,\n    "message": "You exceeded your current quota, please check your plan and billing details.",\n    "status": "RESOURCE_EXHAUSTED"\n  }\n}]';
  assert.equal(readableProviderError(gemini), "rate limited (free quota used up)");
  assert.equal(readableProviderError("model not found"), "model not found");
});
