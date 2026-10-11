/**
 * Zero-fee model gateway for UX Direct.
 * Requests go directly to provider APIs. No gateway SaaS, account, or usage fee.
 * Provider usage may still cost money; local inference uses your own compute.
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
export type TokenUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
export type GatewayResponse = {
  id?: string;
  model?: string;
  content: string;
  usage?: TokenUsage;
  provider: string;
  latencyMs: number;
};
export type ProviderConfig = {
  name: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyHeader?: string;
  models: string[];
  headers?: Record<string, string>;
  kind?: "local" | "free-tier" | "paid" | "mock";
};
export class GatewayError extends Error {
  constructor(message: string, public status = 502, public provider?: string) {
    super(message);
    this.name = "GatewayError";
  }
}
const trimSlash = (value: string) => value.replace(/\/+$/, "");
const csv = (value?: string, fallback = "") =>
  (value || fallback).split(",").map(s => s.trim()).filter(Boolean);

export function providersFromEnv(env: Record<string, string | undefined> = process.env): ProviderConfig[] {
  const providers: ProviderConfig[] = [];
  // Always register a deterministic mock so tests and empty-credential installs work.
  // Task routing prefers configured real providers and uses mock only as the last resort.
  providers.push({ name: "mock", baseUrl: "mock://local", models: ["mock/ux-direct"], kind: "mock" });
  const openRouterModels = csv(env.OPENROUTER_MODELS).filter(model =>
    env.ALLOW_PAID_MODELS === "true" || model.endsWith(":free")
  );
  if (env.OPENROUTER_API_KEY && openRouterModels.length) providers.push({
    name: "openrouter", baseUrl: trimSlash(env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"),
    apiKey: env.OPENROUTER_API_KEY, models: openRouterModels, kind: env.ALLOW_PAID_MODELS === "true" ? "paid" : "free-tier"
  });
  if (env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY) providers.push({
    name: "gemini", baseUrl: trimSlash(env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai"),
    apiKey: env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY, apiKeyHeader: "x-goog-api-key",
    models: csv(env.GEMINI_MODELS || env.GOOGLE_GENERATIVE_AI_MODELS, "gemini-3.5-flash"), kind: "free-tier"
  });
  if (env.GROQ_API_KEY) providers.push({
    name: "groq", baseUrl: trimSlash(env.GROQ_BASE_URL || "https://api.groq.com/openai/v1"),
    apiKey: env.GROQ_API_KEY, models: csv(env.GROQ_MODELS, "openai/gpt-oss-120b,openai/gpt-oss-20b"), kind: "free-tier"
  });
  if (env.CEREBRAS_API_KEY) providers.push({
    name: "cerebras", baseUrl: trimSlash(env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1"),
    apiKey: env.CEREBRAS_API_KEY, models: csv(env.CEREBRAS_MODELS, "gpt-oss-120b"), kind: "free-tier"
  });
  // Paid inference requires a separate explicit opt-in, even if a key is present.
  if (env.OPENAI_API_KEY && env.ALLOW_PAID_MODELS === "true") providers.push({
    name: "openai", baseUrl: trimSlash(env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
    apiKey: env.OPENAI_API_KEY, models: csv(env.OPENAI_MODELS, "gpt-4o-mini"), kind: "paid"
  });
  const customKind = env.CUSTOM_OPENAI_COMPATIBLE_KIND === "local" ? "local" : "paid";
  if (env.CUSTOM_OPENAI_COMPATIBLE_BASE_URL && (customKind === "local" || env.ALLOW_PAID_MODELS === "true")) providers.push({
    name: "custom", baseUrl: trimSlash(env.CUSTOM_OPENAI_COMPATIBLE_BASE_URL),
    apiKey: env.CUSTOM_OPENAI_COMPATIBLE_API_KEY, models: csv(env.CUSTOM_OPENAI_COMPATIBLE_MODELS, "default"),
    kind: customKind
  });
  if (env.OLLAMA_BASE_URL) providers.push({
    name: "ollama", baseUrl: trimSlash(env.OLLAMA_BASE_URL),
    models: csv(env.OLLAMA_MODELS, "default"), kind: "local"
  });
  return providers;
}

export type ModelCatalogEntry = {
  id: string; provider: string; label: string; tier: "local" | "free-tier" | "paid" | "mock";
  tasks: string[]; configured: boolean; notes: string;
};
export function getModelCatalog(providers = providersFromEnv()): ModelCatalogEntry[] {
  const defaults: Omit<ModelCatalogEntry, "configured">[] = [
    { id: "mock/ux-direct", provider: "mock", label: "UX Direct deterministic mock", tier: "mock", tasks: ["tests", "scaffolding"], notes: "No credentials; deterministic response for wiring and smoke tests." },
    { id: "qwen2.5:7b", provider: "ollama", label: "Qwen 2.5 7B (local)", tier: "local", tasks: ["classification", "extraction", "summaries"], notes: "Install and download with Ollama; local disk/RAM required." },
    { id: "gemma4:31b", provider: "ollama", label: "Gemma 4 31B (local)", tier: "local", tasks: ["ux critique", "reasoning", "vision when supported"], notes: "Large local model; hardware requirements can be substantial." },
    { id: "gemini-3.5-flash", provider: "gemini", label: "Gemini Flash", tier: "free-tier", tasks: ["reasoning", "summaries", "vision"], notes: "Google AI Studio free quota may apply; quota/model availability varies by account and region." },
    { id: "openai/gpt-oss-120b", provider: "groq", label: "GPT OSS 120B on Groq", tier: "free-tier", tasks: ["reasoning", "critique", "structured output"], notes: "Free developer quotas are rate-limited and may change." },
    { id: "openai/gpt-oss-20b", provider: "groq", label: "GPT OSS 20B on Groq", tier: "free-tier", tasks: ["classification", "extraction", "fast drafts"], notes: "Free developer quotas are rate-limited and may change." },
    { id: "gpt-oss-120b", provider: "cerebras", label: "GPT OSS 120B on Cerebras", tier: "free-tier", tasks: ["reasoning", "critique"], notes: "Check account-specific free quota and model ID in provider console." },
    { id: "gpt-4o-mini", provider: "openai", label: "OpenAI GPT-4o mini", tier: "paid", tasks: ["reasoning", "vision"], notes: "Paid provider; deliberately disabled until a key and model allowlist are configured." }
  ];
  const known = defaults.map(entry => ({
    ...entry,
    configured: providers.some(p => p.name === entry.provider &&
      (p.models.includes(entry.id) || p.models.includes("default")))
  }));
  const extras: ModelCatalogEntry[] = providers.flatMap(provider =>
    provider.models.filter(model => model !== "default" && !known.some(entry => entry.id === model && entry.provider === provider.name))
      .map(id => ({
        id, provider: provider.name,
        label: `${provider.name}: ${id}`,
        tier: provider.kind ?? "paid",
        tasks: provider.kind === "local" ? ["classification", "extraction", "summaries"] :
          provider.kind === "free-tier" ? ["general", "reasoning", "critique"] : ["general"],
        configured: true,
        notes: provider.kind === "free-tier" ? "Provider free quota and availability can change; verify before production use." :
          provider.kind === "local" ? "Runs on your configured local/custom endpoint." : "Provider usage may be billed."
      }))
  );
  const combined = [...known, ...extras];
  return combined.filter((entry, index) =>
    combined.findIndex(other => other.id === entry.id && other.provider === entry.provider) === index
  );
}

export function resolveProvider(model: string, providers: ProviderConfig[]): ProviderConfig {
  const exact = providers.find(provider => provider.models.includes(model));
  if (exact) return exact;
  // Local/custom endpoints may intentionally expose a default model allowlist.
  const defaults = providers.filter(provider => provider.models.includes("default") && ["ollama", "custom"].includes(provider.name));
  if (defaults.length === 1) return defaults[0];
  const prefix = model.includes("/") ? model.split("/", 1)[0].toLowerCase() : "";
  const byName = providers.find(provider => provider.name.toLowerCase() === prefix);
  if (byName && byName.models.includes("openrouter/auto")) return byName;
  throw new GatewayError(`Model "${model}" is not configured in the gateway allowlist.`, 400);
}

export async function chatCompletion(
  request: GatewayRequest,
  options: { providers?: ProviderConfig[]; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<GatewayResponse> {
  if (!request.model?.trim()) throw new GatewayError("A model is required.", 400);
  if (!Array.isArray(request.messages) || request.messages.length === 0) throw new GatewayError("At least one chat message is required.", 400);
  if (request.messages.some(m => !m || !["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string")) {
    throw new GatewayError("Messages must contain a supported role and string content.", 400);
  }
  if (request.messages.reduce((n, m) => n + m.content.length, 0) > 200_000) throw new GatewayError("Request content exceeds the 200,000-character limit.", 413);
  const providers = options.providers ?? providersFromEnv();
  const aliases: Record<string, "classify" | "extract" | "summarize" | "ux-reasoning" | "vision" | "critique"> = {
    "uxd/classify": "classify",
    "uxd/extract": "extract",
    "uxd/summarize": "summarize",
    "uxd/reasoning": "ux-reasoning",
    "uxd/vision": "vision",
    "uxd/critique": "critique"
  };
  const resolvedModel = aliases[request.model] ? routeTask(aliases[request.model], providers).id : request.model;
  const provider = resolveProvider(resolvedModel, providers);
  const started = Date.now();
  if (provider.kind === "mock" || provider.baseUrl.startsWith("mock://")) {
    const lastUser = [...request.messages].reverse().find(m => m.role === "user")?.content ?? "";
    return { model: resolvedModel, content: `[UX Direct mock — no model API called] Received ${lastUser.length} characters. Configure a local or free-tier provider to enable real inference.`, provider: provider.name, latencyMs: Date.now() - started, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 45_000);
  const abort = () => controller.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(provider.apiKey ? (provider.apiKeyHeader ? { [provider.apiKeyHeader]: provider.apiKey } : { Authorization: `Bearer ${provider.apiKey}` }) : {}),
      ...provider.headers
    };
    const response = await fetchImpl(`${trimSlash(provider.baseUrl)}/chat/completions`, {
      method: "POST", headers,
      body: JSON.stringify({
        model: resolvedModel, messages: request.messages,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.max_tokens !== undefined ? { max_tokens: request.max_tokens } : {})
      }), signal: controller.signal
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 600);
      throw new GatewayError(`Provider returned HTTP ${response.status}: ${body || response.statusText}`, response.status === 429 ? 429 : 502, provider.name);
    }
    let payload: any;
    try { payload = await response.json(); } catch { throw new GatewayError("Provider returned invalid JSON.", 502, provider.name); }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new GatewayError("Provider response did not contain choices[0].message.content.", 502, provider.name);
    return {
      id: typeof payload.id === "string" ? payload.id : undefined,
      model: typeof payload.model === "string" ? payload.model : resolvedModel,
      content, usage: payload.usage, provider: provider.name, latencyMs: Date.now() - started
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

export function routeTask(task: "classify" | "extract" | "summarize" | "ux-reasoning" | "vision" | "critique", providers = providersFromEnv()) {
  const priorities: Record<typeof task, string[]> = {
    classify: ["qwen2.5:7b", "openai/gpt-oss-20b", "gemini-3.5-flash", "mock/ux-direct"],
    extract: ["qwen2.5:7b", "openai/gpt-oss-20b", "gemini-3.5-flash", "mock/ux-direct"],
    summarize: ["qwen2.5:7b", "openai/gpt-oss-20b", "gemini-3.5-flash", "mock/ux-direct"],
    "ux-reasoning": ["gemini-3.5-flash", "openai/gpt-oss-120b", "gpt-oss-120b", "mock/ux-direct"],
    vision: ["gemini-3.5-flash", "mock/ux-direct"],
    critique: ["openai/gpt-oss-120b", "gpt-oss-120b", "gemini-3.5-flash", "mock/ux-direct"]
  };
  const catalog = getModelCatalog(providers);
  for (const id of priorities[task]) {
    const entry = catalog.find(m => m.id === id && m.configured);
    if (entry) return entry;
  }
  return catalog.find(m => m.configured && m.tier === "local") ??
    catalog.find(m => m.configured && m.tier === "free-tier") ??
    catalog.find(m => m.provider === "mock") ?? catalog[0];
}


/**
 * Retry/fail over only across explicitly configured local/free providers.
 * Paid providers are never used as implicit fallbacks. Direct model requests
 * remain single-provider; task aliases can use this policy.
 */
