import { readCallStats, type CallStats } from "@/src/llm-gateway/call-log";
import { gatewayAvailability } from "@/src/llm-gateway/router";
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
