/**
 * UX Direct's own free-model gateway: provider catalog.
 *
 * Replaces FreeLLMAPI (MIT, github.com/tashfeenahmed/freellmapi) for the few providers UX Direct
 * needs. Only free tiers: OpenRouter is limited to `:free` models; the rest are free-tier keys
 * (never add a card to those accounts). Model ids drift, so every list can be overridden with
 * UXD_GW_<PROVIDER>_MODELS and providers with a /models endpoint are also detected live.
 */

export type ProviderId =
  | "gemini" | "groq" | "cerebras" | "openrouter" | "mistral" | "nvidia" | "zai" | "github" | "workers-ai";

export type Tier = "strong" | "medium" | "fast";

export type ProviderDef = {
  id: ProviderId;
  label: string;
  /** OpenAI-compatible base URL (no trailing slash). Workers AI uses the AI binding instead. */
  baseUrl: string;
  /** Secret(s) holding the key; the first one set wins. Comma-separated values = several keys (round-robin). */
  keyEnv: string[];
  /** Default free models when detection is off or fails. */
  models: string[];
  /** Per-model request limits (free tier, approximate). Used with 85% headroom. */
  rpm: number;
  rpd?: number;
  /** Daily allowance for the whole account/key across all models (OpenRouter free tier). */
  accountRpd?: number;
  /** Largest prompt the free tier accepts in one call (tokens; TPM/context caps). */
  maxInputTokens: number;
  /** Largest completion the provider accepts; a bigger max_tokens is clamped. */
  maxOutputTokens: number;
  /** Detect free models from GET /models. */
  discover?: boolean;
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: "cerebras", label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", keyEnv: ["CEREBRAS_API_KEY"],
    models: ["gpt-oss-120b", "qwen-3-235b-a22b-instruct-2507", "zai-glm-4.6", "llama-3.3-70b"],
    rpm: 30, rpd: 14_000, maxInputTokens: 60_000, maxOutputTokens: 32_000, discover: true,
  },
  {
    id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyEnv: ["GROQ_API_KEY"],
    models: ["openai/gpt-oss-120b", "moonshotai/kimi-k2-instruct-0905", "meta-llama/llama-4-scout-17b-16e-instruct", "qwen/qwen3-32b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile"],
    rpm: 30, rpd: 1_000, maxInputTokens: 7_000, maxOutputTokens: 32_000, discover: true,
  },
  {
    id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    models: ["gemini-3.5-flash", "gemini-3-flash-preview", "gemini-3.1-pro-preview", "gemini-2.5-flash"],
    rpm: 10, rpd: 250, maxInputTokens: 200_000, maxOutputTokens: 60_000, discover: true,
  },
  {
    id: "openrouter", label: "OpenRouter (free)", baseUrl: "https://openrouter.ai/api/v1", keyEnv: ["OPENROUTER_API_KEY"],
    models: ["nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3.5-super-vl:free", "google/gemma-4-31b-it:free", "dots-studio/dots-3-note-preview:free"],
    rpm: 20, rpd: 50, accountRpd: 50, maxInputTokens: 100_000, maxOutputTokens: 32_000, discover: true,
  },
  {
    id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", keyEnv: ["MISTRAL_API_KEY"],
    // Free tier serves codestral and ministral only; large/medium answer 403 "not available in your
    // subscription tier" (live check 2026-11-07). 1 request/second per model.
    models: ["mistral-code-latest", "ministral-14b-2512", "ministral-8b-2512", "ministral-3b-2512"],
    rpm: 50, maxInputTokens: 100_000, maxOutputTokens: 32_000,
  },
  {
    id: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", keyEnv: ["NVIDIA_API_KEY"],
    models: ["deepseek-ai/deepseek-v3.1", "moonshotai/kimi-k2-instruct", "qwen/qwen3-235b-a22b", "meta/llama-4-maverick-17b-128e-instruct"],
    rpm: 35, maxInputTokens: 100_000, maxOutputTokens: 16_000,
  },
  {
    id: "zai", label: "Z.ai GLM", baseUrl: "https://api.z.ai/api/paas/v4", keyEnv: ["ZAI_API_KEY", "ZHIPU_API_KEY"],
    models: ["glm-4.5-flash"],
    rpm: 20, maxInputTokens: 100_000, maxOutputTokens: 16_000,
  },
  {
    id: "github", label: "GitHub Models", baseUrl: "https://models.github.ai/inference", keyEnv: ["GITHUB_MODELS_TOKEN"],
    models: ["openai/gpt-4.1", "openai/gpt-4.1-mini"],
    rpm: 10, rpd: 50, maxInputTokens: 7_500, maxOutputTokens: 4_000,
  },
  {
    // Cloudflare Workers AI through the existing AI binding: no key, ~10k free neurons a day.
    id: "workers-ai", label: "Workers AI", baseUrl: "workers-ai://binding", keyEnv: [],
    // FreeLLMAPI served nemotron-3-120b, gpt-oss-20b, qwq-32b and deepseek-r1-distill from the same account.
    models: ["@cf/openai/gpt-oss-120b", "@cf/nvidia/nemotron-3-120b-a12b", "@cf/openai/gpt-oss-20b", "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/qwen/qwq-32b", "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"],
    rpm: 30, maxInputTokens: 20_000, maxOutputTokens: 4_096,
  },
];

