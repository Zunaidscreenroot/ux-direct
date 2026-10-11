/**
 * Zero-cost model gateway for UX Direct.
 *
 * The gateway is application code, not a paid proxy service. It forwards requests
 * directly to provider APIs, so only the selected model/provider usage is billed.
 * Supports OpenAI-compatible endpoints (including OpenRouter and local gateways).
 */
export type ChatRole = "system" | "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

export type GatewayRequest = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  signal?: AbortSignal;
};

export type GatewayResponse = {
  id?: string;
  model?: string;
  content: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  provider: string;
  latencyMs: number;
};

export type ProviderConfig = {
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
  headers?: Record<string, string>;
};

export class GatewayError extends Error {
  constructor(message: string, public status = 502, public provider?: string) {
    super(message);
    this.name = "GatewayError";
  }
}

const trimSlash = (value: string) => value.replace(/\/+$/, "");

export function providersFromEnv(env: Record<string, string | undefined> = process.env): ProviderConfig[] {
  const providers: ProviderConfig[] = [];
  const openRouterModels = (env.OPENROUTER_MODELS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (env.OPENROUTER_API_KEY) providers.push({
    name: "openrouter",
    baseUrl: trimSlash(env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"),
    apiKey: env.OPENROUTER_API_KEY,
    models: openRouterModels.length ? openRouterModels : ["openrouter/auto"]
  });

  const openAIModels = (env.OPENAI_MODELS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (env.OPENAI_API_KEY) providers.push({
    name: "openai",
    baseUrl: trimSlash(env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
    apiKey: env.OPENAI_API_KEY,
    models: openAIModels.length ? openAIModels : ["gpt-4o-mini"]
  });

  const customKey = env.CUSTOM_OPENAI_COMPATIBLE_API_KEY;
  const customUrl = env.CUSTOM_OPENAI_COMPATIBLE_BASE_URL;
  if (customUrl) providers.push({
    name: "custom",
    baseUrl: trimSlash(customUrl),
    apiKey: customKey,
    models: (env.CUSTOM_OPENAI_COMPATIBLE_MODELS || "default").split(",").map(s => s.trim()).filter(Boolean)
  });

  return providers;
}

export function resolveProvider(model: string, providers: ProviderConfig[]): ProviderConfig {
  const exact = providers.find(provider => provider.models.includes(model));
  if (exact) return exact;
  // Explicit provider/model names can be routed to the matching provider when its
  // model allowlist is empty or includes the requested model.
  const prefix = model.includes("/") ? model.split("/", 1)[0].toLowerCase() : "";
  const byName = providers.find(provider => provider.name.toLowerCase() === prefix);
  if (byName && (byName.models.includes("openrouter/auto") || byName.models.includes("default"))) return byName;
  throw new GatewayError(`Model "${model}" is not configured in the gateway allowlist.`, 400);
}

export async function chatCompletion(
  request: GatewayRequest,
  options: { providers?: ProviderConfig[]; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<GatewayResponse> {
  if (!request.model?.trim()) throw new GatewayError("A model is required.", 400);
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new GatewayError("At least one chat message is required.", 400);
  }
  const providers = options.providers ?? providersFromEnv();
  const provider = resolveProvider(request.model, providers);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 45_000);
  const abort = () => controller.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  const started = Date.now();

  try {
    const response = await fetchImpl(`${trimSlash(provider.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        ...provider.headers
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.max_tokens !== undefined ? { max_tokens: request.max_tokens } : {})
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 1200);
      throw new GatewayError(`Provider returned HTTP ${response.status}: ${body || response.statusText}`, 502, provider.name);
    }
    let payload: any;
    try { payload = await response.json(); }
    catch { throw new GatewayError("Provider returned invalid JSON.", 502, provider.name); }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new GatewayError("Provider response did not contain choices[0].message.content.", 502, provider.name);
    return {
      id: typeof payload.id === "string" ? payload.id : undefined,
      model: typeof payload.model === "string" ? payload.model : request.model,
      content,
      usage: payload.usage,
      provider: provider.name,
      latencyMs: Date.now() - started
    };
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if (controller.signal.aborted) throw new GatewayError("Model request timed out or was cancelled.", 504, provider.name);
    throw new GatewayError(error instanceof Error ? error.message : "Unknown provider error.", 502, provider.name);
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abort);
  }
}