export async function chatCompletionWithFallback(
  request: GatewayRequest,
  options: { providers?: ProviderConfig[]; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<GatewayResponse> {
  const taskAliases: Record<string, "classify" | "extract" | "summarize" | "ux-reasoning" | "vision" | "critique"> = {
    "uxd/classify": "classify", "uxd/extract": "extract", "uxd/summarize": "summarize",
    "uxd/reasoning": "ux-reasoning", "uxd/vision": "vision", "uxd/critique": "critique"
  };
  const task = taskAliases[request.model];
  if (!task) return chatCompletion(request, options);
  const providers = options.providers ?? providersFromEnv();
  const catalog = getModelCatalog(providers);
  const first = routeTask(task, providers);
  const candidates = [
    first,
    ...catalog.filter(entry => entry.configured && (entry.tier === "local" || entry.tier === "free-tier"))
  ].filter((entry, index, list) => list.findIndex(other => other.id === entry.id && other.provider === entry.provider) === index);
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await chatCompletion({ ...request, model: candidate.id }, options);
    } catch (error) {
      lastError = error;
      // Never automatically retry a paid provider, even if a caller mislabels a model.
      const provider = providers.find(p => p.name === candidate.provider);
      if (provider?.kind !== "local" && provider?.kind !== "free-tier") throw error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new GatewayError("No configured local or free-tier model could complete this task.", 503);
}
