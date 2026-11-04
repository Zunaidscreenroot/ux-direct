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
    const baseUrl = trimTrailingSlashes(env.FREELLMAPI_TUNNEL_URL?.trim() || env.FREELLMAPI_BASE_URL?.trim() || "");
    const model = env.FREELLMAPI_CHAT_MODEL?.trim() || "auto";
    const visionModel = env.FREELLMAPI_VISION_MODEL?.trim() || "auto";
    const urlError = validateFreeLlmApiBaseUrl(baseUrl, env);
    const configurationError = urlError || (!apiKey
      ? "FreeLLMAPI is selected, but FREELLMAPI_API_KEY is missing. Use the unified key from your FreeLLMAPI dashboard."
      : undefined);
    return {
      id: "freellmapi",
      label: "FreeLLMAPI",
      apiKey,
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

/** The first FreeLLMAPI attempt covers a host wake-up and an uncapped, intelligence-first answer. */
export const FREELLMAPI_FIRST_ATTEMPT_TIMEOUT_MS = 150_000;

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
 * FreeLLMAPI treats `code` turns as "a wrong answer costs more than a slow one" and shifts
 * routing weight from speed to intelligence, while still using plain `auto`.
 */
export function figmaRoutingHeaders(provider: ActiveChatProvider): Record<string, string> {
  return provider.id === "freellmapi" ? { "X-FreeLLM-Task-Type": "code" } : {};
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
