import { GATEWAY_MODULES, defaultGatewaySettings, getGatewaySettings, getDefaultModelPolicy, modelKey } from "./control-store";
import {
  getOpenRouterFreeChatModel,
  getOpenRouterPaidChatModel,
  OPENROUTER_FREE_CHAT_MODELS,
  OPENROUTER_PAID_CHAT_MODELS,
  selectOpenRouterPaidChatModel,
  selectOpenRouterPaidVisionModel
} from "./openrouter-paid";
/**
 * OpenRouter-backed model gateway for UX Direct.
 * OpenRouter is the provider gateway and its account/key limits govern billable usage.
 * UX Direct maintains usage telemetry and conservative cost estimates, not spending caps.
 */
export type ChatRole = "system" | "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };
export type GatewayRequest = {
  model: string;
  requestId?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  signal?: AbortSignal;
  reasoning?: { effort?: "minimal" | "low" | "medium" | "high"; max_tokens?: number };
  moduleId?: string;
  /** Server-derived budget envelope; never a model override. */
  budgetModuleId?: string;
  providerId?: string;
  /** Set only by the server-side allowlisted OpenRouter paid-model helper. */
  openRouterPaidSelection?: boolean;
  /** Internal flag for a fixed allowlisted free OpenRouter attempt. */
  openRouterFreeSelection?: boolean;
  /** Optional approved paid model preference, used only after free attempts fail. */
  preferredPaidModelId?: string;
  /** Bounded JPEG data URL, added only to an approved image-capable model call. */
  imageDataUrl?: string;
  /** Server-only: structured Figma edit plans use low-cost paid vision for reliable JSON output. */
  forcePaidVision?: boolean;
};
export type TokenUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
type ProviderChatMessage = {
  content?: unknown;
  refusal?: unknown;
  reasoning?: unknown;
  reasoning_content?: unknown;
  [key: string]: unknown;
};
type ProviderChatPayload = {
  id?: unknown;
  model?: unknown;
  choices?: Array<{ message?: ProviderChatMessage; finish_reason?: unknown }>;
  usage?: TokenUsage;
  output_text?: unknown;
  error?: unknown;
};

