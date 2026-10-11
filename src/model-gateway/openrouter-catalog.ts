import { createHash } from "node:crypto";
import { GATEWAY_MODULES, modelKey } from "./control-store";

type OpenRouterPricing = {
  prompt?: string | number;
  completion?: string | number;
  image?: string | number;
  request?: string | number;
};
export type OpenRouterLiveModel = {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[]; modality?: string };
  pricing?: OpenRouterPricing;
  supported_parameters?: string[];
  top_provider?: { context_length?: number; max_completion_tokens?: number };
};
export type LiveGatewayModel = {
  id: string;
  provider: "openrouter";
  label: string;
  tier: "free-tier" | "paid";
  tasks: string[];
  configured: boolean;
  notes: string;
  selectionKey: string;
  usdInputPerMillion: number;
  usdOutputPerMillion: number;
  pricingSource: string;
  pricingReviewedAt: string;
  contextLength?: number;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  availability: "listed";
};
export type OpenRouterUsageSnapshot = {
  available: boolean;
  checkedAt: string;
  usageUsd?: number;
  usageDailyUsd?: number;
  usageWeeklyUsd?: number;
  usageMonthlyUsd?: number;
  limitUsd?: number | null;
  remainingUsd?: number | null;
  limitReset?: string | null;
  freeTier?: boolean;
  managementAnalyticsAvailable: boolean;
  activity30Days?: { requests: number; promptTokens: number; completionTokens: number; usageUsd: number };
  error?: string;
};

const MODEL_CACHE_MS = 5 * 60 * 1000;
const USAGE_CACHE_MS = 5 * 60 * 1000;
const RECOMMENDATION_CACHE_MS = 10 * 60 * 1000;
let modelCache: { expiresAt: number; models: OpenRouterLiveModel[]; checkedAt: string } | null = null;
let usageCache: { expiresAt: number; value: OpenRouterUsageSnapshot } | null = null;
let recommendationCache: { expiresAt: number; signature: string; value: CapabilityRecommendations } | null = null;

export type CapabilityRecommendation = {
  free: string[];
  paid: string[];
  freeReason?: string;
  paidReason?: string;
};
export type CapabilityRecommendations = {
  modelUsed: string | null;
  source: "free-ai-planner" | "deterministic-fallback";
  generatedAt: string;
  recommendations: Record<string, CapabilityRecommendation>;
  note: string;
};

