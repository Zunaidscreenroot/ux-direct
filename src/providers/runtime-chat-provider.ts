import { readR2Json, writeR2Json } from "@/src/storage/r2-json-store";
import { getActiveChatProvider, type ActiveChatProvider } from "@/src/providers/active-chat-provider";

export type RuntimeChatProviderId = "openrouter" | "freellmapi";

type ProviderPreference = {
  provider: RuntimeChatProviderId;
  updatedAt: string;
};

const PROVIDER_PREFERENCE_KEY = "ux-direct-settings/active-chat-provider.json";
const SUPPORTED_PROVIDERS: RuntimeChatProviderId[] = ["openrouter", "freellmapi"];

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

/** Resolve the provider for every chat/design request, keeping secrets server-side. */
export async function getResolvedActiveChatProvider(): Promise<ActiveChatProvider> {
  const preference = await readProviderPreference();
  return preference ? configuredProvider(preference.provider) : getActiveChatProvider();
}

export async function getProviderSwitcherState() {
  const [preference, defaultProvider] = await Promise.all([
    readProviderPreference(),
    Promise.resolve(getActiveChatProvider()),
  ]);
  const active = preference ? configuredProvider(preference.provider) : defaultProvider;
  const providers = SUPPORTED_PROVIDERS.map((id) => {
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
    activeProvider: active.id === "invalid" ? "openrouter" : active.id,
    activeProviderLabel: active.label,
    activeModel: active.model,
    preferenceSource: preference ? "saved" : "environment",
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
  return isRuntimeChatProviderId(value);
}

export function getConfiguredProvider(id: RuntimeChatProviderId): ActiveChatProvider {
  return configuredProvider(id);
}
