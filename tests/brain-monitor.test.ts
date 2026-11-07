import test from "node:test";
import assert from "node:assert/strict";
import { buildBrainMonitorReport, classifyFailureReason } from "../src/memory/brain-monitor";

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

test("accepts Date timestamps from the Postgres driver", () => {
  const at = new Date("2026-11-06T11:30:00Z");
  const report = buildBrainMonitorReport([{ outcome: "verified", created_at: at, updated_at: at }], now);
  assert.equal(report.last24h.runs, 1);
  assert.equal(report.lastRunAt, at.toISOString());
});

test("buckets failure reasons without returning raw text", () => {
  const report = buildBrainMonitorReport([
    { outcome: "failed", error_summary: "Structural lint blocked the variation: 6 source text item(s) are missing from the output (Pay SECRET)",
      metadata: { source: "figma-agent", model: "m", attempts: [{ model: "m", result: "HTTP 502" }, { model: "m", result: "quality: quality preflight rejected plan (x)" }, { model: "source-fallback", result: "passed" }] } },
  ], now);
  assert.deepEqual(report.failureReasons.final, { "missing-source-text": 1 });
  assert.deepEqual(report.failureReasons.attempts, { "http-502": 1, "quality-preflight": 1 });
  assert.doesNotMatch(JSON.stringify(report), /SECRET/);
  assert.equal(classifyFailureReason("Generation deadline reached before x could run."), "timeout");
  assert.equal(classifyFailureReason("12 icons, logos or graphics from the source were dropped"), "dropped-graphics");
});
