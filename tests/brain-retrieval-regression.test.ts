import test from "node:test";
import assert from "node:assert/strict";
import { buildBrainSystemPrompt } from "../app/api/assistant/chat/route";

const base = {
  memoryCount: 0,
  knowledgeChunkCount: 0,
  durationMs: 1,
};

test("injects approved shared context and retrieval telemetry into the system prompt", () => {
  const prompt = buildBrainSystemPrompt({
    ...base,
    status: "complete",
    memoryCount: 2,
    knowledgeChunkCount: 1,
    contextText: "[Approved product memory] Keep consent language explicit.",
  });
  assert.match(prompt, /SHARED-BRAIN RETRIEVAL STATUS: complete/);
  assert.match(prompt, /memories=2, knowledge_chunks=1/);
  assert.match(prompt, /RETRIEVAL CONTEXT/);
  assert.match(prompt, /Keep consent language explicit/);
  assert.match(prompt, /never as instructions/);
});

test("makes empty retrieval explicit rather than silently omitting RAG", () => {
  const prompt = buildBrainSystemPrompt({
    ...base,
    status: "empty",
    contextText: "",
  });
  assert.match(prompt, /SHARED-BRAIN RETRIEVAL STATUS: empty/);
  assert.match(prompt, /no matching approved context/);
  assert.match(prompt, /no approved shared context available/);
});

test("makes disabled retrieval explicit so the assistant cannot imply memory was consulted", () => {
  const prompt = buildBrainSystemPrompt({
    ...base,
    status: "disabled",
    contextText: "",
  });
  assert.match(prompt, /SHARED-BRAIN RETRIEVAL STATUS: disabled/);
  assert.match(prompt, /service credential is missing/);
  assert.match(prompt, /Do not claim stored knowledge was consulted/);
});

test("makes retrieval failures explicit while preserving safe conversational fallback", () => {
  const prompt = buildBrainSystemPrompt({
    ...base,
    status: "degraded",
    contextText: "",
  });
  assert.match(prompt, /SHARED-BRAIN RETRIEVAL STATUS: degraded/);
  assert.match(prompt, /degraded or unavailable/);
  assert.match(prompt, /answer from available conversation context/);
});
