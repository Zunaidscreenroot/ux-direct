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
              ? "Perform a lightweight learning extraction as part of this same task-planning inference; do not make a second model call for learning. Return at most one compact learningCandidate only when the task and plan reveal a reusable, evidence-grounded UX, design-system, accessibility, product or execution rule that would improve future tasks; otherwise return null. Capture successful reusable practices and technical execution lessons as well as corrections. Do not save a mere task summary, one-off requirement, confidential client fact, personal identifier, screenshot content, node ID, secret, or speculative assumption. Keep the normalized rule short and reusable; the backend stores the normalized lesson rather than copying the raw task brief into shared memory. Choose the narrowest supported scope: UX_SHARED_BRAIN only for genuinely cross-product principles; indian-bfsi for reusable Indian financial-services principles; client scopes for client-specific guidance; project:ux-direct for Figma/plugin/tooling lessons; project:general-ux for generic UX patterns. Classify as false_positive, missed_issue, severity_calibration, recommendation_quality, duplicate_finding, benchmarking, scope, visual_evidence, accessibility, interaction_logic, design_system, cost_optimization, or general. Set activate=true for a clearly reusable candidate; the backend independently applies the 50% relevance gate and safe scope resolution, so this flag never bypasses those checks."
              : "",
            "Never claim you read a Figma file or changed a design. Task plans are not completed execution; a canvas write must be verified by the plugin before claiming success. Destructive or high-impact actions still require review.",
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
