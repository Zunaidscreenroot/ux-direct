import test from "node:test";
import assert from "node:assert/strict";
import { buildFigmaFailureLesson } from "../src/memory/task-learning";

test("normalizes a stale Figma node error without retaining the node ID", () => {
  const lesson = buildFigmaFailureLesson("Node 123:456 not found on the active page.");
  assert.ok(lesson);
  assert.equal(lesson.category, "stale-node-id");
  assert.match(lesson.normalizedRule, /refresh the active page or selection/i);
  assert.doesNotMatch(lesson.rawFeedback, /123:456/);
  assert.doesNotMatch(lesson.rawFeedback, /not found on the active page/i);
});

test("normalizes expired command errors into a safe recovery rule", () => {
  const lesson = buildFigmaFailureLesson("Command cmd_ABC123 has expired and was no longer active.");
  assert.ok(lesson);
  assert.equal(lesson.category, "timeout-or-expired");
  assert.match(lesson.normalizedRule, /partially complete/i);
  assert.doesNotMatch(lesson.rawFeedback, /cmd_ABC123/i);
});

test("normalizes allowlist failures without storing the file key", () => {
  const lesson = buildFigmaFailureLesson("File key 0AbCDef0123456789 is not allowlisted.");
  assert.ok(lesson);
  assert.equal(lesson.category, "file-scope");
  assert.match(lesson.normalizedRule, /Never bypass the file allowlist/i);
  assert.doesNotMatch(lesson.rawFeedback, /0AbCDef0123456789/);
});

test("does not create brain lessons for uncategorized failures or ordinary messages", () => {
  assert.equal(buildFigmaFailureLesson("Network connection closed by peer."), null);
  assert.equal(buildFigmaFailureLesson("User asked for a blue button."), null);
});

test("uses only a normalized generic lesson and stable idempotency key", () => {
  const first = buildFigmaFailureLesson("Invalid payload: node 999 missing required field.");
  const second = buildFigmaFailureLesson("The command had an invalid payload and missed a required field.");
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.category, "invalid-payload");
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.doesNotMatch(first.rawFeedback, /999|node/i);
  assert.doesNotMatch(first.normalizedRule, /999|node 999/i);
});
