import test from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject } from "../src/figma-agent/extract-json-object";
import { normalizeVisualReview } from "../src/figma-agent/normalize-visual-review";

const review = {
  score: 68,
  summary: "The layout is improved but key loan values need clearer separation.",
  issues: [
    {
      severity: "high",
      issue: "Outstanding balance has insufficient visual emphasis",
      evidence: "The amount competes with the loan amount and secondary metadata.",
      fix: "Increase amount hierarchy and separate primary balance from metadata.",
    },
  ],
};

test("extracts JSON objects from plain, fenced and prefixed JSON text", () => {
  assert.deepEqual(extractJsonObject(JSON.stringify(review)), review);
  assert.deepEqual(extractJsonObject("Review:\n" + JSON.stringify(review) + "\nDone"), review);
  assert.deepEqual(extractJsonObject("\x60\x60\x60json\n" + JSON.stringify(review) + "\n\x60\x60\x60"), review);
});

test("extracts structured review from text blocks and parsed/tool-call payloads", () => {
  assert.deepEqual(extractJsonObject([{ type: "thinking", thinking: "Review hierarchy" }, { type: "text", text: JSON.stringify(review) }]), review);
  assert.deepEqual(extractJsonObject({ parsed: review }), review);
  assert.deepEqual(extractJsonObject({ tool_calls: [{ function: { arguments: JSON.stringify(review) } }] }), review);
});

test("normalizes common model aliases and strips unknown keys before strict schema validation", () => {
  const normalized = normalizeVisualReview({
    qualityScore: "71/100",
    overallAssessment: "Needs some hierarchy repairs.",
    findings: [
      {
        priority: "critical",
        title: "Status badge is hard to scan",
        observation: "Status text does not stand out from adjacent metadata.",
        recommendation: "Increase badge contrast and preserve its compact size.",
        extraProviderField: "ignored",
      },
    ],
    providerMetadata: { arbitrary: true },
  });
  assert.deepEqual(normalized, {
    issues: [{
      severity: "high",
      issue: "Status badge is hard to scan",
      evidence: "Status text does not stand out from adjacent metadata.",
      fix: "Increase badge contrast and preserve its compact size.",
    }],
    score: 71,
    summary: "Needs some hierarchy repairs.",
  });
});

test("rejects a review missing its score so the configured fallback model is tried", () => {
  assert.equal(normalizeVisualReview({ issues: [], summary: "No findings, but score missing." }), null);
  assert.deepEqual(normalizeVisualReview({ issues: [], score: 0, summary: "Review score was explicitly zero." }), {
    issues: [],
    score: 0,
    summary: "Review score was explicitly zero.",
  });
});

test("rejects a response without a recognizable issue array", () => {
  assert.equal(normalizeVisualReview({ score: 96, summary: "Looks good." }), null);
  assert.equal(extractJsonObject(null), null);
  assert.equal(extractJsonObject("[1,2]"), null);
});
