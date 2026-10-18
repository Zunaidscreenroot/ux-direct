import test from "node:test";
import assert from "node:assert/strict";
import { validateDesignIR, summarizeDesignIR } from "../src/core/design-ir";
import { createTaskLifecycle, transitionTask } from "../src/core/task-state-machine";
import { feedbackToMemoryCandidate, scoreFeedbackRubric } from "../src/memory/learning-feedback";

const validIR = {
  version: "1.0",
  project: "general",
  title: "Account overview",
  rationale: ["Prioritize balance and next action"],
  tokens: { color: { primary: "#112233" }, spacing: { md: 16 }, radius: { card: 12 }, typography: {} },
  requirements: [{ id: "balance", description: "Show account balance", nodeIds: ["screen", "balance"], status: "covered" }],
  screens: [{
    id: "screen", type: "screen", name: "Account overview", tokenRefs: ["primary"],
    children: [{ id: "balance", type: "text", name: "Balance", content: "₹0", tokenRefs: ["md"] }],
  }],
};

test("Design IR validates references and produces a compact QA summary", () => {
  const result = validateDesignIR(validIR);
  assert.equal(result.success, true);
  if (result.success) {
    const summary = summarizeDesignIR(result.data);
    assert.equal(summary.nodeCount, 2);
    assert.deepEqual(summary.uncoveredRequirements, []);
  }
});

test("Design IR rejects duplicate ids, missing requirement nodes, and unknown tokens", () => {
  const invalid = structuredClone(validIR);
  invalid.screens[0].children[0].id = "screen";
  invalid.screens[0].children[0].tokenRefs = ["missing-token"];
  invalid.requirements[0].nodeIds = ["ghost"];
  const result = validateDesignIR(invalid);
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.issues.length >= 3);
});

test("task lifecycle rejects invalid transitions and caps retries", () => {
  let task = createTaskLifecycle("queued", 1);
  task = transitionTask(task, "planning", "request accepted", "2026-10-18T00:00:00.000Z");
  task = transitionTask(task, "running", "plan approved", "2026-10-18T00:00:01.000Z");
  task = transitionTask(task, "validating", "draft produced", "2026-10-18T00:00:02.000Z");
  task = transitionTask(task, "failed", "verification failed", "2026-10-18T00:00:03.000Z");
  task = transitionTask(task, "queued", "retry requested", "2026-10-18T00:00:04.000Z");
  assert.throws(() => transitionTask(task, "running", "retry", "2026-10-18T00:00:05.000Z"), /retry limit/);
  assert.throws(() => transitionTask(task, "completed", "illegal", "2026-10-18T00:00:06.000Z"), /Invalid task transition/);
});

const feedback = {
  taskId: "task-1", project: "general", issueCategory: "visual-hierarchy", severity: "high",
  evidence: "Primary action is visually weaker than secondary action.",
  expectedOutcome: "Primary action is immediately discoverable.",
  recommendation: "Increase contrast and align action with the main heading.",
  confidence: 0.9, accepted: true, reviewer: "expert-model",
  rubric: { requirementCoverage: 4, visualQuality: 3, consistency: 4, accessibility: 4, implementationValidity: 5 },
  createdAt: "2026-10-18T00:00:00.000Z",
};

test("model feedback is never auto-promoted to trusted memory", () => {
  assert.equal(feedbackToMemoryCandidate(feedback, "candidate-1").verified, false);
  assert.equal(feedbackToMemoryCandidate({ ...feedback, reviewer: "human" }, "candidate-2").verified, true);
});

test("feedback rubric gives a bounded score and keeps model reviews marked", () => {
  const score = scoreFeedbackRubric(feedback);
  assert.equal(score.average, 4);
  assert.equal(score.passed, true);
  assert.equal(score.needsHumanReview, true);
});
