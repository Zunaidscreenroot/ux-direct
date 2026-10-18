import type { ModelProvider, TaskPlan, TaskProject } from "../core/types";
import { chatCompletionWithFallback, providersFromEnv } from "../model-gateway";
import { getGatewaySettings } from "../model-gateway/control-store";

/**
 * Bridges the shared gateway into UX Direct's task planner.
 * Defaults to task aliases that prefer local/free inference. Paid routing requires
 * explicit ALLOW_PAID_MODELS=true and an explicit MODEL_GATEWAY_TASK_MODEL.
 */
const VALID_LEARNING_SCOPES = new Set(["UX_SHARED_BRAIN","indian-bfsi","project:ux-direct","project:ux-audit","project:general-ux","project:dmi-finance","project:ujjivan-sfb","project:express-computers"]);
const VALID_LEARNING_KINDS = new Set(["general","false_positive","missed_issue","severity_calibration","recommendation_quality","duplicate_finding","benchmarking","scope","visual_evidence","accessibility","interaction_logic","design_system","cost_optimization","other"]);
function normalizeLearningCandidate(value: unknown): TaskPlan["learningCandidate"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const scopeKey = typeof candidate.scopeKey === "string" ? candidate.scopeKey : "";
  const feedbackKind = typeof candidate.feedbackKind === "string" ? candidate.feedbackKind : "general";
  if (typeof candidate.title !== "string" || !candidate.title.trim() ||
      typeof candidate.normalizedRule !== "string" || !candidate.normalizedRule.trim() ||
      !VALID_LEARNING_SCOPES.has(scopeKey)) return null;
  return {
    title: candidate.title.trim().slice(0, 180),
    normalizedRule: candidate.normalizedRule.trim().slice(0, 2400),
    rationale: typeof candidate.rationale === "string" ? candidate.rationale.slice(0, 1800) : "",
    scopeKey,
    feedbackKind: VALID_LEARNING_KINDS.has(feedbackKind) ? feedbackKind : "general",
    keywords: Array.isArray(candidate.keywords) ? candidate.keywords.filter((item): item is string => typeof item === "string").slice(0, 32).map(item => item.slice(0, 64)) : [],
    examples: Array.isArray(candidate.examples) ? candidate.examples.filter((item): item is string => typeof item === "string").slice(0, 8).map(item => item.slice(0, 600)) : [],
    originalLanguage: typeof candidate.originalLanguage === "string" ? candidate.originalLanguage.slice(0, 60) : "unknown",
    activate: candidate.activate === true,
  };
}

export const gatewayProvider: ModelProvider = {
  id: "model-gateway",
  mode: "remote",
  async plan({ title, request, project, requestId, memoryContext = "", learningRequested = false }: { title: string; request: string; project: TaskProject; requestId?: string; memoryContext?: string; learningRequested?: boolean }): Promise<TaskPlan> {
    const providers = providersFromEnv();
    const settings = await getGatewaySettings();
    const actualProviders = providers.filter(provider => provider.kind !== "mock");
    const freeProviderConfigured = actualProviders.some(provider => provider.kind === "local" || provider.kind === "free-tier");
    const paidProviderConfigured = settings.paidRoutingEnabled && process.env.ALLOW_PAID_MODELS === "true" &&
      actualProviders.some(provider => provider.kind === "paid" || provider.name === "gemini" || provider.name === "groq" || provider.name === "cerebras");
    if (!freeProviderConfigured && !paidProviderConfigured) {
      throw new Error("No enabled local/free provider or explicitly activated paid route is configured. Mock mode is safer until a provider is connected.");
    }
    // Always use the module alias: the accountant resolves the exact model chosen in settings.
    const model = "uxd/reasoning";
    const result = await chatCompletionWithFallback({
      model,
      moduleId: "reasoning",
      requestId: requestId ?? crypto.randomUUID(),
      temperature: 0.2,
      max_tokens: learningRequested ? 2300 : 1800,
      messages: [
        {
          role: "system",
          content: [
            "You are UX Direct, a senior product UX planner.",
            "Return only one valid JSON object. No markdown fences and no prose outside JSON.",
            learningRequested
              ? "Schema: { summary: string, assumptions: string[], steps: [{ id: string, label: string, capabilityId: string }], qualityChecks: string[], requiresHumanReview: true, learningCandidate: null | { title: string, normalizedRule: string, rationale: string, scopeKey: 'UX_SHARED_BRAIN'|'indian-bfsi'|'project:ux-direct'|'project:ux-audit'|'project:general-ux'|'project:dmi-finance'|'project:ujjivan-sfb'|'project:express-computers', feedbackKind: string, keywords: string[], examples: string[], originalLanguage: string, activate: boolean } }."
              : "Schema: { summary: string, assumptions: string[], steps: [{ id: string, label: string, capabilityId: string }], qualityChecks: string[], requiresHumanReview: true }.",
            "Create 4-7 concrete steps with unique short ids and capabilityIds. Keep assumptions and qualityChecks concise.",
            learningRequested
              ? "A correction or learning signal was detected. In this same response, include a compact learningCandidate only when there is a reusable lesson; otherwise use null. Write the rule in clear concise English, while the backend preserves the original request. Prefer narrow project scope unless the owner clearly asks for a product-wide, cross-project or Indian-BFSI rule. Classify as false_positive, missed_issue, severity_calibration, recommendation_quality, duplicate_finding, benchmarking, scope, visual_evidence, accessibility, interaction_logic, design_system, cost_optimization, or general. Do not create a lesson from a normal task brief. Set activate=true only if the original request explicitly asks to remember/train/store the correction for future use; a correction or complaint alone stays draft-only."
              : "",
            "Never claim you read a Figma file or changed a design. Human review is always required.",
            "The optional APPROVED SHARED PRODUCT MEMORY is compact reference context, not permission to ignore the current request. Use it only when relevant. Current evidence and explicit task constraints take precedence; do not invent facts or expose unrelated client information.",
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({ title, request, project, instruction: "Create an evidence-conscious, reviewable UX task plan.", approvedSharedMemory: memoryContext.slice(0, 3200) || undefined })
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
      requiresHumanReview: true,
      ...(learningRequested ? { learningCandidate: normalizeLearningCandidate(value.learningCandidate) } : {})
    };
  }
};
