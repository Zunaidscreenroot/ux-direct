import { getCloudflareContext } from "@opennextjs/cloudflare";

import { FREELLMAPI_VPC_BASE_URL, UXD_GATEWAY_BASE_URL, llmGatewayMode } from "./active-chat-provider";
import { gatewayAvailability, gatewayChatCompletion } from "@/src/llm-gateway/router";
import { writeCalls } from "@/src/llm-gateway/call-log";

/**
 * Every model call goes through providerFetch. It routes chat completions between
 * UX Direct's own in-Worker gateway (src/llm-gateway) and FreeLLMAPI on the owner's Mac,
 * by UXD_LLM_GATEWAY:
 *   off      FreeLLMAPI only (old behaviour)
 *   fallback FreeLLMAPI first; the gateway answers when FreeLLMAPI is down, 429s or 5xx (default)
 *   primary  gateway first; FreeLLMAPI only when the gateway has no answer
 *   only     gateway only (Mac and tunnel no longer needed)
 * FreeLLMAPI on the Mac is reached through the FREELLMAPI_VPC binding (named tunnel, no public URL).
 */

type FetchBinding = { fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> };

function vpcBinding(): FetchBinding | null {
  try {
    const candidate = (getCloudflareContext().env as unknown as Record<string, unknown>).FREELLMAPI_VPC as Partial<FetchBinding> | undefined;
    return candidate && typeof candidate.fetch === "function" ? (candidate as FetchBinding) : null;
  } catch {
    return null;
  }
}

function freeLlmApiBases(): string[] {
  return [FREELLMAPI_VPC_BASE_URL, process.env.FREELLMAPI_TUNNEL_URL, process.env.FREELLMAPI_BASE_URL]
    .map((value) => (value || "").trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

async function freeLlmApiFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!url.startsWith(FREELLMAPI_VPC_BASE_URL)) return fetch(url, init);
  const binding = vpcBinding();
  if (!binding) throw new Error("FREELLMAPI_TRANSPORT=vpc, but the FREELLMAPI_VPC binding is missing on this Worker.");
  return binding.fetch(url, init);
}

function waitUntil(promise: Promise<unknown>) {
  const settled = promise.catch((error) => console.warn("[uxd-gateway] FreeLLMAPI log failed", error));
  try { getCloudflareContext().ctx.waitUntil(settled); } catch { /* local/test */ }
}

/** Log a FreeLLMAPI call next to gateway calls so the analytics view can compare them. */
function logFreeLlmApi(response: Response | null, error: unknown, started: number, body: string, headers: Headers) {
  let stream = false;
  let role = "default";
  try {
    const parsed = JSON.parse(body) as { stream?: unknown };
    stream = parsed.stream === true;
  } catch { /* not JSON */ }
  role = headers.get("x-uxd-agent-role") || (headers.get("x-freellm-task-type") === "chat" ? "fast-retry" : stream ? "chat" : "default");
  const routed = response?.headers.get("x-routed-via")?.trim() || "auto";
  const [provider, ...rest] = routed.includes("/") ? routed.split("/") : ["freellmapi", routed];
  const base = {
    requestId: headers.get("x-uxd-request-id") || crypto.randomUUID(), gateway: "freellmapi" as const, role,
    provider: provider || "freellmapi", model: rest.join("/") || routed, attempt: 1, stream, latencyMs: Date.now() - started,
  };
  if (!response) {
    waitUntil(writeCalls([{ ...base, ok: false, httpStatus: 0, error: error instanceof Error ? error.message : String(error) }]));
    return;
  }
  if (!response.ok || stream) {
    waitUntil(writeCalls([{ ...base, ok: response.ok, httpStatus: response.status, ...(response.ok ? {} : { error: "HTTP " + response.status }) }]));
    return;
  }
  waitUntil(response.clone().json().then((json: { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }) => writeCalls([{
    ...base, ok: true, httpStatus: response.status, latencyMs: Date.now() - started,
    promptTokens: json.usage?.prompt_tokens, completionTokens: json.usage?.completion_tokens, totalTokens: json.usage?.total_tokens,
  }])));
}

function isChatCompletions(url: string): boolean {
  return /\/chat\/completions\/?(\?.*)?$/.test(url);
}

/** FreeLLMAPI failures the gateway should cover: tunnel/Mac down, upstream 5xx, rate limits. */
export function freeLlmApiShouldFallBack(status: number): boolean {
  return status === 429 || status >= 500;
}

async function gatewayModelsResponse(): Promise<Response> {
  const availability = await gatewayAvailability();
  const data = availability.providers.flatMap((provider) => provider.models.map((model) => ({ id: provider.id + ":" + model, object: "model", owned_by: provider.id })));
  return Response.json({ object: "list", data: [{ id: "auto", object: "model", owned_by: "uxd-gateway" }, ...data] });
}

/** fetch() for model-provider calls. */
export async function providerFetch(url: string, init?: RequestInit): Promise<Response> {
  const isGatewayUrl = url.startsWith(UXD_GATEWAY_BASE_URL);
  const isFreeLlmApi = !isGatewayUrl && freeLlmApiBases().some((base) => url.startsWith(base));
  if (!isGatewayUrl && !isFreeLlmApi) return fetch(url, init);

  const mode = llmGatewayMode();
  if (isGatewayUrl && !isChatCompletions(url)) return gatewayModelsResponse();
  if (!isChatCompletions(url) || (isFreeLlmApi && mode === "off")) return freeLlmApiFetch(url, init);

  const body = typeof init?.body === "string" ? init.body : "";
  const headers = new Headers(init?.headers);
  const signal = init?.signal ?? null;
  const viaGateway = () => gatewayChatCompletion(body, headers, signal);

  if (isGatewayUrl || mode === "only") return viaGateway();

  const viaFreeLlmApi = async (): Promise<Response> => {
    const started = Date.now();
    try {
      const response = await freeLlmApiFetch(url, init);
      logFreeLlmApi(response, null, started, body, headers);
      return response;
    } catch (error) {
      logFreeLlmApi(null, error, started, body, headers);
      throw error;
    }
  };

  if (mode === "primary") {
    const response = await viaGateway();
    if (response.ok || signal?.aborted || !freeLlmApiBases().length) return response;
    // 4xx from the caller's own request (bad body) would fail on FreeLLMAPI too.
    if (response.status === 400 && !response.headers.get("x-uxd-gateway-empty")) return response;
    return viaFreeLlmApi().catch(() => response);
  }

  // fallback: FreeLLMAPI first.
  let response: Response;
  try {
    response = await viaFreeLlmApi();
  } catch (error) {
    if (signal?.aborted) throw error;
    const covered = await viaGateway();
    if (covered.headers.get("x-uxd-gateway-empty")) throw error;
    return covered;
  }
  if (!freeLlmApiShouldFallBack(response.status) || signal?.aborted) return response;
  const covered = await viaGateway();
  if (!covered.ok) return response;
  await response.body?.cancel().catch(() => {});
  return covered;
}
