import { readCallStats, readModelUsage, type CallStats, type CallStatsSection } from "@/src/llm-gateway/call-log";
import { gatewayAvailability, gatewayChatCompletion, gatewayEnv } from "@/src/llm-gateway/router";
import { PROVIDERS, modelLimits, modelTier, providerKeys } from "@/src/llm-gateway/catalog";
import { llmGatewayMode } from "@/src/providers/active-chat-provider";

export type ModelAnalytics = CallStats & {
  mode: string;
  providers: Array<{ id: string; label: string; models: Array<{ id: string; tier: string; rpm: number; rpd?: number }> }>;
  missingProviders: Array<{ id: string; label: string; secret: string }>;
};

export type ModelsTab = "models" | "roles" | "providers" | "recent";
export const MODELS_TABS: ModelsTab[] = ["models", "roles", "providers", "recent"];

/**
 * Models view: what the gateway can call, and what was called (model, tokens, latency, errors).
 * `tab` loads only that tab's data: "models" also carries the top totals; "providers" runs no DB query.
 * No tab = everything (old behaviour).
 */
export async function loadModelAnalytics(hours: number, tab?: ModelsTab): Promise<ModelAnalytics> {
  const sections: CallStatsSection[] = !tab ? ["models", "roles", "recent"] : tab === "providers" ? [] : [tab];
  const needProviders = !tab || tab === "providers";
  const [stats, availability] = await Promise.all([
    sections.length ? readCallStats(hours, sections) : Promise.resolve({ window: Math.max(1, Math.min(720, Math.round(hours))) + "h", totals: { calls: 0, ok: 0, tokens: 0, avgLatencyMs: 0 }, models: [], roles: [], recent: [] }),
    needProviders ? gatewayAvailability() : Promise.resolve({ providers: [] as Array<{ id: string; label: string; models: string[] }> }),
  ]);
  const configured = new Set(availability.providers.map((provider) => provider.id));
  return {
    ...stats,
    mode: llmGatewayMode(),
    providers: availability.providers.map((provider) => {
      const def = PROVIDERS.find((entry) => entry.id === provider.id)!;
      return {
        id: provider.id,
        label: provider.label,
        models: provider.models.map((model) => ({ id: model, tier: modelTier(model), ...modelLimits(def, model) })),
      };
    }),
    missingProviders: !needProviders ? [] : PROVIDERS.filter((provider) => !configured.has(provider.id) && provider.keyEnv.length)
      .map((provider) => ({ id: provider.id, label: provider.label, secret: provider.keyEnv[0] })),
  };
}

export type ProviderCheck = { provider: string; model: string; ok: boolean; status: number; latencyMs: number; answer?: string; error?: string };

let lastCheckAt = 0;

/** Live check: one tiny pinned call per configured provider (no key values are ever returned). */
export async function checkGatewayProviders(): Promise<{ checkedAt: string; log: { ok: boolean; error?: string }; results: ProviderCheck[]; openrouter?: { freeTier?: boolean; dailyFreeLimit?: number; error?: string } } | { throttled: true; retryAfterSeconds: number }> {
  const now = Date.now();
  if (now - lastCheckAt < 60_000) return { throttled: true, retryAfterSeconds: Math.ceil((60_000 - (now - lastCheckAt)) / 1000) };
  lastCheckAt = now;
  const availability = await gatewayAvailability();
  const results = await Promise.all(availability.providers.map(async (provider): Promise<ProviderCheck> => {
    const model = provider.models[0];
    const started = Date.now();
    const response = await gatewayChatCompletion(JSON.stringify({
      model: provider.id + ":" + model,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      max_tokens: 400,
      temperature: 0,
    }), new Headers({ "X-UXD-Agent-Role": "classifier", "X-UXD-Gateway-Strict": "1" }), AbortSignal.timeout(30_000));
    const latencyMs = Date.now() - started;
    const payload = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: string } };
    const routed = response.headers.get("x-routed-via") || "";
    const answer = typeof payload.choices?.[0]?.message?.content === "string" ? payload.choices[0].message.content.slice(0, 40) : undefined;
    return {
      provider: provider.id, model, ok: response.ok && routed.startsWith(provider.id + "/"), status: response.status, latencyMs,
      ...(answer ? { answer } : {}),
      ...(!response.ok ? { error: String(payload.error?.message || "HTTP " + response.status).slice(0, 300) } : {}),
    };
  }));
  // OpenRouter account allowance: 1000 free calls/day once the account has bought credit, else 50.
  let openrouter: { freeTier?: boolean; dailyFreeLimit?: number; error?: string } | undefined;
  const orKey = providerKeys(PROVIDERS.find((provider) => provider.id === "openrouter")!, gatewayEnv())[0];
  if (orKey) {
    try {
      const keyInfo = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: "Bearer " + orKey }, signal: AbortSignal.timeout(8_000) })
        .then((response) => response.json()) as { data?: { is_free_tier?: boolean } };
      const freeTier = keyInfo.data?.is_free_tier;
      openrouter = typeof freeTier === "boolean" ? { freeTier, dailyFreeLimit: freeTier ? 50 : 1000 } : { error: "no key info" };
    } catch (error) { openrouter = { error: error instanceof Error ? error.message.slice(0, 120) : String(error) }; }
  }
  let log: { ok: boolean; error?: string } = { ok: true };
  try { await readModelUsage(); } catch (error) { log = { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : String(error) }; }
  return { checkedAt: new Date().toISOString(), log, results, ...(openrouter ? { openrouter } : {}) };
}
