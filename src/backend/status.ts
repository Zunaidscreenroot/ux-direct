import { FIGMA_PROVIDER_OPTIONS, isFigmaProviderConfigured, selectFigmaProvider, type FigmaProviderId } from "@/src/providers/figma-llm";

type Env = Record<string, string | undefined>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const trimSlash = (value: string) => value.replace(/\/+$/, "");

export type ProviderStatus = {
  id: FigmaProviderId; label: string; model: string; description: string;
  configured: boolean; reachable: boolean | null; detail: string;
};
export type BackendStatus = {
  checkedAt: string;
  backend: { ok: true; host: string; platform: "cloudflare-workers" };
  plugin: { connected: boolean; sessions: number; lastHeartbeatAt: string | null };
  providers: { selected: FigmaProviderId; options: ProviderStatus[] };
  brain: { reachable: boolean | null };
  uxAudit: { reachable: boolean | null };
  chatgpt: { state: "connected" | "idle" | "not_seen" | "unknown"; lastActivityAt: string | null };
};

async function probe(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<{ ok: boolean; status: number | null; error?: string }> {
  try {
    const response = await fetchImpl(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message.slice(0, 120) : "request failed" };
  }
}

export async function probeProvider(id: FigmaProviderId, env: Env, fetchImpl: FetchLike): Promise<Pick<ProviderStatus, "configured" | "reachable" | "detail">> {
  if (!isFigmaProviderConfigured(id, env)) {
    return { configured: false, reachable: null, detail: id === "freellmapi" ? "Add FREELLMAPI_BASE_URL and FREELLMAPI_API_KEY to the Worker." : "Add OPENROUTER_API_KEY to the Worker." };
  }
  if (id === "freellmapi") {
    const result = await probe(fetchImpl, trimSlash(env.FREELLMAPI_BASE_URL!.trim()) + "/models", { headers: { Authorization: "Bearer " + env.FREELLMAPI_API_KEY!.trim() } }, 6000);
    return result.ok
      ? { configured: true, reachable: true, detail: "Router reachable; model auto." }
      : { configured: true, reachable: false, detail: result.status === 401 || result.status === 403 ? "FreeLLMAPI rejected the key (HTTP " + result.status + ")." : "FreeLLMAPI unreachable" + (result.error ? ": " + result.error : result.status ? " (HTTP " + result.status + ")" : ".") };
  }
  const base = trimSlash(env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1");
  const result = await probe(fetchImpl, base + "/key", { headers: { Authorization: "Bearer " + env.OPENROUTER_API_KEY!.trim() } }, 8000);
  return result.ok
    ? { configured: true, reachable: true, detail: "API key verified; auto router with low cost and image input." }
    : { configured: true, reachable: false, detail: result.status === 401 || result.status === 403 ? "OpenRouter rejected the key (HTTP " + result.status + ")." : "OpenRouter unreachable" + (result.error ? ": " + result.error : ".") };
}

export async function collectBackendStatus(args: {
  host: string; clientId?: string; env?: Env; fetchImpl?: FetchLike; now?: number;
  getPlugin?: (clientId?: string) => Promise<{ connected: boolean; connectedSessions: number; lastHeartbeatAt: string | null }>;
  getChatGpt?: () => Promise<{ state: "connected" | "idle" | "not_seen"; lastActivityAt: string | null }>;
}): Promise<BackendStatus> {
  const env = args.env ?? process.env;
  const fetchImpl = args.fetchImpl ?? (fetch as FetchLike);
  const auditBase = trimSlash(env.UX_AUDIT_BASE_URL?.trim() || "https://uxaudit.zunaid-cb7.workers.dev");
  const brainUrl = new URL("/api/brain/health", env.UX_DIRECT_PUBLIC_URL || "https://ux-direct.zunaid-cb7.workers.dev").toString();
  const [selected, providerResults, audit, brain, plugin, chatgpt] = await Promise.all([
    selectFigmaProvider(undefined, env),
    Promise.all(FIGMA_PROVIDER_OPTIONS.map((option) => probeProvider(option.id, env, fetchImpl))),
    probe(fetchImpl, auditBase + "/", {}, 5000),
    env.UX_DIRECT_BRAIN_API_KEY ? probe(fetchImpl, brainUrl, { headers: { Authorization: "Bearer " + env.UX_DIRECT_BRAIN_API_KEY } }, 4000) : Promise.resolve({ ok: false, status: null }),
    (args.getPlugin?.(args.clientId) ?? Promise.reject(new Error("no plugin reader"))).catch(() => null),
    (args.getChatGpt?.() ?? Promise.reject(new Error("no chatgpt reader"))).catch(() => null),
  ]);
  return {
    checkedAt: new Date(args.now ?? Date.now()).toISOString(),
    backend: { ok: true, host: args.host, platform: "cloudflare-workers" },
    plugin: plugin
      ? { connected: plugin.connected, sessions: plugin.connectedSessions, lastHeartbeatAt: plugin.lastHeartbeatAt }
      : { connected: false, sessions: 0, lastHeartbeatAt: null },
    providers: { selected, options: FIGMA_PROVIDER_OPTIONS.map((option, index) => ({ ...option, ...providerResults[index] })) },
    brain: { reachable: env.UX_DIRECT_BRAIN_API_KEY ? brain.ok : null },
    uxAudit: { reachable: audit.ok },
    chatgpt: chatgpt ? { state: chatgpt.state, lastActivityAt: chatgpt.lastActivityAt } : { state: "unknown", lastActivityAt: null },
  };
}
