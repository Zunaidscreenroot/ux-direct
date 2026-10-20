import test from "node:test";
import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import { createLearningMarkerTransform, parseInlineLearningCandidate } from "../src/memory/inline-learning";

const candidate = {
  title: "Preserve existing design-system components",
  normalizedRule: "Reuse existing component variants before creating new ones.",
  rationale: "A repeatable design-system lesson extracted from task work.",
  scopeKey: "project:ux-direct",
  feedbackKind: "design_system",
  keywords: ["figma", "components", "variants"],
  originalLanguage: "English",
};

test("parses a bounded reusable learning candidate", () => {
  assert.deepEqual(parseInlineLearningCandidate(JSON.stringify(candidate)), candidate);
});

test("rejects invalid, confidential, or personally identifying candidates", () => {
  assert.equal(parseInlineLearningCandidate(JSON.stringify({ ...candidate, scopeKey: "other-project" })), null);
  assert.equal(parseInlineLearningCandidate(JSON.stringify({ ...candidate, normalizedRule: "Remember this API key: abcdefghijklmnopqrstuvwxyz." })), null);
  assert.equal(parseInlineLearningCandidate(JSON.stringify({ ...candidate, normalizedRule: "Use mobile 9876543210 in every customer example." })), null);
});

test("strips private markers from SSE text even when marker boundaries cross deltas", async () => {
  const extracted: unknown[] = [];
  const deltas = [
    "Keep reusable components consistent.\n<UXD_LEAR",
    "NING>" + JSON.stringify(candidate) + "</UXD_LEARNING>",
  ];
  const encoded = deltas.map((content) => new TextEncoder().encode(
    "data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\n\n",
  ));
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of encoded) controller.enqueue(chunk);
      controller.close();
    },
  });
  const filtered = source.pipeThrough(createLearningMarkerTransform((value) => extracted.push(value)));
  const reader = filtered.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
  }
  const output = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  assert.equal(extracted.length, 1);
  assert.deepEqual(extracted[0], candidate);
  assert.doesNotMatch(output, /UXD_LEARNING|Preserve existing design-system components/);
  assert.match(output, /Keep reusable components consistent\./);
});

test("does not create a candidate from an unrelated one-off response", () => {
  assert.equal(parseInlineLearningCandidate("The weather is sunny today."), null);
});

test("strips private markers from multimodal text-part deltas", async () => {
  const extracted: unknown[] = [];
  const content = [
    { type: "text", text: "Re-read the selected canvas before retrying.\n<UXD_" },
    { type: "text", text: "LEARNING>" + JSON.stringify(candidate) + "</UXD_LEARNING>" },
  ];
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        "data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\n\n",
      ));
      controller.close();
    },
  });
  const reader = source.pipeThrough(createLearningMarkerTransform((value) => extracted.push(value))).getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
  }
  const output = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  assert.equal(extracted.length, 1);
  assert.deepEqual(extracted[0], candidate);
  assert.doesNotMatch(output, /UXD_LEARNING|Preserve existing design-system components/);
});
