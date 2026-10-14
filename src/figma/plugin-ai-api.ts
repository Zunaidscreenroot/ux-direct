import { randomUUID } from "node:crypto";
import { providersFromEnv } from "@/src/model-gateway";
import { checkGatewayRateLimit } from "@/src/model-gateway/rate-limit";

export type PluginChatContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;
export type PluginChatMessage = {
  role: "system" | "user" | "assistant";
  content: PluginChatContent;
};

export interface PluginModelDefinition {
  id: string;
  label: string;
  tier: "free-tier" | "paid";
  supportsImages: boolean;
  supportsStructuredOutput: boolean;
  supportsToolCalling: boolean;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  automaticRouting: boolean;
  specialties: string[];
}

export const PLUGIN_FREE_MODELS: PluginModelDefinition[] = [
  {
    id: "nvidia/nemotron-3.5-lightning:free",
    label: "NVIDIA Nemotron 3.5 Lightning · Free",
    tier: "free-tier",
    supportsImages: false,
    supportsStructuredOutput: false,
    supportsToolCalling: false,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    automaticRouting: true,
    specialties: ["chat", "copy", "handoff"],
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    label: "NVIDIA Nemotron 3 Ultra · Free",
    tier: "free-tier",
    supportsImages: false,
    supportsStructuredOutput: false,
    supportsToolCalling: false,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    automaticRouting: true,
    specialties: ["chat", "copy", "reasoning"],
  },
  {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    label: "NVIDIA Nemotron Nano Omni · Free · Experimental vision",
    tier: "free-tier",
    supportsImages: true,
    supportsStructuredOutput: false,
    supportsToolCalling: false,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    automaticRouting: false,
    specialties: ["vision", "screen-audit"],
  },
];

export const PLUGIN_PAID_MODELS: PluginModelDefinition[] = [
  {
    id: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash 0731 · Paid",
    tier: "paid",
    supportsImages: false,
    supportsStructuredOutput: true,
    supportsToolCalling: true,
    inputUsdPerMillion: 0.0152,
    outputUsdPerMillion: 1.28,
    automaticRouting: false,
    specialties: ["reasoning", "coding", "text-plan"],
  },
  {
    id: "deepseek/deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash · Paid",
    tier: "paid",
    supportsImages: true,
    supportsStructuredOutput: true,
    supportsToolCalling: true,
    inputUsdPerMillion: 0.13,
    outputUsdPerMillion: 0.52,
    automaticRouting: true,
    specialties: ["reasoning", "vision", "structured-plan", "journey-design"],
  },
  {
    id: "anthropic/claude-haiku-5.5",
    label: "Claude Haiku 5.5 · Paid · Low cost",
    tier: "paid",
    supportsImages: true,
    supportsStructuredOutput: true,
    supportsToolCalling: true,
    inputUsdPerMillion: 0.1,
    outputUsdPerMillion: 0.5,
    automaticRouting: true,
    specialties: ["vision", "screen-audit", "copy", "structured-plan"],
  },
  {
    id: "z-ai/glm-4.6v",
    label: "GLM 4.6V · Paid · Visual design",
    tier: "paid",
    supportsImages: true,
    supportsStructuredOutput: true,
    supportsToolCalling: true,
    inputUsdPerMillion: 0.3,
    outputUsdPerMillion: 0.9,
    automaticRouting: true,
    specialties: ["vision", "screen-redesign", "layout-analysis", "ui-reconstruction"],
  },
  {
    id: "moonshotai/kimi-k2.5",
    label: "Kimi K2.5 · Paid · Visual reasoning",
    tier: "paid",
    supportsImages: true,
    supportsStructuredOutput: true,
    supportsToolCalling: true,
    inputUsdPerMillion: 0.45,
    outputUsdPerMillion: 2.25,
    automaticRouting: true,
    specialties: ["vision", "screen-redesign", "agentic-planning", "journey-design"],
  },
  {
    id: "google/gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro · Paid · Complex reasoning",
    tier: "paid",
    supportsImages: true,
    supportsStructuredOutput: true,
    supportsToolCalling: true,
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 12,
    automaticRouting: true,
    specialties: ["vision", "complex-reasoning", "journey-design", "large-context"],
  },
  {
    id: "anthropic/claude-sonnet-5.5",
    label: "Claude Sonnet 5.5 · Paid · Premium quality",
    tier: "paid",
    supportsImages: true,
    supportsStructuredOutput: true,
    supportsToolCalling: true,
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 10,
    automaticRouting: true,
    specialties: ["vision", "premium-redesign", "quality-review", "complex-reasoning"],
  },
  {
    id: "openai/gpt-6-luna",
    label: "GPT-6 Luna · Paid · Manual only (pricing unverified)",
    tier: "paid",
    supportsImages: false,
    supportsStructuredOutput: false,
    supportsToolCalling: false,
    inputUsdPerMillion: null,
    outputUsdPerMillion: null,
    automaticRouting: false,
    specialties: ["manual-test"],
  },
];

