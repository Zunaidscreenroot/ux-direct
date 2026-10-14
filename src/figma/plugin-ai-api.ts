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

export const PLUGIN_FREE_MODELS = [
  {
    id: "nvidia/nemotron-3.5-lightning:free",
    label: "NVIDIA Nemotron 3.5 Lightning · Free",
    tier: "free-tier" as const,
    supportsImages: false,
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    label: "NVIDIA Nemotron 3 Ultra · Free",
    tier: "free-tier" as const,
    supportsImages: false,
  },
  {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    label: "NVIDIA Nemotron Nano Omni · Free",
    tier: "free-tier" as const,
    supportsImages: true,
  },
] as const;

export const PLUGIN_PAID_MODELS = [
  {
    id: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash 0731 · Paid",
    tier: "paid" as const,
    supportsImages: false,
  },
  {
    id: "deepseek/deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash · Paid",
    tier: "paid" as const,
    supportsImages: true,
  },
  {
    id: "openai/gpt-6-luna",
    label: "GPT-6 Luna · Paid",
    tier: "paid" as const,
    supportsImages: false,
  },
] as const;

type OpenRouterResponsePayload = {
  model?: unknown;
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
    reason: hasApiKey
      ? "Provider key is present. Use Test to verify this model; paid inference may incur an API charge."
      : "OPENROUTER_API_KEY is not configured for this deployment.",
  }));
  return [...freeModels, ...paidModels];
}

export async function callOpenRouterChat(
  model: string,
  messages: PluginChatMessage[],
  options: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<{ content: string; model: string; latencyMs: number }> {
  const provider = getOpenRouterProvider();
  const apiKey = provider?.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new PluginOpenRouterError("OPENROUTER_API_KEY is missing from the Vercel Preview environment.", 503);
  }
  const allowedFree = PLUGIN_FREE_MODELS.some((item) => item.id === model) &&
    Boolean(provider?.models.includes(model));
  const allowedPaid = PLUGIN_PAID_MODELS.some((item) => item.id === model);
  if (!allowedFree && !allowedPaid) {
    throw new PluginOpenRouterError("The requested model is not on UX Direct's approved OpenRouter allowlist.", 403);
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
        max_tokens: Math.max(8, Math.min(options.maxTokens ?? 1200, 2400)),
        temperature: Math.max(0, Math.min(options.temperature ?? 0.2, 1)),
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    const payloadValue: unknown = await response.json().catch(() => ({}));
    const payload = asRecord(payloadValue) as OpenRouterResponsePayload | null;
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new PluginOpenRouterError("OpenRouter rejected the API key or model access (HTTP " + response.status + ").", response.status);
      }
      if (response.status === 429) {
        const rawMessage = payload?.error?.message;
        const raw = typeof rawMessage === "string" ? rawMessage : "";
        const lower = raw.toLowerCase();
        const message = lower.includes("free-models-per-day") || lower.includes("free model requests per day")
          ? raw.slice(0, 280)
          : "OpenRouter free-model requests per day limit or provider rate limit reached (HTTP 429).";
        throw new PluginOpenRouterError(message, 429);
      }
      const errorMessage = payload?.error?.message;
      const detail = typeof errorMessage === "string"
        ? errorMessage.slice(0, 220)
        : "OpenRouter returned HTTP " + response.status + ".";
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
        "OpenRouter model " + model + " returned empty message content (finish_reason=" + finishReason + ").",
        502,
      );
    }
    return {
      content,
      model: typeof payload?.model === "string" ? payload.model : model,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof PluginOpenRouterError) throw error;
    if (controller.signal.aborted) {
      throw new PluginOpenRouterError("OpenRouter request timed out.", 504);
    }
    throw new PluginOpenRouterError(
      error instanceof Error ? error.message : "OpenRouter request failed.",
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}
