import test from "node:test";
import assert from "node:assert/strict";
import { buildBrainMonitorReport } from "../src/memory/brain-monitor";

const now = Date.parse("2026-11-06T12:00:00Z");

test("aggregates outcomes, retrieval, learning and stuck runs without leaking text", () => {
  const report = buildBrainMonitorReport([
    { outcome: "verified", duration_ms: 1000, retrieval: { status: "complete", memoryIds: ["a", "b"], chunkIds: ["c"] },
      lesson: { status: "stored", content: "SECRET lesson text" }, metadata: { source: "figma-agent", model: "glm" }, plan: { x: 1 },
      created_at: "2026-11-06T11:00:00Z", updated_at: "2026-11-06T11:00:00Z" },
    { outcome: "failed", duration_ms: 3000, retrieval: { status: "empty", memoryIds: [], chunkIds: [] }, lesson: null,
      metadata: { source: "figma-agent", model: "source-fallback" }, created_at: "2026-11-01T11:00:00Z", updated_at: "2026-11-01T11:00:00Z" },
    { outcome: "attempted", retrieval: { status: "complete", memoryIds: ["a"] }, updated_at: "2026-11-06T10:00:00Z", created_at: "2026-11-06T10:00:00Z" },
  ], now);
  assert.deepEqual(report.outcomes, { verified: 1, failed: 1, attempted: 1 });
  assert.deepEqual(report.bySource, { "figma-agent": { verified: 1, failed: 1 }, unknown: { attempted: 1 } });
  assert.equal(report.stuckAttempted, 1);
  assert.equal(report.retrieval.zeroMemoryRuns, 1);
  assert.equal(report.retrieval.avgMemories, 1);
  assert.deepEqual(report.learning.byLessonStatus, { stored: 1, none: 1 });
  assert.equal(report.learning.lessonRate, 0.5);
  assert.equal(report.examples.verifiedWithPlan, 1);
  assert.equal(report.examples.sourceFallbackRuns, 1);
  assert.deepEqual(report.last24h, { runs: 2, verified: 1, failed: 0 });
  assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});
