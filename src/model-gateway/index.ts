import { GATEWAY_MODULES, getGatewaySettings, getDefaultModelPolicy, modelKey } from "./control-store";
/**
 * Zero-fee model gateway for UX Direct.
 * Requests go directly to provider APIs. No gateway SaaS, account, or usage fee.
 * Provider usage may still cost money; local inference uses your own compute.
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
  moduleId?: string;
  providerId?: string;
};
export type TokenUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
type ProviderChatPayload = { id?: unknown; model?: unknown; choices?: Array<{ message?: { content?: unknown } }>; usage?: TokenUsage };
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

export type FreeChatModel = { provider: "openrouter"; id: string; label: string; tier: "free-tier"; configured: boolean };

export function providersForFreeChat(providers = providersFromEnv(), selectedModel?: string): ProviderConfig[] {
  return providers.map(provider => {
    if (provider.name !== "openrouter" || !provider.apiKey) return provider;
    const selected = selectedModel && selectedModel.endsWith(":free") ? [selectedModel] : [];
    return { ...provider, kind: "free-tier", models: Array.from(new Set([...provider.models.filter(model => model.endsWith(":free")), ...selected])) };
  });
}

export function getFreeChatModelOptions(providers = providersFromEnv(), discoveredModelIds: string[] = []): FreeChatModel[] {
  const provider = providers.find(item => item.name === "openrouter" && Boolean(item.apiKey));
  if (!provider) return [];
  return Array.from(new Set([...(provider.models ?? []), ...discoveredModelIds]))
    .filter(id => id.endsWith(":free"))
    .map(id => ({ provider: "openrouter", id, label: id, tier: "free-tier", configured: true }));
}

export function providersFromEnv(env: Record<string, string | undefined> = process.env): ProviderConfig[] {
  const providers: ProviderConfig[] = [];
  // Always register a deterministic mock so tests and empty-credential installs work.
  // Task routing prefers configured real providers and uses mock only as the last resort.
  providers.push({ name: "mock", baseUrl: "mock://local", models: ["mock/ux-direct"], kind: "mock" });
  const paidRoutingReady = env.ALLOW_PAID_MODELS === "true" && Number(env.MODEL_GATEWAY_MONTHLY_BUDGET_INR ?? "3000") > 0;
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
    { id: "deepseek-flash", provider: "deepseek", label: "DeepSeek V4.1 Flash", tier: "paid", tasks: ["classification","extraction","reasoning","vision","summaries"], notes: "Peak-hour conservative rate reference: $0.30 input / $1.20 output per 1M tokens. Off-peak/cached input may be cheaper; API price varies by UTC time.", usdInputPerMillion: .30, usdOutputPerMillion: 1.20, pricingSource: "https://api-docs.deepseek.com/quick_start/pricing/", pricingReviewedAt: "2026-10-11" },
    { id: "deepseek-v4-pro", provider: "deepseek", label: "DeepSeek V4 Pro", tier: "paid", tasks: ["reasoning","critique","complex planning","summaries"], notes: "Peak-hour conservative rate reference: $1.32 input / $3.96 output per 1M tokens. Off-peak/cached input may be cheaper; API price varies by UTC time.", usdInputPerMillion: 1.32, usdOutputPerMillion: 3.96, pricingSource: "https://api-docs.deepseek.com/quick_start/pricing/", pricingReviewedAt: "2026-10-11" },
    { id: "gpt-4o-mini", provider: "openai", label: "OpenAI GPT-4o mini", tier: "paid", tasks: ["classification","extraction","reasoning","vision"], notes: "Published text-token price $0.15 input / $0.60 output per 1M tokens; tool-specific charges may apply.", usdInputPerMillion: .15, usdOutputPerMillion: .6, pricingSource: "https://developers.openai.com/api/docs/models/gpt-4o-mini", pricingReviewedAt: "2026-10-11" }
  ];
  const known = base.map(m => {
    const configuredProvider = providers.find(p => p.name === m.provider && (p.models.includes(m.id) || (p.models.includes("default") && ["ollama","custom"].includes(p.name))));
    return { ...m, ...(configuredProvider?.kind === "paid" && m.tier !== "mock" && m.tier !== "local" ? { tier: "paid" as const } : {}), configured: Boolean(configuredProvider) };
  });
  const extras: ModelCatalogEntry[] = providers.flatMap(p => p.models.filter(id => id !== "default" && !known.some(m => m.provider === p.name && m.id === id)).map(id => ({
    id, provider: p.name, label: p.name + ": " + id,
    tier: (id.endsWith(":free") ? "free-tier" : p.kind ?? "paid"),
    tasks: p.kind === "local" ? ["classification","extraction","summaries"] : p.kind === "free-tier" ? ["general","reasoning","critique"] : ["general"],
    configured: true, notes: id.endsWith(":free") ? "Explicit free model. Account quota still applies." : "Verify provider quota and published rates before billing."
  } as ModelCatalogEntry)));
  return [...known, ...extras].filter((m, i, a) => a.findIndex(o => o.id === m.id && o.provider === m.provider) === i);
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
  const promptChars=request.messages.reduce((n,m)=>n+m.content.length,0);
  if(promptChars>200_000)throw new GatewayError("Request content exceeds the 200,000-character limit.",413);

  const providers=options.providers??providersFromEnv();
  const settings=await getGatewaySettings();
  const moduleId=request.moduleId??TASK_MODULES[request.model]??"general";
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
  if(!modeAllows(policy.mode,effective,provider,mockFallback))throw new GatewayError("Model/provider is incompatible with "+policy.mode+" mode for module "+moduleId+". No fallback was attempted.",403,provider.name);

  const exactKey=modelKey(provider.name,model);
  const modelPolicy=settings.models[exactKey]??getDefaultModelPolicy(provider.name,model,effective.usdInputPerMillion??0,effective.usdOutputPerMillion??0,settings.usdToInrRate);
  const billable=policy.mode==="paid";
  if(billable){
    if(!settings.paidRoutingEnabled||process.env.ALLOW_PAID_MODELS!=="true")throw new GatewayError("Paid routing is locked. Enable the gateway switch and set ALLOW_PAID_MODELS=true in server environment.",403,provider.name);
    if(model.endsWith(":free")||modelPolicy.inputPriceInrPerMillion<=0||modelPolicy.outputPriceInrPerMillion<=0)throw new GatewayError("Exact model needs positive input and output prices before paid routing.",400,provider.name);
    if(policy.monthlyBudgetInr<=0||modelPolicy.monthlyBudgetInr<=0||policy.maxRequestCostInr<=0||modelPolicy.maxRequestCostInr<=0)throw new GatewayError("Module or model budget/per-request cap is zero; paid request blocked.",402,provider.name);
  }
  const started=Date.now();
  const requestId=request.requestId??crypto.randomUUID();
  const usageStore=await import("./usage-store");
  if(billable){
    try{
      await usageStore.assertBudgetAllows(promptChars,request.max_tokens??1024,process.env,model,{
        moduleId,modelKey:exactKey,inputPriceInrPerMillion:modelPolicy.inputPriceInrPerMillion,
        outputPriceInrPerMillion:modelPolicy.outputPriceInrPerMillion,maxRequestCostInr:Math.min(policy.maxRequestCostInr,modelPolicy.maxRequestCostInr)
      });
    }catch(error){
      await usageStore.recordModelUsage({requestId,moduleId,provider:provider.name,model,tier:"paid",promptTokens:0,completionTokens:0,totalTokens:0,usageReported:false,estimatedCostInr:0,latencyMs:Date.now()-started,status:"blocked",note:error instanceof Error?error.message:"Budget guard blocked request."});
      throw error;
    }
  }
  if(provider.kind==="mock"||provider.baseUrl.startsWith("mock://")){
    const lastUser=[...request.messages].reverse().find(m=>m.role==="user")?.content??"";
    const usage={prompt_tokens:0,completion_tokens:0,total_tokens:0};
    await usageStore.recordModelUsage({requestId,moduleId,provider:provider.name,model,tier:"mock",promptTokens:0,completionTokens:0,totalTokens:0,usageReported:true,estimatedCostInr:0,latencyMs:Date.now()-started,status:"success"});
    return {id:requestId,model,content:`[UX Direct mock — no model API called] Received ${lastUser.length} characters. Configure a connected provider for inference.`,provider:provider.name,latencyMs:Date.now()-started,usage};
  }
  const fetchImpl=options.fetchImpl??fetch;
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),options.timeoutMs??45_000);
  const abort=()=>controller.abort();request.signal?.addEventListener("abort",abort,{once:true});
  const rates={billable,inputPriceInrPerMillion:modelPolicy.inputPriceInrPerMillion,outputPriceInrPerMillion:modelPolicy.outputPriceInrPerMillion};
  try{
    const headers:Record<string,string>={"Content-Type":"application/json",...(provider.apiKey?(provider.apiKeyHeader?{[provider.apiKeyHeader]:provider.apiKey}:{Authorization:`Bearer ${provider.apiKey}`}):{}),...provider.headers};
    const response=await fetchImpl(`${trimSlash(provider.baseUrl)}/chat/completions`,{method:"POST",headers,body:JSON.stringify({model,messages:request.messages,...(request.temperature!==undefined?{temperature:request.temperature}:{}),...(request.max_tokens!==undefined?{max_tokens:request.max_tokens}:{})}),signal:controller.signal});
    if(!response.ok)throw new GatewayError(`Provider returned HTTP ${response.status}.`,response.status===429?429:response.status>=500?502:response.status,provider.name);
    let payload:ProviderChatPayload;try{payload=await response.json() as ProviderChatPayload;}catch{throw new GatewayError("Provider returned invalid JSON.",502,provider.name);}
    const content=payload.choices?.[0]?.message?.content;
    if(typeof content!=="string")throw new GatewayError("Provider response did not contain choices[0].message.content.",502,provider.name);
    const latencyMs=Date.now()-started;const tokenUsage=usageStore.tokenUsageValues(payload.usage);
    const estimatedCostInr=tokenUsage.usageReported
      ?usageStore.estimateCostInr(tokenUsage.promptTokens,tokenUsage.completionTokens,provider,process.env,model,rates)
      :usageStore.estimateCostInr(Math.ceil(promptChars/4),request.max_tokens??1024,provider,process.env,model,rates);
    await usageStore.recordModelUsage({requestId,moduleId,provider:provider.name,model,tier:billable?"paid":(model.endsWith(":free")||policy.mode==="free"||provider.kind==="free-tier"?"free-tier":provider.kind??"paid"),...tokenUsage,estimatedCostInr,latencyMs,status:"success",note:tokenUsage.usageReported?undefined:"Provider did not return token usage; actual counts unavailable and estimated cost is conservative."});
    return {id:typeof payload.id==="string"?payload.id:undefined,model:typeof payload.model==="string"?payload.model:model,content,usage:payload.usage,provider:provider.name,latencyMs};
  }catch(error){
    const failure=error instanceof GatewayError?error:controller.signal.aborted?new GatewayError("Model request timed out or was cancelled.",504,provider.name):new GatewayError(error instanceof Error?error.message:"Unknown provider error.",502,provider.name);
    await usageStore.recordModelUsage({requestId,moduleId,provider:provider.name,model,tier:billable?"paid":(model.endsWith(":free")||policy.mode==="free"||provider.kind==="free-tier"?"free-tier":provider.kind??"paid"),promptTokens:0,completionTokens:0,totalTokens:0,usageReported:false,estimatedCostInr:billable?usageStore.estimateCostInr(Math.ceil(promptChars/4),request.max_tokens??1024,provider,process.env,model,rates):0,latencyMs:Date.now()-started,status:"error",note:failure.message+" Usage unavailable; paid cost is a conservative estimate."});
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
 * Paid providers are never used as implicit fallbacks. Direct model requests
 * remain single-provider; task aliases can use this policy.
 */
/**
 * paid providers are never used as implicit fallbacks.
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
  if (request.providerId !== "openrouter" || !request.model.endsWith(":free")) {
    throw new GatewayError("Only an explicitly identified OpenRouter :free model is allowed.", 400);
  }
  const providers = providersForFreeChat(options.providers ?? providersFromEnv(), request.model);
  const provider = providers.find(item => item.name === "openrouter" && Boolean(item.apiKey) && item.models.includes(request.model));
  if (!provider) throw new GatewayError("OpenRouter API key is not configured for this Preview deployment.", 503, "openrouter");
  return chatCompletion({ ...request, providerId: "openrouter", moduleId: undefined }, { ...options, providers });
}
