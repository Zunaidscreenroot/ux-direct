/** Base URL used with FREELLMAPI_TRANSPORT=vpc; the VPC Service decides the real target, this host only fills Host. */
export const FREELLMAPI_VPC_BASE_URL = "http://localhost:31415/v1";

/** Sentinel base URL for UX Direct's own in-Worker gateway (src/llm-gateway); providerFetch never sends it to the network. */
export const UXD_GATEWAY_BASE_URL = "https://uxd-gateway.internal/v1";

export type LlmGatewayMode = "off" | "fallback" | "primary" | "only";

/** UXD_LLM_GATEWAY: how the own gateway and FreeLLMAPI share the work (see provider-fetch.ts). Default: fallback. */
export function llmGatewayMode(env: Record<string, string | undefined> = process.env): LlmGatewayMode {
  const value = (env.UXD_LLM_GATEWAY || "").trim().toLowerCase();
  return value === "off" || value === "primary" || value === "only" ? value : "fallback";
}

export type ChatProviderId = "openrouter" | "freellmapi" | "invalid";

export type ActiveChatProvider = {
  id: ChatProviderId;
  label: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Used only when a request contains images. */
  visionModel?: string;
  /** FreeLLMAPI only: ordered fallback chain for text-only Figma requests. */
  figmaModels?: string[];
  /** FreeLLMAPI only: ordered fallback chain for Figma requests that carry screenshots. */
  figmaVisionModels?: string[];
  configured: boolean;
  configurationError?: string;
};

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

function modelList(value: string | undefined, fallback: string[]): string[] {
  const models = (value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return [...new Set(models.length ? models : fallback)].slice(0, 6);
}

function validateFreeLlmApiBaseUrl(baseUrl: string, env: Record<string, string | undefined>): string | undefined {
  if (!baseUrl) return "Set FREELLMAPI_BASE_URL to the FreeLLMAPI server URL ending in /v1.";
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return "FREELLMAPI_BASE_URL must be an absolute HTTP(S) URL ending in /v1.";
  }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return "FREELLMAPI_BASE_URL must be a clean HTTP(S) base URL without credentials, query parameters, or fragments.";
  }
  if (!parsed.pathname.replace(/\/+$/, "").endsWith("/v1")) {
    return "FREELLMAPI_BASE_URL must include the /v1 path, for example https://your-host.example/v1.";
  }
  if (env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    return "FREELLMAPI_BASE_URL must use HTTPS in production.";
  }
  if (env.NODE_ENV === "production" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase())) {
    return "A deployed UX Direct Worker cannot reach FreeLLMAPI on your local machine; configure a publicly reachable HTTPS URL.";
  }
  return undefined;
}

/**
 * UX Direct chat and Figma model routes can be switched between OpenRouter and a
 * self-hosted FreeLLMAPI OpenAI-compatible endpoint using server-side environment variables.
 * FreeLLMAPI's unified key must be used here, not an upstream provider's key.
 */
