import { readR2Json, writeR2Json } from "@/src/storage/r2-json-store";
import { getActiveChatProvider, type ActiveChatProvider } from "@/src/providers/active-chat-provider";

export type RuntimeChatProviderId = "openrouter" | "freellmapi";

type ProviderPreference = {
  provider: RuntimeChatProviderId;
  updatedAt: string;
};

const PROVIDER_PREFERENCE_KEY = "ux-direct-settings/active-chat-provider.json";
/**
 * Providers the plugin and routes may use right now. OpenRouter stays in the code but is
 * inactive: it is not offered in the plugin, not connection-checked, and a saved OpenRouter
 * preference is ignored. Add "openrouter" back here to re-enable it.
 */
const ENABLED_PROVIDERS: RuntimeChatProviderId[] = ["freellmapi"];

function isEnabledProvider(value: unknown): value is RuntimeChatProviderId {
  return isRuntimeChatProviderId(value) && ENABLED_PROVIDERS.includes(value);
}

function isRuntimeChatProviderId(value: unknown): value is RuntimeChatProviderId {
  return value === "openrouter" || value === "freellmapi";
}

function configuredProvider(id: RuntimeChatProviderId): ActiveChatProvider {
  return getActiveChatProvider({
    ...process.env,
    UX_DIRECT_MODEL_PROVIDER: id,
  });
}

async function readProviderPreference(): Promise<ProviderPreference | null> {
  try {
    const stored = await readR2Json<ProviderPreference>(PROVIDER_PREFERENCE_KEY);
    return stored && isRuntimeChatProviderId(stored.provider) ? stored : null;
  } catch (error) {
    // Keep local development and deployments with a temporarily unavailable preference store
    // able to use the environment-configured provider. The status route reports store health.
    console.warn("[ux-direct-provider] Could not read provider preference from R2", error);
    return null;
  }
}

function resolveEnabledProvider(preference: ProviderPreference | null): ActiveChatProvider {
  if (preference && isEnabledProvider(preference.provider)) return configuredProvider(preference.provider);
  const fromEnv = getActiveChatProvider();
  return isEnabledProvider(fromEnv.id) ? fromEnv : configuredProvider(ENABLED_PROVIDERS[0]);
}

/** Resolve the provider for every chat/design request, keeping secrets server-side. */
export async function getResolvedActiveChatProvider(): Promise<ActiveChatProvider> {
  return resolveEnabledProvider(await readProviderPreference());
}

export async function getProviderSwitcherState() {
  const preference = await readProviderPreference();
  const active = resolveEnabledProvider(preference);
  const providers = ENABLED_PROVIDERS.map((id) => {
    const provider = configuredProvider(id);
    return {
      id,
      label: provider.label,
      configured: provider.configured,
      model: provider.model,
      ...(provider.configurationError ? { configurationError: provider.configurationError } : {}),
    };
  });

  return {
    activeProvider: active.id === "invalid" ? ENABLED_PROVIDERS[0] : active.id,
    activeProviderLabel: active.label,
    activeModel: active.model,
    preferenceSource: preference && isEnabledProvider(preference.provider) ? "saved" : "environment",
    providers,
  };
}

export async function setActiveChatProviderPreference(provider: RuntimeChatProviderId): Promise<void> {
  await writeR2Json(PROVIDER_PREFERENCE_KEY, {
    provider,
    updatedAt: new Date().toISOString(),
  } satisfies ProviderPreference);
}

export function isSupportedRuntimeChatProvider(value: unknown): value is RuntimeChatProviderId {
  return isEnabledProvider(value);
}

export function getConfiguredProvider(id: RuntimeChatProviderId): ActiveChatProvider {
  return configuredProvider(id);
}
