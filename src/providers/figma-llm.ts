import { readR2Json, writeR2Json } from "@/src/storage/r2-json-store";

/**
 * Provider selection for the Figma plugin and assistant.
 *
 * - openrouter: `openrouter/auto` restricted to low-cost, text+image-input models with structured
 *   output support and a large context window (the closest public proxy for "capable").
 * - freellmapi: the self-hosted FreeLLMAPI router, always called with model `auto`.
 */
export type FigmaProviderId = "openrouter" | "freellmapi";
export const FIGMA_PROVIDER_OPTIONS: ReadonlyArray<{ id: FigmaProviderId; label: string; model: string; description: string }> = [
  { id: "openrouter", label: "OpenRouter", model: "openrouter/auto", description: "Auto router · low cost · text + image input · strong models only" },
  { id: "freellmapi", label: "FreeLLMAPI", model: "auto", description: "Free-tier router · auto model selection and failover" },
];

type Env = Record<string, string | undefined>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const SETTINGS_KEY = "ux-direct-settings/figma-provider.json";
const trimSlash = (value: string) => value.replace(/\/+$/, "");

export function parseFigmaProvider(value: unknown): FigmaProviderId | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "openrouter" || normalized === "freellmapi" ? normalized : null;
}

export function isFigmaProviderConfigured(id: FigmaProviderId, env: Env = process.env): boolean {
  if (id === "freellmapi") return Boolean(env.FREELLMAPI_API_KEY?.trim() && env.FREELLMAPI_BASE_URL?.trim());
  return Boolean(env.OPENROUTER_API_KEY?.trim());
}

/** Persisted choice from the plugin dropdown, or null when nothing has been saved (or storage is unavailable). */
export async function readSavedFigmaProvider(): Promise<FigmaProviderId | null> {
  try {
    const saved = await readR2Json<{ provider?: unknown }>(SETTINGS_KEY);
    return parseFigmaProvider(saved?.provider);
  } catch {
    return null;
  }
}

export async function saveFigmaProvider(provider: FigmaProviderId): Promise<boolean> {
  try {
    await writeR2Json(SETTINGS_KEY, { provider, updatedAt: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

/** Precedence: explicit request value, saved dropdown choice, FIGMA_AGENT_PROVIDER env, then OpenRouter. */
export async function selectFigmaProvider(requested?: unknown, env: Env = process.env): Promise<FigmaProviderId> {
  return parseFigmaProvider(requested)
    ?? (await readSavedFigmaProvider())
    ?? parseFigmaProvider(env.FIGMA_AGENT_PROVIDER)
    ?? "openrouter";
}

type OpenRouterModel = {
  id?: unknown;
  context_length?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  pricing?: { prompt?: unknown; completion?: unknown };
  supported_parameters?: unknown;
};

const MAX_PROMPT_USD_PER_TOKEN = 1.0 / 1_000_000;
const MAX_COMPLETION_USD_PER_TOKEN = 6.0 / 1_000_000;
const MIN_CONTEXT = 100_000;
const MAX_ALLOWED = 25;

/** Pure filter so it is unit-testable. Excludes :free ids because free endpoints may log prompts. */
export function selectOpenRouterVisionModels(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  const scored: Array<{ id: string; completion: number; context: number }> = [];
  for (const raw of models as OpenRouterModel[]) {
    if (!raw || typeof raw.id !== "string" || raw.id.endsWith(":free") || raw.id.startsWith("openrouter/")) continue;
    const input = raw.architecture?.input_modalities;
    const output = raw.architecture?.output_modalities;
    if (!Array.isArray(input) || !input.includes("text") || !input.includes("image")) continue;
    if (Array.isArray(output) && !output.includes("text")) continue;
    const prompt = Number(raw.pricing?.prompt);
    const completion = Number(raw.pricing?.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) continue;
    if (prompt > MAX_PROMPT_USD_PER_TOKEN || completion > MAX_COMPLETION_USD_PER_TOKEN) continue;
    const context = Number(raw.context_length);
    if (!Number.isFinite(context) || context < MIN_CONTEXT) continue;
    const params = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
    if (!params.includes("structured_outputs") && !params.includes("response_format")) continue;
    scored.push({ id: raw.id, completion, context });
  }
  // Within the low-cost band, a higher price is the best available public signal of a stronger model.
  scored.sort((a, b) => b.completion - a.completion || b.context - a.context);
  return scored.slice(0, MAX_ALLOWED).map((entry) => entry.id);
}

let allowListCache: { at: number; ids: string[] } | null = null;
const ALLOW_LIST_TTL_MS = 10 * 60 * 1000;

export function resetOpenRouterAllowListCache() { allowListCache = null; }

/** Live low-cost multimodal allow-list; an empty array means "use plain cost_tier low". */
export async function getOpenRouterAllowList(env: Env = process.env, fetchImpl: FetchLike = fetch as FetchLike, now = Date.now()): Promise<string[]> {
  if (allowListCache && now - allowListCache.at < ALLOW_LIST_TTL_MS) return allowListCache.ids;
  try {
    const base = trimSlash(env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1");
    const response = await fetchImpl(base + "/models?output_modalities=text", {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    } as RequestInit);
    if (!response.ok) return allowListCache?.ids ?? [];
    const payload = await response.json() as { data?: unknown };
    const ids = selectOpenRouterVisionModels(payload.data);
    allowListCache = { at: now, ids };
    return ids;
  } catch {
    return allowListCache?.ids ?? [];
  }
}

export type FigmaLlmTarget = {
  id: FigmaProviderId;
  label: string;
  endpoint: string;
  key: string;
  models: string[];
  headers: Record<string, string>;
  /** Extra body fields that only this provider understands. */
  bodyExtras: (allowList: string[]) => Record<string, unknown>;
};

/** Returns null when the selected provider is not configured on the Worker. */
export function buildFigmaLlmTarget(id: FigmaProviderId, origin: string, env: Env = process.env): FigmaLlmTarget | null {
  if (!isFigmaProviderConfigured(id, env)) return null;
  if (id === "freellmapi") {
    return {
      id, label: "FreeLLMAPI",
      endpoint: trimSlash(env.FREELLMAPI_BASE_URL!.trim()) + "/chat/completions",
      key: env.FREELLMAPI_API_KEY!.trim(),
      models: [env.FREELLMAPI_FIGMA_MODEL?.trim() || "auto"],
      headers: {},
      bodyExtras: () => ({}),
    };
  }
  return {
    id, label: "OpenRouter",
    endpoint: trimSlash(env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1") + "/chat/completions",
    key: env.OPENROUTER_API_KEY!.trim(),
    models: ["openrouter/auto"],
    headers: { "HTTP-Referer": origin, "X-OpenRouter-Title": "UX Direct Figma Agent" },
    bodyExtras: (allowList) => ({
      plugins: [{ id: "auto-router", cost_tier: "low", ...(allowList.length ? { allowed_models: allowList } : {}) }],
    }),
  };
}
