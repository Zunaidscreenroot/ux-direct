import type { ModelProvider, TaskPlan, TaskProject } from "../core/types";
import { chatCompletionWithFallback, providersFromEnv } from "../model-gateway";

/**
 * Bridges the shared gateway into UX Direct's task planner.
 * Defaults to task aliases that prefer local/free inference. Paid routing requires
 * explicit ALLOW_PAID_MODELS=true and an explicit MODEL_GATEWAY_TASK_MODEL.
 */
export const gatewayProvider: ModelProvider = {
  id: "model-gateway",
  mode: "remote",
  async plan({ title, request, project, requestId }: { title: string; request: string; project: TaskProject; requestId?: string }): Promise<TaskPlan> {
    const providers = providersFromEnv();
    const paidSelected = process.env.ALLOW_PAID_MODELS === "true" &&
      Boolean(process.env.MODEL_GATEWAY_TASK_MODEL) &&
      providers.some(provider => provider.kind === "paid" && provider.models.includes(process.env.MODEL_GATEWAY_TASK_MODEL!));
    const localOrFreeConfigured = providers.some(provider => provider.kind === "local" || provider.kind === "free-tier");
    if (!localOrFreeConfigured && !paidSelected) {
      throw new Error("No local/free model is configured. Keep using mock mode until a provider is connected.");
    }
    const model = paidSelected ? process.env.MODEL_GATEWAY_TASK_MODEL! : "uxd/reasoning";
    const result = await chatCompletionWithFallback({
      model,
      requestId: requestId ?? crypto.randomUUID(),
      temperature: 0.2,
      max_tokens: 1800,
      messages: [
        {
          role: "system",
          content: [
            "You are UX Direct, a senior product UX planner.",
            "Return only one valid JSON object. No markdown fences and no prose outside JSON.",
            "Schema: { summary: string, assumptions: string[], steps: [{ id: string, label: string, capabilityId: string }], qualityChecks: string[], requiresHumanReview: true }.",
            "Create 4-7 concrete steps with unique short ids and capabilityIds. Keep assumptions and qualityChecks concise.",
            "Never claim you read a Figma file or changed a design. Human review is always required."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({ title, request, project, instruction: "Create an evidence-conscious, reviewable UX task plan." })
        }
      ]
    });
    const raw = result.content.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      throw new Error("The selected model returned invalid plan JSON. Check the model response and retry; no design changes were made.");
    }
    if (!parsed || typeof parsed !== "object") throw new Error("The model response did not match the UX task plan schema.");
    const value = parsed as Record<string, unknown>;
    const steps = Array.isArray(value.steps) ? value.steps.filter((step): step is Record<string, unknown> =>
      Boolean(step) && typeof step === "object" &&
      typeof (step as Record<string, unknown>).id === "string" &&
      typeof (step as Record<string, unknown>).label === "string" &&
      typeof (step as Record<string, unknown>).capabilityId === "string"
    ).slice(0, 10).map(step => ({
      id: String(step.id).slice(0, 80),
      label: String(step.label).slice(0, 240),
      capabilityId: String(step.capabilityId).slice(0, 120)
    })) : [];
    if (typeof value.summary !== "string" || steps.length < 2 ||
      !Array.isArray(value.assumptions) || !Array.isArray(value.qualityChecks)) {
      throw new Error("The model response is missing required plan fields. No design changes were made.");
    }
    return {
      summary: value.summary.slice(0, 1200),
      assumptions: value.assumptions.filter((item): item is string => typeof item === "string").slice(0, 12).map(item => item.slice(0, 500)),
      steps,
      qualityChecks: value.qualityChecks.filter((item): item is string => typeof item === "string").slice(0, 20).map(item => item.slice(0, 500)),
      requiresHumanReview: true
    };
  }
};
