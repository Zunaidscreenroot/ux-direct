import test from "node:test";
import assert from "node:assert/strict";
import { planUXTask } from "../src/core/orchestrator";
import { mockProvider } from "../src/providers/mock-provider";
import { createDefaultCapabilityRegistry } from "../src/core/default-capabilities";

test("mock provider creates a review-required DMI plan without external calls", async () => {
  const { task, plan } = await planUXTask({
    title: "DMI VKYC journey",
    request: "Plan VKYC with consent and retry states",
    project: "dmi-finance",
    provider: mockProvider,
  });
  assert.equal(task.status, "needs_review");
  assert.equal(plan.requiresHumanReview, true);
  assert.ok(plan.qualityChecks.some((check) => check.includes("Consent")));
  assert.ok(task.steps.length >= 4);
});

test("paid model capabilities fail closed", async () => {
  const registry = createDefaultCapabilityRegistry();
  registry.register({
    id: "test.paid",
    description: "Test-only paid capability",
    risk: "low",
    costClass: "paid-model",
    requiresApproval: false,
    async run() { return { ran: true }; },
  });
  await assert.rejects(registry.execute("test.paid", {}), /Paid model capabilities are disabled/);
});

test("external writes require explicit approval", async () => {
  const registry = createDefaultCapabilityRegistry();
  await assert.rejects(registry.execute("figma.read", {}), /requires human approval/);
});
