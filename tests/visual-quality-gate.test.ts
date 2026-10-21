import test from "node:test";
import assert from "node:assert/strict";
import { evaluateVisualQualityGate } from "../src/figma-agent/visual-quality-gate";

const cleanIssues: { severity: "high" | "medium" | "low" }[] = [];

test("visual quality gate fails closed when either rendered screenshot is absent", () => {
  const withoutSource = evaluateVisualQualityGate({
    score: 100, issues: cleanIssues, hasSourceImage: false, hasOutputImage: true,
  });
  const withoutOutput = evaluateVisualQualityGate({
    score: 100, issues: cleanIssues, hasSourceImage: true, hasOutputImage: false,
  });
  assert.equal(withoutSource.passed, false);
  assert.equal(withoutOutput.passed, false);
  assert.equal(withoutSource.visualInspection, false);
  assert.match(withoutOutput.message, /both source and output screenshots/);
});

test("visual quality gate requires a score of at least 90", () => {
  const report = evaluateVisualQualityGate({
    score: 89, issues: cleanIssues, hasSourceImage: true, hasOutputImage: true,
  });
  assert.equal(report.passed, false);
  assert.equal(report.minimumScore, 90);
});

test("visual quality gate blocks even low-severity unresolved findings", () => {
  const report = evaluateVisualQualityGate({
    score: 98, issues: [{ severity: "low" }], hasSourceImage: true, hasOutputImage: true,
  });
  assert.equal(report.passed, false);
  assert.equal(report.issueCount, 1);
});

test("visual quality gate passes only clean, screenshot-backed output at score 90+", () => {
  const report = evaluateVisualQualityGate({
    score: 90, issues: cleanIssues, hasSourceImage: true, hasOutputImage: true,
  });
  assert.equal(report.passed, true);
  assert.equal(report.visualInspection, true);
  assert.equal(report.unresolvedHighSeverity, false);
});