const STRONG = /gpt-oss-120b|qwen3-coder|deepseek|kimi|glm-4\.[5-9](?!-?flash|-air)|glm-5|gemini-[\d.]+-pro|gemini-[\d.]+-flash(?!-lite)|mistral-large|mistral-medium|magistral-medium|maverick|gpt-4\.1(?!-mini|-nano)|gpt-5(?!-mini|-nano)|ultra|super/i;
const FAST = /flash-lite|scout|(^|[-/_.:])(small|mini|nano|lite|lightning|tiny|instant)(?![a-z])|glm-4\.\d+-flash/i;
const VISION = /gemini|llama-4|mistral-medium|mistral-small|pixtral|gpt-4\.1|gpt-5|glm-4\.\dv|-vl\b|omni|gemma-4/i;

/** Total parameter count in billions from the id ("qwen3-235b-a22b" → 235; the "a22b" active count is ignored). */
export function modelSizeB(model: string): number | null {
  const sizes = [...model.toLowerCase().matchAll(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z])/g)].map((match) => Number(match[1]));
  return sizes.length ? Math.max(...sizes) : null;
}

/**
 * Quality tier from the model id. Names drift every month, so this uses families we know
 * plus generic signals (size, "ultra"/"super" vs "nano"/"lite"), and live stats reorder within a tier.
 */
export function modelTier(model: string): Tier {
  const size = modelSizeB(model);
  if (FAST.test(model) && !/super|ultra/i.test(model)) return "fast";
  if (STRONG.test(model) || (size !== null && size >= 100)) return "strong";
  if (size !== null && size <= 20) return "fast";
  return "medium";
}

export function modelSupportsVision(model: string): boolean {
  return VISION.test(model) && !/llama-3/.test(model);
}

/** Per-model limit overrides for the tiniest free allowances. */
export function modelLimits(provider: ProviderDef, model: string): { rpm: number; rpd?: number } {
  if (provider.id === "gemini") {
    if (/-pro/.test(model)) return { rpm: 5, rpd: 100 };
    if (/flash-lite/.test(model)) return { rpm: 15, rpd: 1_000 };
  }
  return { rpm: provider.rpm, rpd: provider.rpd };
}

type Env = Record<string, string | undefined>;

function csv(value: string | undefined): string[] {
  return (value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function providerKeys(provider: ProviderDef, env: Env): string[] {
  for (const name of provider.keyEnv) {
    const keys = csv(env[name]);
    if (keys.length) return keys;
  }
  return [];
}

function envModelsName(provider: ProviderDef): string {
  return "UXD_GW_" + provider.id.toUpperCase().replace(/-/g, "_") + "_MODELS";
}

/** Providers the gateway can call right now (key present, or binding for Workers AI). */
export function configuredProviders(env: Env, hasAiBinding: boolean): ProviderDef[] {
  const disabled = new Set(csv(env.UXD_GW_DISABLED_PROVIDERS).map((id) => id.toLowerCase()));
  return PROVIDERS.filter((provider) => {
    if (disabled.has(provider.id)) return false;
    if (provider.id === "workers-ai") return hasAiBinding && env.UXD_GW_WORKERS_AI !== "off";
    return providerKeys(provider, env).length > 0;
  }).map((provider) => {
    const override = csv(env[envModelsName(provider)]);
    return override.length ? { ...provider, models: override, discover: false } : provider;
  });
}

/** Chat models from a provider's /models payload; OpenRouter keeps only zero-price `:free` rows. */
export function freeModelsFromListing(provider: ProviderDef, payload: unknown): string[] {
  const data = payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: unknown[] }).data : [];
  const ids: string[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.replace(/^models\//, "") : "";
    if (!id) continue;
    if (/embed|whisper|tts|speech|audio|image|guard|moderation|vision-preview|live|native|transcri|rerank|aqa|imagen|veo|learnlm|gemma-3n|compound|allam|playai|orpheus|safeguard|customtools|computer-use|robotics|deep-research/i.test(id)) continue;
    if (provider.id === "openrouter") {
      const pricing = record.pricing && typeof record.pricing === "object" ? record.pricing as Record<string, unknown> : {};
      const free = id.endsWith(":free") && Number(pricing.prompt ?? 0) === 0 && Number(pricing.completion ?? 0) === 0;
      if (!free) continue;
    }
    if (provider.id === "gemini" && !/^gemini-/.test(id)) continue;
    if (record.active === false) continue;
    ids.push(id);
  }
  return [...new Set(ids)];
}
