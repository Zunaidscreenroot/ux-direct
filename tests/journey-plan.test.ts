import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackJourney, journeyGoal, normalizeJourney } from "../src/figma-agent/journey-plan";

test("journey goal comes from the person's words", () => {
  assert.equal(journeyGoal("create a journey to pay overdue EMI"), "Pay overdue EMI");
  assert.equal(journeyGoal("design the onboarding flow for a fitness app"), "Onboarding fitness app");
});

test("a model plan keeps its steps, ends in one success and one failure state with Retry", () => {
  const plan = normalizeJourney({ title: "Pay EMI", steps: [
    { name: "My loans", primaryAction: "Pay now" },
    { name: "Choose amount", purpose: "Full or partial", primaryAction: "Continue" },
    { name: "Payment method", primaryAction: "Pay ₹8,450" },
    { name: "Payment successful", kind: "success" },
  ] }, "create a journey to pay EMI")!;
  assert.deepEqual(plan.steps.map((s) => s.kind), ["step", "step", "step", "success", "error"]);
  assert.equal(plan.steps[3].primaryAction, "Done");
  assert.equal(plan.steps[4].primaryAction, "Retry");
  assert.match(plan.steps[4].name, /failed/);
});

test("too few steps is rejected and the fallback is a generic, complete journey", () => {
  assert.equal(normalizeJourney({ steps: [{ name: "Only one" }] }, "x"), null);
  const fb = fallbackJourney("create a sign up flow");
  assert.equal(fb.steps.at(-2)!.kind, "success");
  assert.equal(fb.steps.at(-1)!.kind, "error");
});
