import { readCallStats, readModelUsage, type CallStats } from "@/src/llm-gateway/call-log";
import { gatewayAvailability, gatewayChatCompletion } from "@/src/llm-gateway/router";
import { PROVIDERS, modelLimits, modelTier } from "@/src/llm-gateway/catalog";
import { llmGatewayMode } from "@/src/providers/active-chat-provider";

export type ModelAnalytics = CallStats & {
  mode: string;
  providers: Array<{ id: string; label: string; models: Array<{ id: string; tier: string; rpm: number; rpd?: number }> }>;
  missingProviders: Array<{ id: string; label: string; secret: string }>;
};

/** Models view: what the gateway can call, and what was called (model, tokens, latency, errors). */
export async function loadModelAnalytics(hours: number): Promise<ModelAnalytics> {
  const [stats, availability] = await Promise.all([readCallStats(hours), gatewayAvailability()]);
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
    missingProviders: PROVIDERS.filter((provider) => !configured.has(provider.id) && provider.keyEnv.length)
      .map((provider) => ({ id: provider.id, label: provider.label, secret: provider.keyEnv[0] })),
  };
}

export type ProviderCheck = { provider: string; model: string; ok: boolean; status: number; latencyMs: number; answer?: string; error?: string };

let lastCheckAt = 0;

/** Live check: one tiny pinned call per configured provider (no key values are ever returned). */
export async function checkGatewayProviders(): Promise<{ checkedAt: string; log: { ok: boolean; error?: string }; results: ProviderCheck[] } | { throttled: true; retryAfterSeconds: number }> {
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
  let log: { ok: boolean; error?: string } = { ok: true };
  try { await readModelUsage(); } catch (error) { log = { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : String(error) }; }
  return { checkedAt: new Date().toISOString(), log, results };
}