function normalizeChatText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const parts = value.map(part => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const item = part as Record<string, unknown>;
    // OpenAI-compatible providers may return a multipart content array rather
    // than the usual string. Only read user-facing text fields; never expose
    // internal reasoning fields as a completion.
    if (typeof item.text === "string") return item.text;
    if (typeof item.content === "string" && (item.type === "text" || item.type === "output_text")) return item.content;
    return "";
  }).filter(Boolean);
  const text = parts.join("\n").trim();
  return text || undefined;
}
export type GatewayResponse = {
  id?: string;
  model?: string;
  content: string;
  usage?: TokenUsage;
  provider: string;
  latencyMs: number;
  tier?: "free-tier" | "paid";
  routingStrategy?: "free-first" | "vision-direct" | "paid-direct";
  attemptedModels?: string[];
  fallbackReason?: string;
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

export type FreeChatModel = { provider: "openrouter"; id: string; label: string; tier: "free-tier"; configured: boolean };

export function providersForFreeChat(providers = providersFromEnv(), selectedModel?: string): ProviderConfig[] {
  const selected = selectedModel && getOpenRouterFreeChatModel(selectedModel) ? [selectedModel] : [];
  return providers.map(provider => {
    if (provider.name !== "openrouter" || !provider.apiKey) return provider;
    // Never admit a :free model outside the explicit UX Direct allowlist.
    return { ...provider, kind: "free-tier", models: selected };
  });
}

export function getFreeChatModelOptions(providers = providersFromEnv(), discoveredModelIds: string[] = []): FreeChatModel[] {
  const provider = providers.find(item => item.name === "openrouter" && Boolean(item.apiKey));
  if (!provider) return [];
  const discovered = discoveredModelIds.length ? new Set(discoveredModelIds) : null;
  return OPENROUTER_FREE_CHAT_MODELS
    .filter(model => !discovered || discovered.has(model.id))
    .map(model => ({ provider: "openrouter" as const, id: model.id, label: model.label, tier: "free-tier" as const, configured: true }));
}

/** Restrict paid inference through OpenRouter to a tiny server-side allowlist. */
export function providersForOpenRouterPaidChat(
  selectedModel: string,
  providers = providersFromEnv()
): ProviderConfig[] {
  if (!getOpenRouterPaidChatModel(selectedModel)) {
    throw new GatewayError("This OpenRouter paid model is not on the approved low-cost allowlist.", 400, "openrouter");
  }
  return providers.map(provider => {
    if (provider.name !== "openrouter" || !provider.apiKey) return provider;
    // This request-scoped provider config admits only the selected paid ID.
    return { ...provider, kind: "paid", models: [selectedModel] };
  });
}

export function providersFromEnv(env: Record<string, string | undefined> = process.env): ProviderConfig[] {
  const providers: ProviderConfig[] = [];
  // Always register a deterministic mock so tests and empty-credential installs work.
  // Task routing prefers configured real providers and uses mock only as the last resort.
  providers.push({ name: "mock", baseUrl: "mock://local", models: ["mock/ux-direct"], kind: "mock" });
  const paidRoutingReady = env.ALLOW_PAID_MODELS === "true";
  // OpenRouter model IDs are discovered live by /api/model-status.
  // The free-chat path admits only the explicitly selected :free model per request.
  if (env.OPENROUTER_API_KEY) providers.push({
    name: "openrouter", baseUrl: trimSlash(env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"),
    apiKey: env.OPENROUTER_API_KEY, models: [], kind: "free-tier"
  });
  const groqBillingKind = env.GROQ_BILLING_MODE === "paid" ? "paid" : "free-tier";
  if (env.GROQ_API_KEY && (groqBillingKind !== "paid" || paidRoutingReady)) providers.push({
    name: "groq", baseUrl: trimSlash(env.GROQ_BASE_URL || "https://api.groq.com/openai/v1"),
    apiKey: env.GROQ_API_KEY, models: csv(env.GROQ_MODELS, "openai/gpt-oss-120b,openai/gpt-oss-20b"), kind: groqBillingKind
  });
  const cerebrasBillingKind = env.CEREBRAS_BILLING_MODE === "paid" ? "paid" : "free-tier";
  if (env.CEREBRAS_API_KEY && (cerebrasBillingKind !== "paid" || paidRoutingReady)) providers.push({
    name: "cerebras", baseUrl: trimSlash(env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1"),
    apiKey: env.CEREBRAS_API_KEY, models: csv(env.CEREBRAS_MODELS, "gpt-oss-120b"), kind: cerebrasBillingKind
  });
  if (env.OPENAI_API_KEY && paidRoutingReady) providers.push({
    name: "openai", baseUrl: trimSlash(env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
    apiKey: env.OPENAI_API_KEY, models: csv(env.OPENAI_MODELS, "gpt-4o-mini"), kind: "paid"
  });
  if (env.DEEPSEEK_API_KEY && paidRoutingReady) providers.push({
    name: "deepseek", baseUrl: trimSlash(env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"),
    apiKey: env.DEEPSEEK_API_KEY, models: csv(env.DEEPSEEK_MODELS, "deepseek-flash,deepseek-v4-pro"), kind: "paid"
  });
  const customKind = env.CUSTOM_OPENAI_COMPATIBLE_KIND === "local" ? "local" : "paid";
  if (env.CUSTOM_OPENAI_COMPATIBLE_BASE_URL && (customKind === "local" || paidRoutingReady)) providers.push({
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
  id: string; provider: string; label: string; tier: "local" | "free-tier" | "paid" | "mock"; tasks: string[];
  configured: boolean; notes: string; usdInputPerMillion?: number; usdOutputPerMillion?: number; pricingSource?: string; pricingReviewedAt?: string;
};
const GROQ_PRICE_SOURCE = "https://console.groq.com/docs/models";
export function getModelCatalog(providers = providersFromEnv()): ModelCatalogEntry[] {
  const base: Omit<ModelCatalogEntry, "configured">[] = [
    { id: "mock/ux-direct", provider: "mock", label: "UX Direct deterministic mock", tier: "mock", tasks: ["tests","scaffolding"], notes: "No credentials, network, model inference, or billing." },
    { id: "qwen2.5:7b", provider: "ollama", label: "Qwen 2.5 7B · local", tier: "local", tasks: ["classification","extraction","summaries"], notes: "Local compute; install/download with Ollama." },
    { id: "gemma4:31b", provider: "ollama", label: "Gemma 4 31B · local", tier: "local", tasks: ["ux critique","reasoning","vision"], notes: "Large local model; hardware requirements can be substantial." },
    { id: "openai/gpt-oss-120b", provider: "groq", label: "GPT OSS 120B · Groq", tier: "free-tier", tasks: ["reasoning","critique","structured output"], notes: "Free quotas may apply. Published paid price $0.15 input / $0.60 output per 1M tokens.", usdInputPerMillion: .15, usdOutputPerMillion: .6, pricingSource: GROQ_PRICE_SOURCE, pricingReviewedAt: "2026-10-11" },
    { id: "openai/gpt-oss-20b", provider: "groq", label: "GPT OSS 20B · Groq", tier: "free-tier", tasks: ["classification","extraction","fast drafts"], notes: "Free quotas may apply. Published paid price $0.075 input / $0.30 output per 1M tokens.", usdInputPerMillion: .075, usdOutputPerMillion: .3, pricingSource: GROQ_PRICE_SOURCE, pricingReviewedAt: "2026-10-11" },
    { id: "gpt-oss-120b", provider: "cerebras", label: "GPT OSS 120B · Cerebras", tier: "free-tier", tasks: ["reasoning","critique"], notes: "Check model ID and available quota in your account." },
    { id: "apodex/apodex-1.1-mini:free", provider: "openrouter", label: "Apodex 1.1 Mini · OpenRouter free", tier: "free-tier", tasks: ["reasoning","research","summaries"], notes: "Explicit :free model; free availability and rate limits may change." },
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", provider: "openrouter", label: "NVIDIA Nemotron 3 Ultra · free", tier: "free-tier", tasks: ["reasoning","planning","research"], notes: "Current OpenRouter free model; very large reasoning model. Free provider endpoints have rate limits and may log inputs." , pricingSource: "https://openrouter.ai/nvidia/nemotron-3-ultra-550b-a55b:free", pricingReviewedAt: "2026-10-11" },
    { id: "poolside/laguna-s-2.1:free", provider: "openrouter", label: "Poolside Laguna S 2.1 · free", tier: "free-tier", tasks: ["coding","agentic coding","reasoning"], notes: "Free hosted endpoint; provider terms may allow use of prompts/outputs for model improvement. Do not send confidential client data without approval.", pricingSource: "https://openrouter.ai/poolside/laguna-s-2.1:free", pricingReviewedAt: "2026-10-11" },
    { id: "nvidia/nemotron-3.5-lightning:free", provider: "openrouter", label: "NVIDIA Nemotron 3.5 Lightning · free", tier: "free-tier", tasks: ["classification","extraction","high-volume agents"], notes: "Low-cost/high-throughput workload candidate; verify current free endpoint availability.", pricingSource: "https://openrouter.ai/nvidia/nemotron-3.5-lightning:free", pricingReviewedAt: "2026-10-11" },
    { id: "nvidia/nemotron-3-super-120b-a12b:free", provider: "openrouter", label: "NVIDIA Nemotron 3 Super · free", tier: "free-tier", tasks: ["reasoning","legal","translation","multi-agent"], notes: "Free hosted endpoint; rate limits and uptime are provider-dependent.", pricingSource: "https://openrouter.ai/nvidia/nemotron-3-super-120b-a12b:free", pricingReviewedAt: "2026-10-11" },
    { id: "thinkingmachines/inkling:free", provider: "openrouter", label: "Thinking Machines Inkling · free", tier: "free-tier", tasks: ["reasoning","coding","multimodal","vision"], notes: "Free multimodal option; check current endpoint input modalities and account terms.", pricingSource: "https://openrouter.ai/thinkingmachines/inkling:free", pricingReviewedAt: "2026-10-11" },
    { id: "cohere/north-mini-code:free", provider: "openrouter", label: "Cohere North Mini Code · free", tier: "free-tier", tasks: ["coding","agentic coding","structured output"], notes: "Free code-agent endpoint; availability and rate limits can change.", pricingSource: "https://openrouter.ai/cohere/north-mini-code:free", pricingReviewedAt: "2026-10-11" },
    { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", provider: "openrouter", label: "NVIDIA Nemotron Nano Omni · free", tier: "free-tier", tasks: ["vision","screen analysis","multimodal","summaries"], notes: "Free multimodal endpoint for text/image/video/audio understanding; verify endpoint modalities.", pricingSource: "https://openrouter.ai/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", pricingReviewedAt: "2026-10-11" },
    { id: "google/gemma-4-31b-it:free", provider: "openrouter", label: "Gemma 4 31B · OpenRouter free", tier: "free-tier", tasks: ["reasoning","critique","vision","document understanding"], notes: "Verify exact free endpoint availability before activation." },
    { id: "google/gemma-4-26b-a4b-it:free", provider: "openrouter", label: "Gemma 4 26B A4B · OpenRouter free", tier: "free-tier", tasks: ["classification","extraction","summaries","vision"], notes: "Verify exact free endpoint availability before activation." },
    ...OPENROUTER_PAID_CHAT_MODELS.map(model => ({
      id: model.id, provider: "openrouter", label: model.label, tier: "paid" as const,
      tasks: [...model.expertise],
      notes: "Approved paid OpenRouter model. Explicit selection calls this model directly; otherwise it may be used as the single paid fallback after at most two approved free attempts. OpenRouter enforces account/key limits.",
      usdInputPerMillion: model.listedInputUsdPerMillion,
      usdOutputPerMillion: model.listedOutputUsdPerMillion,
      pricingSource: model.pricingSource,
      pricingReviewedAt: "2026-10-12"
    })),
    { id: "deepseek-flash", provider: "deepseek", label: "DeepSeek V4.1 Flash", tier: "paid", tasks: ["classification","extraction","reasoning","vision","summaries"], notes: "Peak-hour conservative rate reference: $0.30 input / $1.20 output per 1M tokens. Off-peak/cached input may be cheaper; API price varies by UTC time.", usdInputPerMillion: .30, usdOutputPerMillion: 1.20, pricingSource: "https://api-docs.deepseek.com/quick_start/pricing/", pricingReviewedAt: "2026-10-11" },
    { id: "deepseek-v4-pro", provider: "deepseek", label: "DeepSeek V4 Pro", tier: "paid", tasks: ["reasoning","critique","complex planning","summaries"], notes: "Peak-hour conservative rate reference: $1.32 input / $3.96 output per 1M tokens. Off-peak/cached input may be cheaper; API price varies by UTC time.", usdInputPerMillion: 1.32, usdOutputPerMillion: 3.96, pricingSource: "https://api-docs.deepseek.com/quick_start/pricing/", pricingReviewedAt: "2026-10-11" },
    { id: "gpt-4o-mini", provider: "openai", label: "OpenAI GPT-4o mini", tier: "paid", tasks: ["classification","extraction","reasoning","vision"], notes: "Published text-token price $0.15 input / $0.60 output per 1M tokens; tool-specific charges may apply.", usdInputPerMillion: .15, usdOutputPerMillion: .6, pricingSource: "https://developers.openai.com/api/docs/models/gpt-4o-mini", pricingReviewedAt: "2026-10-11" }
  ];
  const known = base.map(m => {
    const configuredProvider = providers.find(p => p.name === m.provider && (p.models.includes(m.id) || (p.models.includes("default") && ["ollama","custom"].includes(p.name))));
    const openRouterKeyReady = m.provider === "openrouter" && Boolean(
      providers.find(p => p.name === "openrouter" && p.apiKey) &&
      (getOpenRouterFreeChatModel(m.id) || getOpenRouterPaidChatModel(m.id))
    );
    return {
      ...m,
      ...(configuredProvider?.kind === "paid" && m.tier !== "mock" && m.tier !== "local" ? { tier: "paid" as const } : {}),
      configured: Boolean(configuredProvider) || openRouterKeyReady
    };
  });
  const extras: ModelCatalogEntry[] = providers.flatMap(p => p.models.filter(id => id !== "default" && !known.some(m => m.provider === p.name && m.id === id)).map(id => ({
    id, provider: p.name, label: p.name + ": " + id,
    tier: (id.endsWith(":free") ? "free-tier" : p.kind ?? "paid"),
    tasks: p.kind === "local" ? ["classification","extraction","summaries"] : p.kind === "free-tier" ? ["general","reasoning","critique"] : ["general"],
    configured: true, notes: id.endsWith(":free") ? "Explicit free model. Account quota still applies." : "Verify provider quota and published rates before billing."
  } as ModelCatalogEntry)));
  const unique = [...known, ...extras].filter((m, i, a) => a.findIndex(o => o.id === m.id && o.provider === m.provider) === i);
  const approvedOpenRouter = (model: ModelCatalogEntry) =>
    model.provider === "openrouter" && Boolean(getOpenRouterFreeChatModel(model.id) || getOpenRouterPaidChatModel(model.id));
  // The visible Model Gateway catalog is deliberately reduced to the explicitly
  // approved free and paid OpenRouter models plus the no-inference mock.
  return unique.filter(model => (model.provider === "mock" && model.id === "mock/ux-direct") || approvedOpenRouter(model));
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

const TASK_MODULES: Record<string, string> = {
  "uxd/classify":"classification","uxd/extract":"extraction","uxd/summarize":"summarization",
  "uxd/reasoning":"reasoning","uxd/vision":"vision","uxd/critique":"critique"
};
function providerForEntry(entry: ModelCatalogEntry, providers: ProviderConfig[]) {
  return providers.find(p => p.name === entry.provider && (p.models.includes(entry.id) || (p.models.includes("default") && ["ollama","custom"].includes(p.name))));
}
function modeAllows(mode: string, entry: ModelCatalogEntry, provider: ProviderConfig, mockFallback = false) {
  if (mode === "mock") return provider.kind === "mock";
  if (mode === "local") return provider.kind === "local";
  if (mode === "free") return provider.kind === "free-tier" || provider.kind === undefined || entry.id.endsWith(":free") || mockFallback || (provider.kind === "mock" && entry.id === "mock/ux-direct");
  if (mode === "paid") return provider.kind !== "local" && provider.kind !== "mock" && !entry.id.endsWith(":free");
  return false;
}
function chooseModuleModel(moduleId: string, policy: { mode: string; selectedModelKey: string }, catalog: ModelCatalogEntry[], settings: Awaited<ReturnType<typeof getGatewaySettings>>) {
  if (policy.mode === "mock") {
    const mock = catalog.find(m => m.provider === "mock" && m.id === "mock/ux-direct");
    if (mock) return mock;
  }
  if (policy.selectedModelKey !== "auto") {
    const selected = catalog.find(m => modelKey(m.provider, m.id) === policy.selectedModelKey);
    if (!selected) throw new GatewayError("Selected model is no longer in the catalog; no fallback attempted.", 400);
    return selected;
  }
  const def = GATEWAY_MODULES.find(m => m.id === moduleId) ?? GATEWAY_MODULES[GATEWAY_MODULES.length - 1];
  const eligible = catalog.filter(m => {
    if (!m.configured) return false;
    if (policy.mode === "free") return m.tier === "free-tier" || m.id.endsWith(":free");
    if (policy.mode === "local") return m.tier === "local";
    if (policy.mode === "paid") {
      if (m.tier === "local" || m.tier === "mock" || m.id.endsWith(":free")) return false;
      const p = settings.models[modelKey(m.provider,m.id)];
      return Boolean(p && p.inputPriceInrPerMillion > 0 && p.outputPriceInrPerMillion > 0);
    }
    return m.tier === "mock";
  });
  eligible.sort((a, b) => {
    const score = (m: ModelCatalogEntry) => m.tasks.some(t =>
      def.tasks.some(w => t.toLowerCase().includes(w.toLowerCase()) || w.toLowerCase().includes(t.toLowerCase()))
    ) ? 1 : 0;
    const match = score(b) - score(a);
    if (match) return match;
    if (policy.mode === "paid") {
      const ap = settings.models[modelKey(a.provider, a.id)];
      const bp = settings.models[modelKey(b.provider, b.id)];
      const ac = ap ? ap.inputPriceInrPerMillion * 0.1 + ap.outputPriceInrPerMillion * 0.02 : Infinity;
      const bc = bp ? bp.inputPriceInrPerMillion * 0.1 + bp.outputPriceInrPerMillion * 0.02 : Infinity;
      if (ac !== bc) return ac - bc;
    }
    return a.label.localeCompare(b.label);
  });
  if(eligible[0])return eligible[0];
  if(policy.mode==="free"){
    // This is deterministic mock, not AI inference. UI/ledger labels make that explicit.
    const mock=catalog.find(m=>m.provider==="mock"&&m.id==="mock/ux-direct");
    if(mock)return mock;
  }
  throw new GatewayError("No connected model is available in this module's selected mode. No alternative mode or model was called.",503);
}
export async function chatCompletion(
  request: GatewayRequest,
  options: { providers?: ProviderConfig[]; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<GatewayResponse> {
  if (!request.model?.trim()) throw new GatewayError("A model is required.",400);
  if (!Array.isArray(request.messages)||request.messages.length===0) throw new GatewayError("At least one chat message is required.",400);
  if(request.messages.some(m=>!m||!["system","user","assistant"].includes(m.role)||typeof m.content!=="string"))throw new GatewayError("Messages must contain a supported role and string content.",400);
  if (request.imageDataUrl !== undefined &&
      (typeof request.imageDataUrl !== "string" ||
       request.imageDataUrl.length > 2_800_000 ||
       !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(request.imageDataUrl))) {
    throw new GatewayError("Visual input must be a bounded JPEG data URL.",400,"openrouter");
  }
  if (request.imageDataUrl && !(
    getOpenRouterPaidChatModel(request.model)?.supportsImages ||
    getOpenRouterFreeChatModel(request.model)?.supportsImages
  )) {
    throw new GatewayError("The selected OpenRouter model does not support screenshot input.",400,"openrouter");
  }
  // Image tokens vary by provider; reserve a conservative input estimate for the
  // image in addition to the text so budget preflight does not ignore screenshots.
  const promptChars=request.messages.reduce((n,m)=>n+m.content.length,0) +
    (request.imageDataUrl ? 12_000 : 0);
  if(promptChars>200_000)throw new GatewayError("Request content exceeds the 200,000-character limit.",413);

  const providers=options.providers??providersFromEnv();
  const explicitlySelectedOpenRouterPaid = request.openRouterPaidSelection === true &&
    request.providerId === "openrouter" &&
    Boolean(getOpenRouterPaidChatModel(request.model)) &&
    !request.model.endsWith(":free") &&
    request.moduleId === undefined;
  const explicitlySelectedOpenRouterFree = request.openRouterFreeSelection === true &&
    request.providerId === "openrouter" &&
    Boolean(getOpenRouterFreeChatModel(request.model)) &&
    request.model.endsWith(":free") &&
    request.moduleId === undefined;
  if (request.openRouterPaidSelection && !explicitlySelectedOpenRouterPaid) {
    throw new GatewayError("Paid OpenRouter selection must come from the server-side allowlisted helper.", 403);
  }
  if (request.openRouterFreeSelection && !explicitlySelectedOpenRouterFree) {
    throw new GatewayError("Free OpenRouter selection must come from the server-side free-model allowlist.", 403);
  }
  // OpenRouter owns credit enforcement. Routine free/paid calls must not depend
  // on the UX Direct settings store or its legacy monthly-budget fields.
  const settings = explicitlySelectedOpenRouterFree || explicitlySelectedOpenRouterPaid
    ? defaultGatewaySettings()
    : await getGatewaySettings();
  const moduleId=request.moduleId??request.budgetModuleId??TASK_MODULES[request.model]??"general";
  const policy=settings.modules[moduleId]??settings.modules.general;
  if(!policy.enabled)throw new GatewayError("Module "+moduleId+" is switched off in Model Gateway settings.",403);
  const catalog=getModelCatalog(providers);
  let selected:ModelCatalogEntry|undefined;
  let model=request.model;
  let providerId=request.providerId;
  if(TASK_MODULES[request.model]){
    selected=chooseModuleModel(moduleId,policy,catalog,settings);
    model=selected.id;providerId=selected.provider;
  } else if(request.moduleId&&policy.selectedModelKey!=="auto"&&policy.selectedModelKey!==modelKey(request.providerId??"",request.model)){
    throw new GatewayError("Request model does not match the exact module selection for "+moduleId+".",403);
  }

  let provider:ProviderConfig|undefined;
  if(providerId){
    const entry=selected??catalog.find(m=>m.provider===providerId&&m.id===model)??{id:model,provider:providerId,label:model,tier:"paid" as const,tasks:[],configured:true,notes:""};
    provider=providerForEntry(entry,providers);
  }else provider=resolveProvider(model,providers);
  if(!provider)throw new GatewayError("Selected model \""+model+"\" is not connected. Add its server-side key/model allowlist; no other model was attempted.",503,providerId);
  const effective=selected??catalog.find(m=>m.provider===provider!.name&&m.id===model)??{id:model,provider:provider.name,label:model,tier:(provider.kind??"paid") as ModelCatalogEntry["tier"],tasks:[],configured:true,notes:""};
  const mockFallback=Boolean(TASK_MODULES[request.model]&&policy.mode==="free"&&policy.selectedModelKey==="auto"&&provider.kind==="mock");
  if(!modeAllows(policy.mode,effective,provider,mockFallback) && !explicitlySelectedOpenRouterPaid)throw new GatewayError("Model/provider is incompatible with "+policy.mode+" mode for module "+moduleId+". No fallback was attempted.",403,provider.name);

  const exactKey=modelKey(provider.name,model);
  const modelPolicy=settings.models[exactKey]??getDefaultModelPolicy(provider.name,model,effective.usdInputPerMillion??0,effective.usdOutputPerMillion??0,settings.usdToInrRate);
  const billable=policy.mode==="paid" || explicitlySelectedOpenRouterPaid;
  if(billable && model.endsWith(":free")) {
    throw new GatewayError("A paid request cannot use a model marked as free.", 400, provider.name);
  }
  const started=Date.now();
  const requestId=request.requestId??crypto.randomUUID();
  const usageStore=await import("./usage-store");
  const recordUsage = (item: Parameters<typeof usageStore.recordModelUsage>[0]) =>
    usageStore.recordModelUsage(item, { persist: !explicitlySelectedOpenRouterFree });
  if(provider.kind==="mock"||provider.baseUrl.startsWith("mock://")){
    const lastUser=[...request.messages].reverse().find(m=>m.role==="user")?.content??"";
    const usage={prompt_tokens:0,completion_tokens:0,total_tokens:0};
    await recordUsage({requestId,moduleId,provider:provider.name,model,tier:"mock",promptTokens:0,completionTokens:0,totalTokens:0,usageReported:true,estimatedCostInr:0,latencyMs:Date.now()-started,status:"success"});
    return {id:requestId,model,content:`[UX Direct mock — no model API called] Received ${lastUser.length} characters. Configure a connected provider for inference.`,provider:provider.name,latencyMs:Date.now()-started,usage};
  }
  const fetchImpl=options.fetchImpl??fetch;
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),options.timeoutMs??45_000);
  const abort=()=>controller.abort();request.signal?.addEventListener("abort",abort,{once:true});
  const rates={billable,inputPriceInrPerMillion:modelPolicy.inputPriceInrPerMillion,outputPriceInrPerMillion:modelPolicy.outputPriceInrPerMillion};
  try{
    const headers:Record<string,string>={"Content-Type":"application/json",...(provider.apiKey?(provider.apiKeyHeader?{[provider.apiKeyHeader]:provider.apiKey}:{Authorization:`Bearer ${provider.apiKey}`}):{}),...provider.headers};
    let providerMessages: unknown[] = request.messages;
    if (request.imageDataUrl) {
      let lastUserIndex = -1;
      for (let i = request.messages.length - 1; i >= 0; i--) {
        if (request.messages[i].role === "user") { lastUserIndex = i; break; }
      }
      if (lastUserIndex < 0) throw new GatewayError("Visual review requires a user message.",400,"openrouter");
      providerMessages = request.messages.map((message, index) => index === lastUserIndex
        ? { role: message.role, content: [
            { type: "text", text: message.content },
            { type: "image_url", image_url: { url: request.imageDataUrl } }
          ] }
        : message);
    }
    const endpoint = `${trimSlash(provider.baseUrl)}/chat/completions`;
    const requestBody = {
      model,
      messages: providerMessages,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.max_tokens !== undefined ? { max_tokens: request.max_tokens } : {}),
      ...(request.reasoning ? { reasoning: request.reasoning } : {}),
      ...(request.imageDataUrl && provider.name === "openrouter" ? { provider: { sort: "throughput" } } : {})
    };
    let response = await fetchImpl(endpoint, {
      method: "POST", headers, body: JSON.stringify(requestBody), signal: controller.signal
    });

    // Some OpenRouter provider endpoints reject optional tuning fields on multimodal
    // requests. A 400 is a rejected request, so retry the same model once with only
    // the portable chat-completions fields. Do not switch to a second paid model.
    let compatibilityError = "";
    if (response.status === 400 && request.imageDataUrl && provider.name === "openrouter") {
      try {
        const firstPayload = await response.clone().json() as { error?: { message?: unknown }; message?: unknown };
        const detail = firstPayload.error?.message ?? firstPayload.message;
        compatibilityError = typeof detail === "string" ? detail.slice(0, 240) : "";
      } catch { /* Keep a generic reason if the provider body is not JSON. */ }

      const safeRetryBody = {
        model,
        messages: providerMessages,
        ...(request.max_tokens !== undefined ? { max_tokens: request.max_tokens } : {})
      };
      console.warn("[model-gateway]", JSON.stringify({
        event: "visual-request-compatibility-retry",
        provider: provider.name,
        model,
        removedOptionalParameters: ["temperature", "reasoning", "provider.sort"],
        providerError: compatibilityError.replace(/sk-or-v1-[A-Za-z0-9_-]+/gi, "[redacted]").slice(0, 240)
      }));
      response = await fetchImpl(endpoint, {
        method: "POST", headers, body: JSON.stringify(safeRetryBody), signal: controller.signal
      });
    }

    if (!response.ok) {
      let detail = "";
      try {
        const errorPayload = await response.clone().json() as { error?: { message?: unknown }; message?: unknown };
        const message = errorPayload.error?.message ?? errorPayload.message;
        if (typeof message === "string") detail = message;
      } catch {
        try { detail = (await response.clone().text()).slice(0, 240); } catch { /* No response text available. */ }
      }
      detail = detail.replace(/sk-or-v1-[A-Za-z0-9_-]+/gi, "[redacted]").replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").slice(0, 240);
      const firstReason = compatibilityError ? " Initial visual request was also rejected: " + compatibilityError.replace(/sk-or-v1-[A-Za-z0-9_-]+/gi, "[redacted]").slice(0, 160) + "." : "";
      const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : response.status;
      throw new GatewayError(`Provider returned HTTP ${response.status}${detail ? ": " + detail : "."}${firstReason}`, status, provider.name);
    }
    let payload:ProviderChatPayload;
    try {
      payload = await response.json() as ProviderChatPayload;
    } catch (error) {
      // If headers arrived but the response body stalled until the request's
      // AbortController fired, json() rejects too. Preserve timeout semantics
      // instead of misreporting it as malformed JSON.
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new GatewayError("Provider response timed out while reading the response body.", 504, provider.name);
      }
      throw new GatewayError("Provider returned invalid JSON.", 502, provider.name);
    }
    const firstChoice = payload.choices?.[0];
    const message = firstChoice?.message;
    const content = normalizeChatText(message?.content) ?? normalizeChatText(message?.refusal) ?? normalizeChatText(payload.output_text);
    if (!content) {
      const messageFields = message && typeof message === "object"
        ? Object.keys(message).filter(key => ["role", "content", "refusal", "reasoning", "reasoning_content", "tool_calls", "audio", "annotations"].includes(key)).join(",")
        : "missing";
      const finishReason = typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason.slice(0, 80) : "unknown";
      // Deliberately do not include hidden reasoning or raw provider payloads.
      throw new GatewayError(
        "Provider returned no user-facing text (finish_reason=" + finishReason +
        "; message_fields=" + (messageFields || "none") + "). Try a standard text response or a different approved model.",
        502,
        provider.name
      );
    }
    const latencyMs=Date.now()-started;const tokenUsage=usageStore.tokenUsageValues(payload.usage);
    const estimatedCostInr=tokenUsage.usageReported
      ?usageStore.estimateCostInr(tokenUsage.promptTokens,tokenUsage.completionTokens,provider,process.env,model,rates)
      :usageStore.estimateCostInr(Math.ceil(promptChars/4),request.max_tokens??1024,provider,process.env,model,rates);
    await recordUsage({requestId,moduleId,provider:provider.name,model,tier:billable?"paid":(model.endsWith(":free")||policy.mode==="free"||provider.kind==="free-tier"?"free-tier":provider.kind??"paid"),...tokenUsage,estimatedCostInr,latencyMs,status:"success",note:tokenUsage.usageReported?undefined:"Provider did not return token usage; actual counts unavailable and estimated cost is conservative."});
    return {id:typeof payload.id==="string"?payload.id:undefined,model:typeof payload.model==="string"?payload.model:model,content,usage:payload.usage,provider:provider.name,latencyMs};
  }catch(error){
    const failure=error instanceof GatewayError?error:controller.signal.aborted?new GatewayError("Model request timed out or was cancelled.",504,provider.name):new GatewayError(error instanceof Error?error.message:"Unknown provider error.",502,provider.name);
    await recordUsage({requestId,moduleId,provider:provider.name,model,tier:billable?"paid":(model.endsWith(":free")||policy.mode==="free"||provider.kind==="free-tier"?"free-tier":provider.kind??"paid"),promptTokens:0,completionTokens:0,totalTokens:0,usageReported:false,estimatedCostInr:billable?usageStore.estimateCostInr(Math.ceil(promptChars/4),request.max_tokens??1024,provider,process.env,model,rates):0,latencyMs:Date.now()-started,status:"error",note:failure.message+" Usage unavailable; paid cost is a conservative estimate."});
    throw failure;
  }finally{clearTimeout(timeout);request.signal?.removeEventListener("abort",abort);}
}
export function routeTask(task: "classify" | "extract" | "summarize" | "ux-reasoning" | "vision" | "critique", providers = providersFromEnv()) {
  const priorities: Record<typeof task, string[]> = {
    classify: [],
    extract: [],
    summarize: [],
    "ux-reasoning": [],
    vision: [],
    critique: []
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
 * Paid providers are not used as implicit provider substitutions. The explicit
 * OpenRouter free-first strategy can select one approved paid fallback, with
 * account credits and key limits enforced by OpenRouter itself.
 */
/**
 * OpenRouter is the provider billing gateway; local usage records are estimates only.
 */
export async function chatCompletionWithFallback(
  request: GatewayRequest,
  options: { providers?: ProviderConfig[]; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<GatewayResponse> {
  return chatCompletion(request, options);
}

export async function chatCompletionWithFreeFallback(
  request: GatewayRequest,
  options: { providers?: ProviderConfig[]; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<GatewayResponse> {
  if (request.providerId !== "openrouter" || !getOpenRouterFreeChatModel(request.model)) {
    throw new GatewayError("Only an explicitly approved OpenRouter free model is allowed.", 400, "openrouter");
  }
  const providers = providersForFreeChat(options.providers ?? providersFromEnv(), request.model);
  const provider = providers.find(item => item.name === "openrouter" && Boolean(item.apiKey) && item.models.includes(request.model));
  if (!provider) throw new GatewayError("OpenRouter API key is not configured for this Preview deployment.", 503, "openrouter");
  return chatCompletion({
    ...request,
    providerId: "openrouter",
    moduleId: undefined,
    openRouterFreeSelection: true
  }, { ...options, providers });
}

/**
 * Cockpit/task planning strategy: exhaust the two approved free models first,
 * then select one paid model by task expertise. A request never fans out to
 * multiple paid models; OpenRouter owns balance and key-limit enforcement.
 */
export async function chatCompletionFreeFirstThenPaid(
  request: GatewayRequest,
  options: { providers?: ProviderConfig[]; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<GatewayResponse> {
  const providers = options.providers ?? providersFromEnv();
  const openrouter = providers.find(provider => provider.name === "openrouter" && Boolean(provider.apiKey));
  if (!openrouter) {
    throw new GatewayError("OpenRouter API key is not configured; neither approved free nor paid models can be called.", 503, "openrouter");
  }

  const lastUserMessage = [...request.messages].reverse().find(message => message.role === "user")?.content ?? "";
  const reasoningFirst = /\b(strategy|strategic|complex reasoning|deep reasoning|critique|audit|heuristic|information architecture|\bia\b|user journey|journey map|flow design|trade[- ]off|research synthesis|accessibility review|product direction|decision framework|root cause)\b/i.test(lastUserMessage);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const selectedPaid = request.preferredPaidModelId
    ? getOpenRouterPaidChatModel(request.preferredPaidModelId)
    : undefined;
  if (request.preferredPaidModelId && !selectedPaid) {
    throw new GatewayError("Selected paid model is not in the approved OpenRouter model pool.",400,"openrouter");
  }

  // An exact paid choice in the cockpit is an explicit instruction: do not
  // burn latency or free-model retries before calling the selected model.
  if (selectedPaid && !request.imageDataUrl) {
    const result = await chatCompletionWithOpenRouterPaid({
      ...request,
      model: selectedPaid.id,
      providerId: "openrouter",
      moduleId: undefined,
      openRouterFreeSelection: undefined,
      openRouterPaidSelection: true
    }, { ...options, providers, timeoutMs: Math.max(timeoutMs, 20_000) });
    return {
      ...result,
      tier: "paid",
      routingStrategy: "paid-direct",
      attemptedModels: [selectedPaid.id],
      fallbackReason: "The selected paid model was called directly; free models were not attempted."
    };
  }

  // Explicit paid selections stay direct. If the selected paid model is text-only,
  // substitute the cheapest approved vision-capable paid model rather than call a
  // different paid model and the selected paid model in the same request.
  if (request.imageDataUrl && (selectedPaid || request.forcePaidVision)) {
    const visionModel = selectedPaid.supportsImages ? selectedPaid : selectOpenRouterPaidVisionModel();
    const result = await chatCompletionWithOpenRouterPaid({
      ...request,
      model: visionModel.id,
      providerId: "openrouter",
      moduleId: undefined,
      openRouterFreeSelection: undefined,
      openRouterPaidSelection: true
    }, { ...options, providers, timeoutMs: Math.max(timeoutMs, 45_000) });
    const changedForVision = Boolean(selectedPaid && selectedPaid.id !== visionModel.id);
    return {
      ...result,
      tier: "paid",
      routingStrategy: "vision-direct",
      attemptedModels: [visionModel.id],
      fallbackReason: request.forcePaidVision && !selectedPaid
        ? "Structured Figma edit plans use the lowest-listed-cost approved paid vision model to preserve valid JSON output. One paid model was called."
        : changedForVision
          ? "The selected model (" + selectedPaid!.label + ") does not support screenshot input. This request used " + visionModel.label + ", the lowest-listed-cost approved vision model, instead. One paid model was called."
          : "The explicitly selected paid vision model was called directly. One paid model was called."
    };
  }

  // When a free model is selected, try at most two approved free vision models
  // before one inexpensive paid vision fallback. This is deliberately bounded so
  // a single screenshot cannot fan out across the whole model catalogue.
  if (request.imageDataUrl) {
    const preferredFreeVision = getOpenRouterFreeChatModel(request.model);
    const freeVisionModels = OPENROUTER_FREE_CHAT_MODELS.filter(model => model.supportsImages);
    const visionOrder = preferredFreeVision?.supportsImages
      ? [preferredFreeVision, ...freeVisionModels.filter(model => model.id !== preferredFreeVision.id)]
      : freeVisionModels;
    const failedFreeVisionModels: string[] = [];

    for (const freeModel of visionOrder.slice(0, 2)) {
      try {
        const result = await chatCompletionWithFreeFallback({
          ...request,
          model: freeModel.id,
          providerId: "openrouter",
          moduleId: undefined,
          openRouterPaidSelection: undefined
        }, {
          ...options,
          providers: providersForFreeChat(providers, freeModel.id),
          // A bounded free attempt leaves room for one paid fallback inside
          // Netlify's synchronous function timeout.
          timeoutMs: Math.min(timeoutMs, 7_000)
        });
        return {
          ...result,
          tier: "free-tier",
          routingStrategy: "free-first",
          attemptedModels: [...failedFreeVisionModels, freeModel.id],
          fallbackReason: failedFreeVisionModels.length
            ? "A previous approved free vision model failed (" + failedFreeVisionModels.join(", ") + "); screenshot analysis succeeded with " + freeModel.label + ". No paid inference was used."
            : "Screenshot analysis succeeded with an approved free vision model. No paid inference was used."
        };
      } catch (error) {
        if (request.signal?.aborted) throw new GatewayError("Visual model routing was cancelled by the client.", 499, "openrouter");
        failedFreeVisionModels.push(freeModel.id);
      }
    }

    const visionModel = selectOpenRouterPaidVisionModel();
    const result = await chatCompletionWithOpenRouterPaid({
      ...request,
      model: visionModel.id,
      providerId: "openrouter",
      moduleId: undefined,
      openRouterFreeSelection: undefined,
      openRouterPaidSelection: true
    }, { ...options, providers, timeoutMs: Math.max(timeoutMs, 38_000) });
    return {
      ...result,
      tier: "paid",
      routingStrategy: "vision-direct",
      attemptedModels: [...failedFreeVisionModels, visionModel.id],
      fallbackReason: "Approved free vision models were unavailable (" + failedFreeVisionModels.join(", ") + "). The screenshot used one low-cost paid vision fallback: " + visionModel.label + "."
    };
  }
  const preferred = getOpenRouterFreeChatModel(request.model)?.id;
  const defaultFreeOrder = reasoningFirst
    ? ["nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3.5-lightning:free", "qwen/qwen3.8-27b:free", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"]
    : ["nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "qwen/qwen3.8-27b:free", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"];
  const freeOrder = (preferred
    ? [preferred, ...defaultFreeOrder.filter(id => id !== preferred)]
    : defaultFreeOrder).slice(0, 2);
  const failedFreeModels: string[] = [];

  for (const model of freeOrder) {
    try {
      const result = await chatCompletionWithFreeFallback({
        ...request,
        model,
        providerId: "openrouter",
        moduleId: undefined,
        openRouterPaidSelection: undefined
      }, { ...options, providers: providersForFreeChat(providers, model), timeoutMs });
      if (!result.content.trim()) throw new GatewayError("Free model returned empty text.", 502, "openrouter");
      return {
        ...result,
        tier: "free-tier",
        routingStrategy: "free-first",
        attemptedModels: [...failedFreeModels, model]
      };
    } catch (error) {
      if (request.signal?.aborted) throw new GatewayError("Model routing was cancelled by the client.", 499, "openrouter");
      failedFreeModels.push(model);
      // Try both approved free IDs even when the first is rate-limited. The pool
      // is intentionally capped at two attempts before one paid expertise fallback.
    }
  }

  const paidModel = selectedPaid ?? selectOpenRouterPaidChatModel(request.messages);
  try {
    const result = await chatCompletionWithOpenRouterPaid({
      ...request,
      model: paidModel.id,
      providerId: "openrouter",
      moduleId: undefined,
      openRouterFreeSelection: undefined,
      openRouterPaidSelection: true
    }, { ...options, providers, timeoutMs: Math.max(timeoutMs, 18_000) });
    return {
      ...result,
      tier: "paid",
      routingStrategy: "free-first",
      attemptedModels: [...failedFreeModels, paidModel.id],
      fallbackReason: "Approved free models were unavailable: " + failedFreeModels.join(", ")
    };
  } catch (error) {
    const status = error instanceof GatewayError ? error.status : 502;
    const detail = error instanceof Error ? error.message : "Unknown paid fallback error.";
    throw new GatewayError(
      "Free-first routing exhausted the approved free pool (" + failedFreeModels.join(", ") + "). Paid fallback " + paidModel.id + " failed: " + detail,
      status,
      "openrouter"
    );
  }
}

/**
 * Direct paid OpenRouter chat for the single allowlisted low-cost test model.
 * The common gateway still enforces request, module, model and global budgets.
 */
export async function chatCompletionWithOpenRouterPaid(
  request: GatewayRequest,
  options: { providers?: ProviderConfig[]; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<GatewayResponse> {
  if (request.providerId !== "openrouter" || !getOpenRouterPaidChatModel(request.model) || request.model.endsWith(":free")) {
    throw new GatewayError("Only an explicitly selected allowlisted paid OpenRouter model is allowed.", 400, "openrouter");
  }
  const providers = providersForOpenRouterPaidChat(request.model, options.providers ?? providersFromEnv());
  const provider = providers.find(item => item.name === "openrouter" && Boolean(item.apiKey) && item.models.includes(request.model));
  if (!provider) throw new GatewayError("OpenRouter API key is not configured for this Preview deployment.", 503, "openrouter");
  return chatCompletion({
    ...request,
    providerId: "openrouter",
    moduleId: undefined,
    openRouterPaidSelection: true
  }, { ...options, providers });
}