type OpenRouterResponsePayload = {
  model?: unknown;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; cost?: unknown };
  error?: { message?: unknown };
  choices?: Array<{ message?: { content?: unknown; reasoning?: unknown }; finish_reason?: unknown }>;
};
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export class PluginOpenRouterError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "PluginOpenRouterError";
    this.status = status;
  }
}

export type HourlyPaidBudgetReservation = {
  allowed: boolean;
  spentInr: number;
  projectedInr: number;
  limitInr: number;
  remainingInr: number;
  reservedInr: number;
};

function positiveEnvNumber(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0 || value > maximum) return fallback;
  return value;
}

/**
 * Reserve estimated maximum spend for one paid model attempt in a shared,
 * transactionally serialized rolling 60-minute budget. Failed attempts remain
 * reserved because providers may bill even when their response is unusable.
 * Fails closed when the persistent database cannot verify the budget.
 */
export async function reserveHourlyPaidModelBudget(input: {
  estimatedCostUsd: number;
  model: string;
  requestId?: string;
}): Promise<HourlyPaidBudgetReservation> {
  const hourlyLimitInr = positiveEnvNumber("UXD_MODEL_BUDGET_INR_PER_HOUR", 50, 500);
  const usdToInr = positiveEnvNumber("UXD_USD_TO_INR_RATE", 100, 250);
  const safetyMultiplier = positiveEnvNumber("UXD_MODEL_COST_SAFETY_MULTIPLIER", 1.5, 5);
  if (!Number.isFinite(input.estimatedCostUsd) || input.estimatedCostUsd <= 0 || input.estimatedCostUsd > 1) {
    throw new PluginOpenRouterError("Estimated paid-model cost is invalid; paid inference is blocked.", 402);
  }

  const supabaseUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  if (!supabaseUrl || !serviceKey) {
    throw new PluginOpenRouterError("The shared hourly spend ledger is unavailable. Paid inference is blocked to protect the ₹" + hourlyLimitInr + "/hour budget.", 503);
  }

  const reservedInr = Math.max(0.0001, Number((input.estimatedCostUsd * usdToInr * safetyMultiplier).toFixed(6)));
  const requestId = (input.requestId || randomUUID()).slice(0, 120);
  let response: Response;
  try {
    response = await fetch(supabaseUrl + "/rest/v1/rpc/reserve_uxd_model_budget", {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: "Bearer " + serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_scope: "ux-direct:shared-paid-inference",
        p_amount_inr: reservedInr,
        p_hourly_limit_inr: hourlyLimitInr,
        p_model: input.model,
        p_request_id: requestId,
      }),
      cache: "no-store",
    });
  } catch {
    throw new PluginOpenRouterError("The shared hourly spend ledger could not be reached. Paid inference is blocked; free-model tasks remain available.", 503);
  }

  if (!response.ok) {
    throw new PluginOpenRouterError("The shared hourly spend ledger could not verify the limit (HTTP " + response.status + "). Paid inference is blocked.", 503);
  }
  const payload: unknown = await response.json().catch(() => null);
  const row = Array.isArray(payload) && payload.length ? payload[0] : null;
  if (!row || typeof row !== "object") {
    throw new PluginOpenRouterError("The shared hourly spend ledger returned an invalid result. Paid inference is blocked.", 503);
  }
  const result = row as Record<string, unknown>;
  const reservation: HourlyPaidBudgetReservation = {
    allowed: result.allowed === true,
    spentInr: Number(result.spent_inr ?? 0),
    projectedInr: Number(result.projected_inr ?? 0),
    limitInr: Number(result.limit_inr ?? hourlyLimitInr),
    remainingInr: Number(result.remaining_inr ?? 0),
    reservedInr,
  };
  if (![reservation.spentInr, reservation.projectedInr, reservation.limitInr, reservation.remainingInr].every(Number.isFinite)) {
    throw new PluginOpenRouterError("The shared hourly spend ledger returned invalid amounts. Paid inference is blocked.", 503);
  }
  return reservation;
}

