export type ChatProviderId = "openrouter" | "freellmapi" | "invalid";

export type ActiveChatProvider = {
  id: ChatProviderId;
  label: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  configured: boolean;
  configurationError?: string;
};

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

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
    const baseUrl = trimTrailingSlashes(env.FREELLMAPI_BASE_URL?.trim() || "");
    const model = env.FREELLMAPI_CHAT_MODEL?.trim() || "auto";
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
