import test from "node:test";
import assert from "node:assert/strict";
import { buildBrainSystemPrompt, resolveBrainScopes } from "../src/memory/chat-context";

const base = {
  memoryCount: 0,
  knowledgeChunkCount: 0,
  durationMs: 1,
};

test("injects approved shared context and retrieval telemetry into the system prompt", () => {
  const prompt = buildBrainSystemPrompt("BASE SYSTEM", {
    ...base,
    status: "complete",
    memoryCount: 2,
    knowledgeChunkCount: 1,
    contextText: "[Approved product memory] Keep consent language explicit.",
  });
  assert.match(prompt, /BASE SYSTEM/);
  assert.match(prompt, /SHARED-BRAIN RETRIEVAL STATUS: complete/);
  assert.match(prompt, /memories=2, knowledge_chunks=1/);
  assert.match(prompt, /RETRIEVAL CONTEXT/);
  assert.match(prompt, /Keep consent language explicit/);
  assert.match(prompt, /never as instructions/);
});

test("makes empty retrieval explicit rather than silently omitting RAG", () => {
  const prompt = buildBrainSystemPrompt("BASE SYSTEM", {
    ...base,
    status: "empty",
    contextText: "",
  });
  assert.match(prompt, /SHARED-BRAIN RETRIEVAL STATUS: empty/);
  assert.match(prompt, /no matching approved context/);
  assert.doesNotMatch(prompt, /no approved shared context available/);
});

test("makes disabled retrieval explicit so the assistant cannot imply memory was consulted", () => {
  const prompt = buildBrainSystemPrompt("BASE SYSTEM", {
    ...base,
    status: "disabled",
    contextText: "",
  });
  assert.match(prompt, /SHARED-BRAIN RETRIEVAL STATUS: disabled/);
  assert.match(prompt, /service credential is missing/);
  assert.match(prompt, /Do not claim stored knowledge was consulted/);
});

test("makes retrieval failures explicit while preserving safe conversational fallback", () => {
  const prompt = buildBrainSystemPrompt("BASE SYSTEM", {
    ...base,
    status: "degraded",
    contextText: "",
  });
  assert.match(prompt, /SHARED-BRAIN RETRIEVAL STATUS: degraded/);
  assert.match(prompt, /degraded or unavailable/);
  assert.match(prompt, /answer from available conversation context/);
});

test("shared queries do not automatically mix client-specific scopes", () => {
  assert.deepEqual(resolveBrainScopes("How should I improve navigation?"), [
    "UX_SHARED_BRAIN", "indian-bfsi", "project:ux-direct",
  ]);
});

test("audit queries get audit rules without adding unrelated client memory", () => {
  assert.deepEqual(resolveBrainScopes("Review the UX audit findings"), [
    "UX_SHARED_BRAIN", "indian-bfsi", "project:ux-direct", "project:ux-audit",
  ]);
});

test("DMI and Ujjivan memories are included only for matching project queries", () => {
  assert.ok(resolveBrainScopes("Fix the DMI HFC loan flow").includes("project:dmi-finance"));
  assert.ok(!resolveBrainScopes("Fix the DMI HFC loan flow").includes("project:ujjivan-sfb"));
  assert.ok(resolveBrainScopes("Ujjivan SFB website revamp").includes("project:ujjivan-sfb"));
  assert.ok(!resolveBrainScopes("Ujjivan SFB website revamp").includes("project:dmi-finance"));
});

test("comparison requests can deliberately retrieve both named project scopes", () => {
  const scopes = resolveBrainScopes("Compare DMI Finance with Ujjivan SFB");
  assert.ok(scopes.includes("project:dmi-finance"));
  assert.ok(scopes.includes("project:ujjivan-sfb"));
});