export async function getHourlyPaidModelBudgetStatus(): Promise<{
  spentInr: number;
  limitInr: number;
  remainingInr: number;
  windowMinutes: number;
} | null> {
  const limitInr = positiveEnvNumber("UXD_MODEL_BUDGET_INR_PER_HOUR", 50, 500);
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  if (!supabaseUrl || !serviceKey) return null;
  try {
    const response = await fetch(supabaseUrl + "/rest/v1/rpc/uxd_model_budget_status", {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: "Bearer " + serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_scope: "ux-direct:shared-paid-inference", p_hourly_limit_inr: limitInr }),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json().catch(() => null);
    const row = Array.isArray(payload) && payload.length ? payload[0] : null;
    if (!row || typeof row !== "object") return null;
    const value = row as Record<string, unknown>;
    const result = {
      spentInr: Number(value.spent_inr ?? 0),
      limitInr: Number(value.limit_inr ?? limitInr),
      remainingInr: Number(value.remaining_inr ?? 0),
      windowMinutes: Number(value.window_minutes ?? 60),
    };
    return Object.values(result).every(Number.isFinite) ? result : null;
  } catch {
    return null;
  }
}

export function pluginCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const selfOrigin = new URL(request.url).origin;
  const allowedOrigin =
    origin && (origin === selfOrigin || PLUGIN_ORIGINS.has(origin))
      ? origin
      : selfOrigin;
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
}

const PLUGIN_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);

export function isAllowedPluginOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin || PLUGIN_ORIGINS.has(origin);
}

export function checkPluginRateLimit(request: Request) {
  const ip =
    request.headers.get("x-vercel-forwarded-for") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-nf-client-connection-ip") ||
    "unknown";
  return checkGatewayRateLimit(ip);
}

export function getOpenRouterProvider() {
  return providersFromEnv().find((provider) => provider.name === "openrouter");
}

export function getPluginModelList() {
  const provider = getOpenRouterProvider();
  const configuredFreeIds = new Set(provider?.models ?? []);
  const hasApiKey = Boolean(process.env.OPENROUTER_API_KEY);
  const freeModels = PLUGIN_FREE_MODELS
    .filter((model) => hasApiKey && configuredFreeIds.has(model.id))
    .map((model) => ({
      ...model,
      provider: "openrouter" as const,
      available: true,
      reason: "",
    }));
  const paidModels = PLUGIN_PAID_MODELS.map((model) => ({
    ...model,
    provider: "openrouter" as const,
    available: hasApiKey,
    reason: !hasApiKey
      ? "Model service credentials are not configured for this deployment."
      : model.inputUsdPerMillion === null || model.outputUsdPerMillion === null
        ? "Manual-only: current pricing/capabilities have not been verified, so automatic routing is disabled."
        : "Model is configured. Use Test to verify it before routing; paid inference may incur an API charge.",
  }));
  return [...freeModels, ...paidModels];
}

