import test from "node:test";
import assert from "node:assert/strict";
import { compactRecentMessages, hasAssistantTextDelta } from "../src/providers/freellmapi-chat";

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

test("conversation compaction keeps the newest messages and stays within the configured character budget", () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: "message-" + index + "-" + "x".repeat(1200),
  }));
  const compact = compactRecentMessages(messages, { maxMessages: 8, maxTotalChars: 5000, maxMessageChars: 1500 });
  assert.equal(compact.length <= 8, true);
  assert.equal(compact.map((message) => message.content).join("").length <= 5000, true);
  assert.match(compact[compact.length - 1].content, /message-29-/);
});

test("conversation compaction preserves both the beginning and end of an oversized latest prompt", () => {
  const oversized = "beginning-of-brief " + "x".repeat(9000) + " ending-of-brief";
  const compact = compactRecentMessages([{ role: "user", content: oversized }], {
    maxMessages: 14,
    maxTotalChars: 22000,
    maxMessageChars: 3000,
  });
  assert.equal(compact.length, 1);
  assert.match(compact[0].content, /^beginning-of-brief/);
  assert.match(compact[0].content, /ending-of-brief$/);
  assert.ok(compact[0].content.length <= 3000);
});
