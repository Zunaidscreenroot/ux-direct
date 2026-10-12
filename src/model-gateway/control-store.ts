import { randomUUID } from "node:crypto";

export type GatewayMode = "free" | "paid" | "local" | "mock";
export type ModulePolicy = { enabled: boolean; mode: GatewayMode; selectedModelKey: string; monthlyBudgetInr: number; maxRequestCostInr: number; allowFallback: boolean };
export type ModelPolicy = { monthlyBudgetInr: number; maxRequestCostInr: number; inputPriceInrPerMillion: number; outputPriceInrPerMillion: number };
export type GatewaySettings = { version: 1; globalMonthlyBudgetInr: number; usdToInrRate: number; paidRoutingEnabled: boolean; modules: Record<string, ModulePolicy>; models: Record<string, ModelPolicy>; updatedAt?: string };
export const GATEWAY_MODULES = [
  { id: "reasoning", label: "Reasoning & task planning", description: "Multi-step UX decisions, task plans and complex trade-offs.", alias: "uxd/reasoning", tasks: ["reasoning", "task planning", "analysis"], suggestedBudgetShare: 1000 },
  { id: "classification", label: "Classification", description: "Route requests, identify intent and classify design work.", alias: "uxd/classify", tasks: ["classification", "intent", "routing"], suggestedBudgetShare: 250 },
  { id: "extraction", label: "Structured extraction", description: "Extract fields, requirements, rules and entities into structured output.", alias: "uxd/extract", tasks: ["extraction", "structured output", "requirements"], suggestedBudgetShare: 250 },
  { id: "summarization", label: "Summarization", description: "Summarize briefs, long notes, research and design references.", alias: "uxd/summarize", tasks: ["summaries", "summarization", "long context"], suggestedBudgetShare: 300 },
  { id: "vision", label: "Visual / screen analysis", description: "Interpret screenshots, UI states and visual references.", alias: "uxd/vision", tasks: ["vision", "visual analysis", "screenshots"], suggestedBudgetShare: 600 },
  { id: "critique", label: "UX critique & quality review", description: "Review UX decisions, accessibility, edge cases and consistency.", alias: "uxd/critique", tasks: ["critique", "reasoning", "quality"], suggestedBudgetShare: 500 },
  { id: "general", label: "General gateway calls", description: "Direct model calls without a more specific agent purpose.", alias: "direct", tasks: ["general", "chat"], suggestedBudgetShare: 100 }
] as const;
type BlobStore = { get(key: string, options: { type: "json" }): Promise<unknown>; setJSON(key: string, value: unknown): Promise<void> };
const runtimeSettings = new Map<string, GatewaySettings>();
const runtimeSettingsAt = new Map<string, number>();
const SETTINGS_CACHE_TTL_MS = 10_000;
const SETTINGS_READ_TIMEOUT_MS = 12_000;
// Share one store read when the free-first gateway warms settings in parallel
// with a second free-model attempt and the paid path needs the same snapshot.
const inFlightSettings = new Map<string, Promise<GatewaySettings>>();
let storePromise: Promise<BlobStore | null> | null = null;

