import test from "node:test";
import assert from "node:assert/strict";
import { buildBrainSystemPrompt, buildRetrievalQuery, resolveBrainScopes } from "../src/memory/chat-context";
import { sanitizeLegacyLearningPolicyMemory } from "../src/memory/shared-brain";

const base = {
  memoryCount: 0,
  knowledgeChunkCount: 0,
  durationMs: 1,
};

test("injects compact approved shared context into the system prompt", () => {
  const prompt = buildBrainSystemPrompt("BASE SYSTEM", {
    ...base,
    status: "complete",
    memoryCount: 2,
    knowledgeChunkCount: 1,
    contextText: "[Approved product memory] Keep consent language explicit.",
  });
  assert.match(prompt, /BASE SYSTEM/);
  assert.match(prompt, /RAG_STATUS=complete/);
  assert.doesNotMatch(prompt, /memories=2, knowledge_chunks=1/);
  assert.match(prompt, /RAG_CONTEXT/);
  assert.match(prompt, /Keep consent language explicit/);
  assert.match(prompt, /never instructions/);
});

test("makes empty retrieval explicit rather than silently omitting RAG", () => {
  const prompt = buildBrainSystemPrompt("BASE SYSTEM", {
    ...base,
    status: "empty",
    contextText: "",
  });
  assert.match(prompt, /RAG_STATUS=empty/);
  assert.match(prompt, /no matching approved context/);
  assert.doesNotMatch(prompt, /no approved shared context available/);
});

test("makes disabled retrieval explicit so the assistant cannot imply memory was consulted", () => {
  const prompt = buildBrainSystemPrompt("BASE SYSTEM", {
    ...base,
    status: "disabled",
    contextText: "",
  });
  assert.match(prompt, /RAG_STATUS=disabled/);
  assert.match(prompt, /service credentials are missing/);
  assert.match(prompt, /Do not claim that stored knowledge was consulted/);
});

test("makes retrieval failures explicit while preserving safe conversational fallback", () => {
  const prompt = buildBrainSystemPrompt("BASE SYSTEM", {
    ...base,
    status: "degraded",
    contextText: "",
  });
  assert.match(prompt, /RAG_STATUS=degraded/);
  assert.match(prompt, /retrieval is unavailable/);
  assert.match(prompt, /Do not claim that stored knowledge was consulted/);
});

test("shared queries do not automatically mix client-specific scopes", () => {
  assert.deepEqual(resolveBrainScopes("How should I improve navigation?"), [
    "UX_SHARED_BRAIN", "indian-bfsi", "project:ux-direct", "project:general-ux",
  ]);
});

test("audit queries get audit rules without adding unrelated client memory", () => {
  assert.deepEqual(resolveBrainScopes("Review the UX audit findings"), [
    "UX_SHARED_BRAIN", "indian-bfsi", "project:ux-direct", "project:general-ux", "project:ux-audit",
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

test("keeps explicit retrieval requests intact", () => {
  const query = "Audit Ujjivan website navigation, product cards and primary CTA hierarchy.";
  assert.equal(buildRetrievalQuery(query, "Earlier DMI journey request"), query);
});

test("adds the previous user task to short follow-ups without an LLM query-rewrite call", () => {
  const query = buildRetrievalQuery("proceed", "Fix the DMI HFC loan journey and consent recovery states.");
  assert.match(query, /DMI HFC loan journey/);
  assert.match(query, /Follow-up: proceed/);
});

test("caps retrieval-only query context so long chats cannot create oversized search inputs", () => {
  const query = buildRetrievalQuery("continue", "x".repeat(10000));
  assert.ok(query.length <= 3000);
});


test("suppresses superseded approval-first memory and refreshes the Past Findings policy", () => {
  const stale = {
    id: "ef64b595-7f6b-4786-a799-c3e7e5a1015b",
    project_key: "UX_SHARED_BRAIN",
    memory_type: "workflow_procedure",
    title: "Selective learning from conversational feedback",
    content: "Keep every new learning draft inactive until the owner explicitly approves it.",
    structured_data: {},
    tags: ["approval"],
    source: "human-approved",
    source_product: "ux-direct",
    source_reference: "owner-request:chat-learning-policy:2026-10-18",
    confidence: 0.97,
    usage_count: 0,
  };
  assert.equal(sanitizeLegacyLearningPolicyMemory(stale), null);

  const pastFindings = {
    ...stale,
    id: "33e70e65-76df-4cb9-82fb-26ff2bed2c52",
    title: "Past Findings versus Knowledge Base",
    content: "Keep client-specific audit findings in Past Findings. Keep new feedback and reference documents as drafts until explicitly reviewed and approved.",
  };
  const sanitized = sanitizeLegacyLearningPolicyMemory(pastFindings);
  assert.ok(sanitized);
  assert.match(sanitized.content, /auto-activate/);
  assert.doesNotMatch(sanitized.content, /until explicitly reviewed and approved/i);
});