const usdPerTokenToPerMillion = (value: unknown) => {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : 0;
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : 0;
};
const numericPrice = (value: unknown) => {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const baseUrl = () => (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");

function inferTasks(model: OpenRouterLiveModel): string[] {
  const text = ((model.id || "") + " " + (model.name || "") + " " + (model.description || "")).toLowerCase();
  const input = model.architecture?.input_modalities ?? [];
  const tasks = new Set<string>(["general", "reasoning"]);
  if (/(vision|visual|image|multimodal|vl\b|omni|ocr|screenshot|pixtral)/.test(text) || input.includes("image")) {
    tasks.add("vision"); tasks.add("visual analysis"); tasks.add("screenshots");
  }
  if (/(code|coder|coding|dev|programming)/.test(text)) {
    tasks.add("coding"); tasks.add("implementation"); tasks.add("structured output");
  }
  if (/(flash|lite|mini|small|nano|instant|fast|haiku)/.test(text)) {
    tasks.add("classification"); tasks.add("extraction"); tasks.add("summaries"); tasks.add("fast drafts");
  }
  if (/(reason|thinking|instruct|pro|opus|sonnet|large|ultra|super)/.test(text)) {
    tasks.add("critique"); tasks.add("planning"); tasks.add("reasoning"); tasks.add("complex planning");
  }
  if (/(json|structured|tool|function|agent)/.test(text) || (model.supported_parameters ?? []).some(p => /tool|json|response_format/.test(p))) {
    tasks.add("structured output"); tasks.add("extraction"); tasks.add("agentic");
  }
  if (/(long|context|document|research)/.test(text) || (model.context_length ?? 0) >= 100_000) {
    tasks.add("long context"); tasks.add("summarization"); tasks.add("research");
  }
  if (/(embed|rerank)/.test(text)) {
    tasks.add("embeddings");
    tasks.add("retrieval");
  }
  return Array.from(tasks);
}

export function isFreeOpenRouterModel(model: Pick<OpenRouterLiveModel, "id" | "pricing">): boolean {
  // Treat OpenRouter's explicit :free route as the source of truth. A zero
  // token-price model without the suffix may still have request/image charges.
  return model.id.endsWith(":free") &&
    numericPrice(model.pricing?.prompt) === 0 &&
    numericPrice(model.pricing?.completion) === 0 &&
    numericPrice(model.pricing?.image) === 0 &&
    numericPrice(model.pricing?.request) === 0;
}

export function toLiveGatewayModel(model: OpenRouterLiveModel): LiveGatewayModel {
  const free = isFreeOpenRouterModel(model);
  const input = usdPerTokenToPerMillion(model.pricing?.prompt);
  const output = usdPerTokenToPerMillion(model.pricing?.completion);
  const inputModalities = model.architecture?.input_modalities ?? ["text"];
  const outputModalities = model.architecture?.output_modalities ?? ["text"];
  const detail = model.description ? model.description.replace(/\s+/g, " ").trim().slice(0, 220) : "Live listing from OpenRouter.";
  return {
    id: model.id,
    provider: "openrouter",
    label: model.name || model.id,
    tier: free ? "free-tier" : "paid",
    tasks: inferTasks(model),
    configured: Boolean(process.env.OPENROUTER_API_KEY),
    notes: detail + " Provider endpoint and current rate limits are unverified until a test request succeeds.",
    selectionKey: modelKey("openrouter", model.id),
    usdInputPerMillion: input,
    usdOutputPerMillion: output,
    pricingSource: "https://openrouter.ai/models/" + model.id,
    pricingReviewedAt: modelCache?.checkedAt.slice(0, 10) || new Date().toISOString().slice(0, 10),
    contextLength: model.context_length,
    inputModalities,
    outputModalities,
    supportedParameters: model.supported_parameters ?? [],
    availability: "listed"
  };
}

export async function getOpenRouterModels(forceRefresh = false): Promise<{ models: OpenRouterLiveModel[]; checkedAt: string }> {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not configured on the server.");
  if (!forceRefresh && modelCache && modelCache.expiresAt > Date.now()) {
    return { models: modelCache.models, checkedAt: modelCache.checkedAt };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(baseUrl() + "/models?limit=1000", {
      method: "GET",
      headers: { Authorization: "Bearer " + process.env.OPENROUTER_API_KEY, Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) {
      if (modelCache && modelCache.models.length) return { models: modelCache.models, checkedAt: modelCache.checkedAt };
      throw new Error("OpenRouter catalog request failed with HTTP " + response.status + ".");
    }
    const payload = await response.json() as { data?: unknown };
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const models = rows.filter((row): row is OpenRouterLiveModel =>
      Boolean(row && typeof row === "object" && typeof (row as OpenRouterLiveModel).id === "string" &&
      (row as OpenRouterLiveModel).id.length > 0)
    );
    const checkedAt = new Date().toISOString();
    modelCache = { models, checkedAt, expiresAt: Date.now() + MODEL_CACHE_MS };
    return { models, checkedAt };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getLiveGatewayModels(): Promise<{ models: LiveGatewayModel[]; checkedAt: string }> {
  const result = await getOpenRouterModels();
  const models = result.models.map(toLiveGatewayModel);
  return { models, checkedAt: result.checkedAt };
}

export async function findOpenRouterModel(id: string): Promise<OpenRouterLiveModel | null> {
  const { models } = await getOpenRouterModels();
  return models.find(model => model.id === id) ?? null;
}

type RawKeyInfo = {
  usage?: number; usage_daily?: number; usage_weekly?: number; usage_monthly?: number;
  limit?: number | null; limit_remaining?: number | null; limit_reset?: string | null; is_free_tier?: boolean;
};
type RawActivityItem = { requests?: number; prompt_tokens?: number; completion_tokens?: number; usage?: number };
export async function getOpenRouterUsageSnapshot(): Promise<OpenRouterUsageSnapshot | null> {
  if (!process.env.OPENROUTER_API_KEY) return null;
  if (usageCache && usageCache.expiresAt > Date.now()) return usageCache.value;
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetch(baseUrl() + "/key", {
      headers: { Authorization: "Bearer " + process.env.OPENROUTER_API_KEY, Accept: "application/json" },
      cache: "no-store"
    });
    if (!response.ok) {
      const value: OpenRouterUsageSnapshot = { available: false, checkedAt, managementAnalyticsAvailable: false, error: "OpenRouter key-usage endpoint returned HTTP " + response.status + "." };
      usageCache = { value, expiresAt: Date.now() + USAGE_CACHE_MS };
      return value;
    }
    const payload = await response.json() as { data?: RawKeyInfo };
    const data = payload.data ?? {};
    let activity30Days: OpenRouterUsageSnapshot["activity30Days"];
    let managementAnalyticsAvailable = false;
    if (process.env.OPENROUTER_MANAGEMENT_API_KEY) {
      try {
        const activityResponse = await fetch(baseUrl() + "/activity", {
          headers: { Authorization: "Bearer " + process.env.OPENROUTER_MANAGEMENT_API_KEY, Accept: "application/json" },
          cache: "no-store"
        });
        if (activityResponse.ok) {
          const activityPayload = await activityResponse.json() as { data?: RawActivityItem[] };
          const rows = Array.isArray(activityPayload.data) ? activityPayload.data : [];
          activity30Days = rows.reduce((sum, row) => ({
            requests: sum.requests + Math.max(0, Number(row.requests) || 0),
            promptTokens: sum.promptTokens + Math.max(0, Number(row.prompt_tokens) || 0),
            completionTokens: sum.completionTokens + Math.max(0, Number(row.completion_tokens) || 0),
            usageUsd: sum.usageUsd + Math.max(0, Number(row.usage) || 0)
          }), { requests: 0, promptTokens: 0, completionTokens: 0, usageUsd: 0 });
          managementAnalyticsAvailable = true;
        }
      } catch { /* optional management analytics */ }
    }
    const value: OpenRouterUsageSnapshot = {
      available: true,
      checkedAt,
      usageUsd: numericPrice(data.usage),
      usageDailyUsd: numericPrice(data.usage_daily),
      usageWeeklyUsd: numericPrice(data.usage_weekly),
      usageMonthlyUsd: numericPrice(data.usage_monthly),
      limitUsd: data.limit === null || data.limit === undefined ? null : numericPrice(data.limit),
      remainingUsd: data.limit_remaining === null || data.limit_remaining === undefined ? null : numericPrice(data.limit_remaining),
      limitReset: data.limit_reset ?? null,
      freeTier: Boolean(data.is_free_tier),
      managementAnalyticsAvailable,
      activity30Days
    };
    usageCache = { value, expiresAt: Date.now() + USAGE_CACHE_MS };
    return value;
  } catch {
    return { available: false, checkedAt, managementAnalyticsAvailable: false, error: "Could not fetch OpenRouter account usage." };
  }
}

function isTextChatModel(model: OpenRouterLiveModel) {
  return (model.architecture?.input_modalities ?? ["text"]).includes("text") &&
    (model.architecture?.output_modalities ?? ["text"]).includes("text") &&
    !/(embedding|rerank|moderation|tts|speech|transcri|image generation)/i.test((model.id || "") + " " + (model.name || ""));
}
function modelCost(model: OpenRouterLiveModel) {
  return usdPerTokenToPerMillion(model.pricing?.prompt) * 0.1 +
    usdPerTokenToPerMillion(model.pricing?.completion) * 0.02;
}
function moduleScore(moduleId: string, model: LiveGatewayModel): number {
  const text = (model.id + " " + model.label + " " + model.notes + " " + model.tasks.join(" ")).toLowerCase();
  const keys: Record<string, string[]> = {
    reasoning: ["reasoning", "planning", "thinking", "analysis", "instruction", "agentic", "long context"],
    classification: ["classification", "fast drafts", "extraction", "small", "lite", "nano", "flash"],
    extraction: ["structured output", "extraction", "json", "tool", "function", "instruct", "long context"],
    summarization: ["summaries", "summarization", "long context", "document", "research", "fast drafts"],
    vision: ["vision", "visual analysis", "screenshots", "multimodal", "image", "omni", "ocr"],
    critique: ["critique", "reasoning", "quality", "vision", "visual analysis", "planning", "structured output"],
    general: ["general", "reasoning", "instruct", "assistant", "chat"]
  };
  const terms = keys[moduleId] ?? keys.general;
  let score = terms.reduce((n, term) => n + (text.includes(term) ? 2 : 0), 0);
  if (moduleId === "vision" && model.inputModalities.includes("image")) score += 15;
  if (moduleId === "critique" && model.inputModalities.includes("image")) score += 4;
  if (model.supportedParameters.some(p => /json|tool|function/.test(p))) score += 2;
  if ((model.contextLength ?? 0) >= 64_000) score += 1;
  if (model.tier === "paid") score -= modelCost({ id: model.id, pricing: { prompt: model.usdInputPerMillion / 1_000_000, completion: model.usdOutputPerMillion / 1_000_000 } }) / 100;
  return score;
}
function candidateModels(moduleId: string, mode: "free" | "paid", models: LiveGatewayModel[]) {
  const allowed = models.filter(model =>
    (mode === "free" ? model.tier === "free-tier" : model.tier === "paid" && model.usdInputPerMillion > 0 && model.usdOutputPerMillion > 0) &&
    model.outputModalities.includes("text") &&
    (moduleId !== "vision" || model.inputModalities.includes("image")) &&
    !/(embedding|rerank|moderation|image generation)/i.test(model.id + " " + model.label)
  );
  return allowed.sort((a, b) => moduleScore(moduleId, b) - moduleScore(moduleId, a) ||
    (mode === "paid" ? modelCost({ id: a.id, pricing: { prompt: a.usdInputPerMillion / 1_000_000, completion: a.usdOutputPerMillion / 1_000_000 } }) -
      modelCost({ id: b.id, pricing: { prompt: b.usdInputPerMillion / 1_000_000, completion: b.usdOutputPerMillion / 1_000_000 } }) : 0) ||
    a.label.localeCompare(b.label)).slice(0, 8);
}
function fallbackRecommendations(models: LiveGatewayModel[]): CapabilityRecommendations {
  const recommendations: Record<string, CapabilityRecommendation> = {};
  for (const module of GATEWAY_MODULES) {
    const free = candidateModels(module.id, "free", models).slice(0, 4).map(m => m.id);
    const paid = candidateModels(module.id, "paid", models).slice(0, 4).map(m => m.id);
    recommendations[module.id] = { free, paid };
  }
  return {
    modelUsed: null,
    source: "deterministic-fallback",
    generatedAt: new Date().toISOString(),
    recommendations,
    note: "Free planner unavailable or returned invalid output. Candidates are ranked from live model metadata, modalities, and token prices."
  };
}
function safeRecommendations(value: unknown, fallback: CapabilityRecommendations, models: LiveGatewayModel[]): CapabilityRecommendations {
  if (!value || typeof value !== "object") return fallback;
  const raw = value as Record<string, unknown>;
  const rawRecommendations = raw.recommendations && typeof raw.recommendations === "object" ? raw.recommendations as Record<string, unknown> : raw;
  const byId = new Map(models.map(model => [model.id, model]));
  const recommendations: Record<string, CapabilityRecommendation> = {};
  for (const module of GATEWAY_MODULES) {
    const rawEntry = rawRecommendations[module.id];
    const candidate = rawEntry && typeof rawEntry === "object" ? rawEntry as Record<string, unknown> : {};
    const filterIds = (value: unknown, tier: "free-tier" | "paid") => {
      if (!Array.isArray(value)) return [];
      return Array.from(new Set(value.filter((id): id is string => typeof id === "string" && byId.has(id) && byId.get(id)?.tier === tier))).slice(0, 4);
    };
    const free = filterIds(candidate.free, "free-tier");
    const paid = filterIds(candidate.paid, "paid");
    recommendations[module.id] = {
      free: free.length ? free : fallback.recommendations[module.id]?.free ?? [],
      paid: paid.length ? paid : fallback.recommendations[module.id]?.paid ?? [],
      freeReason: typeof candidate.freeReason === "string" ? candidate.freeReason.slice(0, 200) : undefined,
      paidReason: typeof candidate.paidReason === "string" ? candidate.paidReason.slice(0, 200) : undefined
    };
  }
  return {
    modelUsed: typeof raw.modelUsed === "string" ? raw.modelUsed : null,
    source: "free-ai-planner",
    generatedAt: new Date().toISOString(),
    recommendations,
    note: "The free planner recommends from live OpenRouter IDs only; every listed model remains untested until a model check succeeds."
  };
}

export async function getCapabilityRecommendations(forceRefresh = false): Promise<CapabilityRecommendations> {
  const live = await getLiveGatewayModels();
  const signature = createHash("sha256").update(live.models.map(m => m.id).join("|")).digest("hex");
  if (!forceRefresh && recommendationCache && recommendationCache.expiresAt > Date.now() && recommendationCache.signature === signature) {
    return recommendationCache.value;
  }
  const fallback = fallbackRecommendations(live.models);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return fallback;
  const rawModels = await getOpenRouterModels();
  const freeCandidates = rawModels.models.filter(model => isFreeOpenRouterModel(model) && isTextChatModel(model));
  const requestedPlanner = process.env.OPENROUTER_PLANNER_MODEL;
  const planner = freeCandidates.find(model => model.id === requestedPlanner) ||
    freeCandidates.find(model => model.id === "google/gemma-4-31b-it:free") ||
    freeCandidates[0];
  if (!planner) {
    recommendationCache = { expiresAt: Date.now() + RECOMMENDATION_CACHE_MS, signature, value: fallback };
    return fallback;
  }
  const candidatePayload: Record<string, { free: Array<{ id: string; name: string; modalities: string[]; context: number; inputUsdPerMillion: number; outputUsdPerMillion: number; tasks: string[] }>; paid: Array<{ id: string; name: string; modalities: string[]; context: number; inputUsdPerMillion: number; outputUsdPerMillion: number; tasks: string[] }> }> = {};
  for (const module of GATEWAY_MODULES) {
    const makeSummary = (mode: "free" | "paid") => candidateModels(module.id, mode, live.models).map(model => ({
      id: model.id,
      name: model.label.slice(0, 90),
      modalities: model.inputModalities,
      context: model.contextLength ?? 0,
      inputUsdPerMillion: model.usdInputPerMillion,
      outputUsdPerMillion: model.usdOutputPerMillion,
      tasks: model.tasks.slice(0, 12)
    }));
    candidatePayload[module.id] = {
      free: makeSummary("free") as typeof candidatePayload[string]["free"],
      paid: makeSummary("paid") as typeof candidatePayload[string]["paid"]
    };
  }
  const taskContexts: Record<string, string> = {
    reasoning: "Complex UX decisions and task planning. For the two proving projects, reason about Batch 3 wireframe acceptance, plus DMI VKYC and credit-report flow alternatives.",
    classification: "Classify incoming design tasks, stakeholder comments, feedback themes, issue severity, and routing for Express Computers Batch 3 and DMI Finance.",
    extraction: "Turn briefs and reference screens into structured requirements, field lists, validation rules, states, acceptance criteria, and unanswered questions.",
    summarization: "Summarize briefs, Batch 1/2 references, stakeholder notes, meeting transcripts, and DMI verification/credit-report requirements without inventing facts.",
    vision: "Inspect UI screenshots and wireframe images; compare hierarchy, visible states, text, spacing, affordances, OTP/VKYC screens and credit-report entry points.",
    critique: "Evidence-based UX and UI review; financial consent and verification usability, consistency with prior wireframe batches, accessibility, edge cases and trust.",
    general: "General UX Director assistant calls shared by Express Computers Batch 3 and DMI Finance."
  };
  const prompt = JSON.stringify({
    instruction: "Return valid JSON only, with shape {\"recommendations\":{\"module-id\":{\"free\":[\"exact-id\"],\"paid\":[\"exact-id\"],\"freeReason\":\"short reason\",\"paidReason\":\"short reason\"}}}. For every capability, rank up to 4 FREE models and up to 4 PAID models from only that capability's supplied candidate arrays. Do not invent IDs. Free IDs must come from free; paid IDs must come from paid. Match modalities and tasks, prefer quality and reliability; among comparable paid models prefer better estimated cost. No claims of live availability; options are catalog-listed and still need an explicit test.",
    useCases: {
      "Express Computers Batch 3": "Continue wireframes from Batch 1/2 patterns, map requirements to screens, fill UX content, synthesize review feedback, enforce design consistency, and package review-ready deliverables.",
      "DMI Finance": "VKYC entry tile/banner and end-to-end flow, PAN/DOB and OTP states where applicable, consent, credit-report entry point, errors/retry states, financial-service UX clarity and compliance caveats requiring client validation."
    },
    capabilities: GATEWAY_MODULES.map(module => ({ id: module.id, name: module.label, description: module.description, tasks: module.tasks, context: taskContexts[module.id] ?? module.description, candidates: candidatePayload[module.id] }))
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 22_000);
  let value = fallback;
  try {
    const response = await fetch(baseUrl() + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        model: planner.id,
        messages: [
          { role: "system", content: "You are UX Direct's low-cost model-selection planner. Use only metadata supplied by the backend. Never claim that a listed model is healthy or available. Return strict JSON, no markdown." },
          { role: "user", content: prompt }
        ],
        temperature: 0,
        max_tokens: 1800
      }),
      cache: "no-store",
      signal: controller.signal
    });
    if (response.ok) {
      const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content === "string") {
        const start = content.indexOf("{");
        const end = content.lastIndexOf("}");
        if (start >= 0 && end > start) {
          try {
            const parsed = JSON.parse(content.slice(start, end + 1));
            value = safeRecommendations({ ...(parsed as object), modelUsed: planner.id }, fallback, live.models);
          } catch { value = fallback; }
        }
      }
    }
  } catch { value = fallback; }
  finally { clearTimeout(timeout); }
  recommendationCache = { expiresAt: Date.now() + RECOMMENDATION_CACHE_MS, signature, value };
  return value;
}