export function getActiveChatProvider(
  env: Record<string, string | undefined> = process.env,
): ActiveChatProvider {
  const selected = (env.UX_DIRECT_MODEL_PROVIDER || env.UX_DIRECT_CHAT_PROVIDER || "openrouter").trim().toLowerCase();

  if (selected === "openrouter") {
    const apiKey = env.OPENROUTER_API_KEY?.trim() || "";
    const baseUrl = trimTrailingSlashes(env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1");
    return {
      id: "openrouter",
      label: "OpenRouter",
      apiKey,
      baseUrl,
      model: "openrouter/auto",
      configured: Boolean(apiKey && baseUrl),
      ...(!apiKey ? { configurationError: "OpenRouter is selected, but OPENROUTER_API_KEY is not configured on the server." } : {}),
    };
  }

  if (selected === "freellmapi") {
    const apiKey = env.FREELLMAPI_API_KEY?.trim() || "";
    // FREELLMAPI_TUNNEL_URL (secret, synced from the self-hosted tunnel) wins over the static base URL.
    // FREELLMAPI_TRANSPORT=vpc: reach the Mac over the FREELLMAPI_VPC binding (named tunnel, no public URL).
    const viaVpc = env.FREELLMAPI_TRANSPORT?.trim().toLowerCase() === "vpc";
    // UXD_LLM_GATEWAY=only: the own gateway answers everything, so no FreeLLMAPI URL or key is needed.
    const gatewayOnly = llmGatewayMode(env) === "only";
    const baseUrl = gatewayOnly
      ? UXD_GATEWAY_BASE_URL
      : viaVpc
        ? FREELLMAPI_VPC_BASE_URL
        : trimTrailingSlashes(env.FREELLMAPI_TUNNEL_URL?.trim() || env.FREELLMAPI_BASE_URL?.trim() || "");
    const model = env.FREELLMAPI_CHAT_MODEL?.trim() || "auto";
    const visionModel = env.FREELLMAPI_VISION_MODEL?.trim() || "auto";
    const urlError = viaVpc || gatewayOnly ? undefined : validateFreeLlmApiBaseUrl(baseUrl, env);
    const configurationError = gatewayOnly ? undefined : urlError || (!apiKey
      ? "FreeLLMAPI is selected, but FREELLMAPI_API_KEY is missing. Use the unified key from your FreeLLMAPI dashboard."
      : undefined);
    return {
      id: "freellmapi",
      label: gatewayOnly ? "UX Direct gateway" : "FreeLLMAPI",
      apiKey: apiKey || (gatewayOnly ? "uxd-gateway" : ""),
      baseUrl,
      model,
      visionModel,
      // Defaults to the plain auto profile; FreeLLMAPI fails over between upstream models itself.
      figmaModels: modelList(env.FREELLMAPI_FIGMA_MODELS, [model]),
      figmaVisionModels: modelList(env.FREELLMAPI_FIGMA_VISION_MODELS, [visionModel]),
      configured: !configurationError,
      ...(configurationError ? { configurationError } : {}),
    };
  }

  return {
    id: "invalid",
    label: "Unsupported chat provider",
    apiKey: "",
    baseUrl: "",
    model: "",
    configured: false,
    configurationError: "UX_DIRECT_MODEL_PROVIDER (or legacy UX_DIRECT_CHAT_PROVIDER) must be either openrouter or freellmapi.",
  };
}

/**
 * The first FreeLLMAPI attempt gets room for an intelligence-first answer. FreeLLMAPI now runs on
 * an always-on Mac (no Render cold start), and a block spec is small, so 150 s only meant a hung
 * route held the user for minutes before the retry (speed priority, 2026-11-06).
 */
export const FREELLMAPI_FIRST_ATTEMPT_TIMEOUT_MS = 90_000;

/**
 * The compact FreeLLMAPI retry gets the rest of the budget (up to 100 s), not a flat 60 s:
 * FreeLLMAPI's own per-model timeout is 60 s, so a 60 s client cut killed the retry exactly
 * when its first hop stalled and the second hop was about to answer (2026-11-07 retest).
 */
export const FREELLMAPI_RECOVERY_TIMEOUT_MS = 100_000;

/**
 * Ordered model chain for Figma routes. OpenRouter keeps its explicit quality chain;
 * FreeLLMAPI uses the configured text or vision chain.
 */
export function figmaModelChain(provider: ActiveChatProvider, hasVisionInput: boolean, openRouterChain: string[]): string[] {
  if (provider.id === "openrouter") return [...openRouterChain];
  const chain = hasVisionInput
    ? (provider.figmaVisionModels?.length ? provider.figmaVisionModels : [provider.visionModel || "auto"])
    : (provider.figmaModels?.length ? provider.figmaModels : [provider.model]);
  return [...chain];
}

/**
 * Max data-URL length for a rendered Figma screenshot (~1.1 MB JPEG). The plugin now exports
 * screens at ~1400px locally instead of squeezing them into the bridge's 48 KB envelope.
 */
export const RENDERED_IMAGE_MAX_CHARS = 1_500_000;

/**
 * Quality first on FreeLLMAPI (free tokens): no output cap, so `auto` can pick models by
 * intelligence instead of being steered toward ones that fit a small budget and no plan is
 * cut off mid-JSON. Other providers keep the route's own cap.
 */
export function figmaMaxTokens(provider: ActiveChatProvider, cap: number): { max_tokens?: number } {
  return provider.id === "freellmapi" ? {} : { max_tokens: cap };
}

/**
 * Plain `auto` follows the user's own FreeLLMAPI routing (now the default blend), so normal calls
 * send no task-type bias. The old `code` bias pushed long Figma prompts onto slow "smart" models
 * (dots-3-note, glm-5.3-flash) that hit FreeLLMAPI's 60 s per-model timeout and left no answer.
 * A compact retry (`fast`) sends `chat`, FreeLLMAPI's soft speed bias, so a fallback fits the
 * budget. Still plain `auto`: no model is pinned and the user's chain decides.
 */
export function figmaRoutingHeaders(provider: ActiveChatProvider, options: { fast?: boolean } = {}): Record<string, string> {
  if (provider.id !== "freellmapi") return {};
  return options.fast ? { "X-FreeLLM-Task-Type": "chat" } : {};
}

/** Per-attempt timeout; the first FreeLLMAPI attempt also covers a host cold start. */
export function figmaAttemptTimeoutMs(provider: ActiveChatProvider, attemptIndex: number, firstMs: number, laterMs: number): number {
  if (provider.id === "freellmapi" && attemptIndex === 0) return Math.max(firstMs, FREELLMAPI_FIRST_ATTEMPT_TIMEOUT_MS);
  return attemptIndex === 0 ? firstMs : laterMs;
}

/**
 * Some free upstream models reject JSON mode or a parameter with a 4xx instead of failing over
 * inside FreeLLMAPI. Those requests are retried once on the same model without response_format.
 */
export function shouldRetryWithoutJsonMode(provider: ActiveChatProvider, status: number): boolean {
  return provider.id === "freellmapi" && [400, 404, 415, 422].includes(status);
}

/** FreeLLMAPI reports the upstream platform/model it actually used. */
export function routedVia(response: Response): string | undefined {
  const value = response.headers.get("x-routed-via")?.trim();
  return value ? value.slice(0, 160) : undefined;
}