export async function callOpenRouterChat(
  model: string,
  messages: PluginChatMessage[],
  options: { maxTokens?: number; temperature?: number; timeoutMs?: number; reasoningEffort?: "low" | "medium" | "high" } = {},
): Promise<{
  content: string;
  model: string;
  latencyMs: number;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null };
  observedCostUsd: number | null;
}> {
  const provider = getOpenRouterProvider();
  const apiKey = provider?.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new PluginOpenRouterError("Model service credentials are missing from this Vercel deployment.", 503);
  }
  const allowedFree = PLUGIN_FREE_MODELS.some((item) => item.id === model) &&
    Boolean(provider?.models.includes(model));
  const allowedPaid = PLUGIN_PAID_MODELS.some((item) => item.id === model);
  if (!allowedFree && !allowedPaid) {
    throw new PluginOpenRouterError("The requested model is not on UX Direct's approved model list.", 403);
  }

  const baseUrl = (process.env.OPENROUTER_BASE_URL || provider?.baseUrl || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);
  const startedAt = Date.now();
  try {
    const response = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://www.figma.com",
        "X-Title": "UX Direct Conversational Cockpit",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: Math.max(8, Math.min(options.maxTokens ?? 1200, 4500)),
        temperature: Math.max(0, Math.min(options.temperature ?? 0.2, 1)),
        ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    const payloadValue: unknown = await response.json().catch(() => ({}));
    const payload = asRecord(payloadValue) as OpenRouterResponsePayload | null;
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new PluginOpenRouterError("The model service rejected credentials or model access (HTTP " + response.status + ").", response.status);
      }
      if (response.status === 429) {
        const rawMessage = payload?.error?.message;
        const raw = typeof rawMessage === "string" ? rawMessage : "";
        const lower = raw.toLowerCase();
        const message = lower.includes("free-models-per-day") || lower.includes("free model requests per day")
          ? "The daily free-model quota was reached. Try another approved model or retry after the quota resets."
          : "The model service rate limit was reached (HTTP 429).";
        throw new PluginOpenRouterError(message, 429);
      }
      const errorMessage = payload?.error?.message;
      const detail = typeof errorMessage === "string"
        ? errorMessage.slice(0, 220)
        : "The model service returned HTTP " + response.status + ".";
      throw new PluginOpenRouterError(detail, response.status);
    }

    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    const choice = choices[0];
    const rawContent = choice?.message?.content;
    const content = typeof rawContent === "string"
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent.map((part: unknown) => {
            const record = asRecord(part);
            return typeof record?.text === "string" ? record.text : "";
          }).join("\n").trim()
        : "";
    if (!content.trim()) {
      const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "unknown";
      // Do not return private reasoning as user-facing content. Let the chat route try
      // the next explicitly approved model and expose bounded diagnostics if all fail.
      throw new PluginOpenRouterError(
        "Model " + model + " returned empty message content (finish_reason=" + finishReason + ").",
        502,
      );
    }
    const usage = asRecord(payload?.usage);
    const metric = (value: unknown): number | null => {
      const number = typeof value === "number" ? value : Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    return {
      content,
      model: typeof payload?.model === "string" ? payload.model : model,
      latencyMs: Date.now() - startedAt,
      usage: {
        promptTokens: metric(usage?.prompt_tokens),
        completionTokens: metric(usage?.completion_tokens),
        totalTokens: metric(usage?.total_tokens),
      },
      observedCostUsd: metric(usage?.cost),
    };
  } catch (error) {
    if (error instanceof PluginOpenRouterError) throw error;
    if (controller.signal.aborted) {
      throw new PluginOpenRouterError("The model service request timed out.", 504);
    }
    throw new PluginOpenRouterError(
      error instanceof Error ? error.message : "The model service request failed.",
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}