function withStoreTimeout<T>(operation: Promise<T>, label: string, timeoutMs = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + " timed out after " + timeoutMs + "ms.")), timeoutMs);
    })
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}
function amount(value: unknown, fallback: number, max = 1_000_000_000): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(max, Number(n.toFixed(4))) : fallback;
}
export function modelKey(provider: string, id: string) { return provider + "::" + id; }
function envScopeKey(env = process.env) {
  const branch = env.NETLIFY_BRANCH || env.BRANCH || "";
  if (env.CONTEXT === "production" || (env.NETLIFY === "true" && branch === "main")) return "gateway-control:production";
  return "gateway-control:preview:" + (branch || env.CONTEXT || "local").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 80);
}
function storeRuntimeContext() {
  const env = process.env;
  return {
    context: (env.CONTEXT || "unknown").slice(0, 40),
    branch: (env.NETLIFY_BRANCH || env.BRANCH || "unknown").slice(0, 80),
    netlify: env.NETLIFY === "true",
    hasNetlifySiteId: Boolean(env.NETLIFY_SITE_ID),
    hasNetlifyDeployId: Boolean(env.NETLIFY_DEPLOY_ID),
    hasNetlifyBlobsContext: Boolean(env.NETLIFY_BLOBS_CONTEXT)
  };
}
function safeStoreError(error: unknown): string {
  const message = error instanceof Error ? error.name + ": " + error.message : "Unknown store error";
  return message.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").replace(/sk-or-v1-[A-Za-z0-9_-]+/gi, "[redacted]").slice(0, 240);
}
function logStoreDiagnostic(event: string, fields: Record<string, unknown> = {}) {
  console.info("[gateway-control-store]", JSON.stringify({ event, ...fields, runtime: storeRuntimeContext() }));
}
function blobEndpointHost(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try { return new URL(value).host.slice(0, 160); } catch { return undefined; }
}
function tracedBlobsFetch(): typeof fetch {
  return async (input, init) => {
    let url: URL | undefined;
    try {
      const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      url = new URL(raw);
    } catch {
      // Fetch still gets the original input; only safe diagnostics are omitted.
    }
    const startedAt = Date.now();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const routeKind = url?.pathname.includes("/region:") ? "edge-region-route" :
      url?.pathname.startsWith("/api/v1/blobs/") ? "api-route" : "edge-route";
    console.info("[gateway-control-store]", JSON.stringify({
      event: "blob-fetch-started",
      endpointHost: url?.host,
      method,
      routeKind
    }));
    const sourceSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const timeoutSignal = AbortSignal.timeout(9_000);
    const signal = sourceSignal ? AbortSignal.any([sourceSignal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await fetch(input, { ...init, signal });
      console.info("[gateway-control-store]", JSON.stringify({
        event: "blob-fetch-completed",
        endpointHost: url?.host,
        method,
        status: response.status,
        durationMs: Date.now() - startedAt
      }));
      return response;
    } catch (error) {
      console.error("[gateway-control-store]", JSON.stringify({
        event: "blob-fetch-rejected",
        endpointHost: url?.host,
        method,
        durationMs: Date.now() - startedAt,
        timedOut: timeoutSignal.aborted,
        error: safeStoreError(error)
      }));
      throw error;
    }
  };
}
async function getStore(): Promise<BlobStore | null> {
  if (process.env.NETLIFY !== "true" && !process.env.NETLIFY_BLOBS_CONTEXT) return null;
  if (!storePromise) storePromise = (async () => {
    try {
      const { getStore } = await import("@netlify/blobs");
      // This site-wide store is pinned to the region reported by Netlify for
      // this project. The explicit region is important for edge-backed access.
      const store = getStore({
        name: "ux-direct-gateway-control",
        region: "us-east-2",
        fetch: tracedBlobsFetch()
      }) as unknown as BlobStore;
      const rawContext = process.env.NETLIFY_BLOBS_CONTEXT;
      let edgeHost: string | undefined;
      let apiHost: string | undefined;
      let primaryRegion: string | undefined;
      if (rawContext) {
        try {
          const context = JSON.parse(Buffer.from(rawContext, "base64").toString("utf8")) as Record<string, unknown>;
          edgeHost = blobEndpointHost(context.edgeURL);
          apiHost = blobEndpointHost(context.apiURL);
          primaryRegion = typeof context.primaryRegion === "string" ? context.primaryRegion.slice(0, 40) : undefined;
        } catch { /* Only safe endpoint metadata is logged. */ }
      }
      logStoreDiagnostic("store-initialized", {
        store: "ux-direct-gateway-control",
        configuredRegion: "us-east-2",
        edgeHost,
        apiHost,
        primaryRegion
      });
      return store;
    } catch (error) {
      console.error("[gateway-control-store]", JSON.stringify({
        event: "store-initialization-failed",
        store: "ux-direct-gateway-control",
        error: safeStoreError(error),
        runtime: storeRuntimeContext()
      }));
      return null;
    }
  })();
  return storePromise;
}
function pricePolicy(inputUsd = 0, outputUsd = 0, fx = 97): ModelPolicy {
  return { monthlyBudgetInr: 500, maxRequestCostInr: 50, inputPriceInrPerMillion: Number((inputUsd * fx).toFixed(4)), outputPriceInrPerMillion: Number((outputUsd * fx).toFixed(4)) };
}
export function defaultGatewaySettings(): GatewaySettings {
  const modules: Record<string, ModulePolicy> = {};
  for (const m of GATEWAY_MODULES) modules[m.id] = { enabled: true, mode: "free", selectedModelKey: "auto", monthlyBudgetInr: m.suggestedBudgetShare, maxRequestCostInr: 10, allowFallback: false };
  const models: Record<string, ModelPolicy> = {
    [modelKey("groq", "openai/gpt-oss-120b")]: pricePolicy(.15, .6),
    [modelKey("groq", "openai/gpt-oss-20b")]: pricePolicy(.075, .3),
    [modelKey("deepseek", "deepseek-flash")]: pricePolicy(.30, 1.20),
    [modelKey("deepseek", "deepseek-v4-pro")]: pricePolicy(1.32, 3.96),
    // Conservative OpenRouter paid rates are reserved at 5x listed prices; V4 Flash uses a deliberately high output-rate ceiling.
    [modelKey("openrouter", "deepseek/deepseek-v4.1-flash")]: pricePolicy(.65, 2.60),
    [modelKey("openrouter", "openai/gpt-6-luna")]: pricePolicy(.50, 2.50),
    [modelKey("openrouter", "deepseek/deepseek-v4-flash-0731")]: pricePolicy(.15, 6.40),
    [modelKey("ollama", "qwen2.5:7b")]: pricePolicy(),
    [modelKey("ollama", "gemma4:31b")]: pricePolicy(),
    [modelKey("cerebras", "gpt-oss-120b")]: pricePolicy(),
    [modelKey("openai", "gpt-4o-mini")]: pricePolicy(.15, .6)
  };
  return { version: 1, globalMonthlyBudgetInr: 3000, usdToInrRate: 97, paidRoutingEnabled: false, modules, models };
}
function cleanSettings(input: unknown): GatewaySettings {
  const defaults = defaultGatewaySettings();
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const rawModules = raw.modules && typeof raw.modules === "object" ? raw.modules as Record<string, unknown> : {};
  const rawModels = raw.models && typeof raw.models === "object" ? raw.models as Record<string, unknown> : {};
  const modules: Record<string, ModulePolicy> = {};
  for (const m of GATEWAY_MODULES) {
    const base = defaults.modules[m.id];
    const c = rawModules[m.id] && typeof rawModules[m.id] === "object" ? rawModules[m.id] as Record<string, unknown> : {};
    const mode = c.mode;
    modules[m.id] = {
      enabled: typeof c.enabled === "boolean" ? c.enabled : true,
      // UX Direct routing is fixed to free-first with automatic expertise-based paid fallback; mock is opt-in only.
      mode: mode === "mock" ? "mock" : "free",
      selectedModelKey: typeof c.selectedModelKey === "string" && c.selectedModelKey.length <= 220 ? c.selectedModelKey : base.selectedModelKey,
      monthlyBudgetInr: amount(c.monthlyBudgetInr, base.monthlyBudgetInr),
      maxRequestCostInr: amount(c.maxRequestCostInr, base.maxRequestCostInr),
      allowFallback: typeof c.allowFallback === "boolean" ? c.allowFallback : base.allowFallback
    };
  }
  const models: Record<string, ModelPolicy> = { ...defaults.models };
  for (const [key, value] of Object.entries(rawModels)) {
    if (!/^[a-z0-9._-]{1,60}::[a-zA-Z0-9._:/-]{1,160}$/.test(key) || !value || typeof value !== "object") continue;
    const c = value as Record<string, unknown>;
    const base = models[key] ?? pricePolicy();
    models[key] = {
      monthlyBudgetInr: amount(c.monthlyBudgetInr, base.monthlyBudgetInr),
      maxRequestCostInr: amount(c.maxRequestCostInr, base.maxRequestCostInr),
      inputPriceInrPerMillion: amount(c.inputPriceInrPerMillion, base.inputPriceInrPerMillion),
      outputPriceInrPerMillion: amount(c.outputPriceInrPerMillion, base.outputPriceInrPerMillion)
    };
  }
  return {
    version: 1,
    globalMonthlyBudgetInr: amount(raw.globalMonthlyBudgetInr, defaults.globalMonthlyBudgetInr),
    usdToInrRate: Math.min(250, Math.max(1, amount(raw.usdToInrRate, 97))),
    paidRoutingEnabled: typeof raw.paidRoutingEnabled === "boolean" ? raw.paidRoutingEnabled : false,
    modules, models, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined
  };
}
export async function getGatewaySettings(): Promise<GatewaySettings> {
  const key = envScopeKey();
  const cached = runtimeSettings.get(key);
  const cachedAt = runtimeSettingsAt.get(key) ?? 0;
  if (cached && Date.now() - cachedAt < SETTINGS_CACHE_TTL_MS) return cleanSettings(cached);

  const pending = inFlightSettings.get(key);
  if (pending) return cleanSettings(await pending);

  const load = (async (): Promise<GatewaySettings> => {
    let store: BlobStore | null;
    try {
      store = await withStoreTimeout(getStore(), "Netlify Blobs store initialization");
    } catch (error) {
      if (cached && Date.now() - cachedAt < 60_000) return cleanSettings(cached);
      throw new Error("Could not initialize Netlify Blobs for gateway settings: " + (error instanceof Error ? error.message : "unknown store error"));
    }

    if (store) {
      // Cache a successfully verified snapshot even if the caller's timeout wins
      // the race. A later request on this warm instance can then recover without
      // starting another Blob read.
      const readStartedAt = Date.now();
      const read = store.get(key, { type: "json" }).then(value => {
        const settings = cleanSettings(value && typeof value === "object" ? value : defaultGatewaySettings());
        runtimeSettings.set(key, settings);
        runtimeSettingsAt.set(key, Date.now());
        logStoreDiagnostic("settings-read-completed", {
          store: "ux-direct-gateway-control",
          scope: key,
          durationMs: Date.now() - readStartedAt,
          foundStoredSettings: Boolean(value && typeof value === "object")
        });
        return settings;
      }).catch(error => {
        console.error("[gateway-control-store]", JSON.stringify({
          event: "settings-read-rejected",
          store: "ux-direct-gateway-control",
          scope: key,
          durationMs: Date.now() - readStartedAt,
          error: safeStoreError(error),
          runtime: storeRuntimeContext()
        }));
        throw error;
      });
      try {
        return cleanSettings(await withStoreTimeout(read, "Netlify Blobs settings read", SETTINGS_READ_TIMEOUT_MS));
      } catch (error) {
        console.error("[gateway-control-store]", JSON.stringify({
          event: "settings-read-failed-or-timed-out",
          store: "ux-direct-gateway-control",
          scope: key,
          durationMs: Date.now() - readStartedAt,
          timeoutMs: SETTINGS_READ_TIMEOUT_MS,
          error: safeStoreError(error),
          runtime: storeRuntimeContext()
        }));
        // Use only a previously verified snapshot and only for a short stale window.
        // A cold instance never substitutes defaults for an unreadable deployed store.
        if (cached && Date.now() - cachedAt < 60_000) return cleanSettings(cached);
        if (process.env.NETLIFY === "true" || process.env.NETLIFY_BLOBS_CONTEXT) {
          throw new Error("Could not read gateway settings from Netlify Blobs: " + (error instanceof Error ? error.message : "unknown store error"));
        }
        /* Local development can fall back to runtime defaults. */
      }
    } else if (process.env.NETLIFY === "true" || process.env.NETLIFY_BLOBS_CONTEXT) {
      throw new Error("Netlify Blobs is unavailable in this deployed runtime; gateway settings cannot be verified.");
    }

    const defaults = cleanSettings(runtimeSettings.get(key) ?? defaultGatewaySettings());
    runtimeSettings.set(key, defaults);
    runtimeSettingsAt.set(key, Date.now());
    return defaults;
  })();

  inFlightSettings.set(key, load);
  try {
    return cleanSettings(await load);
  } finally {
    if (inFlightSettings.get(key) === load) inFlightSettings.delete(key);
  }
}
export async function saveGatewaySettings(input: unknown): Promise<GatewaySettings> {
  const key = envScopeKey();
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const settings = cleanSettings({ ...raw, updatedAt: new Date().toISOString() });
  runtimeSettings.set(key, settings);
  runtimeSettingsAt.set(key, Date.now());
  const store = await withStoreTimeout(getStore(), "Netlify Blobs store initialization");
  if (store) {
    try { await withStoreTimeout(store.setJSON(key, settings), "Netlify Blobs settings write"); }
    catch (error) { throw new Error("Could not persist gateway settings to Netlify Blobs: " + (error instanceof Error ? error.message : "unknown error")); }
  }
  return settings;
}
export function getDefaultModelPolicy(provider: string, id: string, inputUsd = 0, outputUsd = 0, fx = 97): ModelPolicy {
  const defaults = defaultGatewaySettings();
  return defaults.models[modelKey(provider, id)] ?? pricePolicy(inputUsd, outputUsd, fx);
}
export function newControlRequestId() { return randomUUID(); }
