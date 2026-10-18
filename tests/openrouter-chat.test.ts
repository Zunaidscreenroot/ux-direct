import test from "node:test";
import assert from "node:assert/strict";
import { collectFreeModelCandidates, hasAssistantTextDelta, isFreeModelId } from "../src/providers/openrouter-chat";

test("accepts only explicit free-tier model IDs", () => {
  assert.equal(isFreeModelId("google/gemma-4-31b-it:free"), true);
  assert.equal(isFreeModelId("openai/gpt-4o-mini"), false);
  assert.equal(isFreeModelId("openrouter/auto"), false);
});

test("free model candidate selection is ordered, unique, and capped", () => {
  assert.deepEqual(
    collectFreeModelCandidates("google/gemma-4-31b-it:free", ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "openai/gpt-4o"], [
      "google/gemma-4-31b-it:free",
      "qwen/qwen3.8-27b:free",
    ], 3),
    [
      "google/gemma-4-31b-it:free",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      "qwen/qwen3.8-27b:free",
    ],
  );
});

test("recognizes non-empty string and text-part SSE deltas", () => {
  assert.equal(hasAssistantTextDelta('data: {"choices":[{"delta":{"content":"Hello"}}]}'), true);
  assert.equal(hasAssistantTextDelta('data: {"choices":[{"delta":{"content":[{"type":"text","text":"Hello"}]}}]}'), true);
});

test("ignores empty deltas, reasoning-only events, done markers, and malformed frames", () => {
  assert.equal(hasAssistantTextDelta('data: {"choices":[{"delta":{"content":""}}]}'), false);
  assert.equal(hasAssistantTextDelta('data: {"choices":[{"delta":{"reasoning":"thinking"}}]}'), false);
  assert.equal(hasAssistantTextDelta("data: [DONE]"), false);
  assert.equal(hasAssistantTextDelta("data: {not-json"), false);
});
