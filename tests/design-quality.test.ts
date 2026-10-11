import test from "node:test";
import assert from "node:assert/strict";
import { critiqueDesignInstruction, nextBoundedIteration, validateDesignInstruction } from "../src/quality/design-quality";
import { ProjectMemory } from "../src/memory/project-memory";

const base = {
  project: "dmi-finance" as const,
  taskTitle: "VKYC entry journey",
  goal: "Help an eligible user understand and start VKYC with clear next steps.",
  userJourney: [{
    id: "entry",
    name: "Start VKYC",
    purpose: "Explain the process and start verification",
    entryConditions: ["User is in the relevant loan journey"],
    actions: ["Review purpose-specific consent", "Start verification"],
    states: ["default", "loading", "error", "retry", "success", "cancelled"] as Array<"default" | "loading" | "error" | "retry" | "success" | "cancelled">,
    exitCriteria: ["A verified result or clear recovery path is shown"],
  }],
  requirements: [{ id: "consent", description: "Explain purpose before verification", evidence: "Approved brief", status: "covered" as const }],
  designPrinciples: ["Use purpose-limited consent and protect privacy", "Provide keyboard focus and screen-reader labels"],
  components: [{ name: "VKYC tile", purpose: "Entry point", reuseEvidence: "Approved source frame 22" }],
  qualityChecks: ["Error recovery", "Accessibility"],
  unresolvedQuestions: [],
  humanReviewRequired: true as const,
};

test("design instruction schema rejects missing required journey fields", () => {
  assert.throws(() => validateDesignInstruction({ project: "dmi-finance" }));
});

test("quality critique flags missing loading and error states and bounds iterations", () => {
  const report = critiqueDesignInstruction({
    ...base,
    userJourney: [{ ...base.userJourney[0], states: ["default"] }],
  }, undefined, 1);
  assert.equal(report.passed, false);
  assert.ok(report.findings.some((finding) => finding.id === "missing-error-state"));
  assert.ok(report.findings.some((finding) => finding.id === "missing-loading-state"));
  assert.equal(nextBoundedIteration(report), 2);
  assert.equal(nextBoundedIteration({ ...report, iteration: 3 }), null);
});

test("DMI critique requires explicit consent principles", () => {
  const report = critiqueDesignInstruction({
    ...base,
    designPrinciples: ["Make the screen visually clean"],
  }, undefined, 1);
  assert.ok(report.findings.some((finding) => finding.id === "financial-consent"));
});

test("verified project memory can be searched and project evidence gaps remain visible", () => {
  const memory = new ProjectMemory();
  const report = critiqueDesignInstruction(base, memory, 1);
  assert.ok(report.findings.some((finding) => finding.id === "memory-empty"));
  memory.add({
    id: "approved-vkyc",
    project: "dmi-finance",
    kind: "pattern",
    title: "Consent panel",
    detail: "Approved consent panel and helper text",
    source: "Approved source frame 22",
    verified: true,
    tags: ["consent"],
    createdAt: "2026-10-11T00:00:00.000Z",
  });
  assert.equal(memory.search({ project: "dmi-finance", query: "consent" })[0].id, "approved-vkyc");
});
