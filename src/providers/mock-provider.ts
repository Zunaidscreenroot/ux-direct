import type { ModelProvider, TaskPlan } from "../core/types";

/**
 * Deterministic provider for workflow development. It does not call a model,
 * use network access, or incur model API charges.
 */
export const mockProvider: ModelProvider = {
  id: "mock",
  mode: "mock",
  async plan({ title, request, project }): Promise<TaskPlan> {
    const dmi = project === "dmi-finance" || /vkyc|credit report|dmi/i.test(`${title} ${request}`);
    const express = project === "express-computers" || /express computers|batch 3|wireframe/i.test(`${title} ${request}`);
    const steps = [
      { id: "requirements", label: "Extract requirements, constraints, and unknowns", capabilityId: "requirements.extract" },
      { id: "context", label: "Retrieve approved project patterns and prior feedback", capabilityId: "context.retrieve" },
      { id: "plan", label: "Build the journey or screen plan with rationale", capabilityId: "ux.plan" },
      { id: "quality", label: "Run UX, accessibility, content, and edge-state checks", capabilityId: "ux.critique" },
      { id: "review", label: "Prepare evidence, assumptions, and a human review package", capabilityId: "review.package" },
    ];
    const qualityChecks = [
      "Every stated requirement is mapped to a design decision or an explicit open question",
      "Primary and secondary paths, error states, loading states, and recovery are considered",
      "Existing approved design patterns are preferred over invented components",
      "Accessibility, clear content, and responsive behavior are checked",
      "Unverified assumptions are labeled; no external action is claimed without evidence",
    ];
    if (dmi) qualityChecks.push(
      "Consent and purpose limitation are explicit",
      "Identity/OTP failures, retry limits, and unavailable-service states are covered",
      "Credit-report access is not represented as successful without a valid verification outcome",
    );
    if (express) qualityChecks.push(
      "Batch 1/2 patterns and reviewer feedback are treated as evidence, not guessed",
      "Reusable components and responsive constraints are documented",
    );
    return {
      summary: `Create a reviewable UX plan for ${title || "the requested task"} using the ${project} context. This is a local mock plan, not generated Figma output.`,
      assumptions: [
        "Project source screens and approved feedback must be provided or explicitly connected before patterns can be treated as facts.",
        "Figma editing stays disabled until the target file ID is allowlisted and the adapter passes its safety checks.",
      ],
      steps,
      qualityChecks,
      requiresHumanReview: true,
    };
  },
};
