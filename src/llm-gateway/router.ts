import { getCloudflareContext } from "@opennextjs/cloudflare";

import {
  configuredProviders, freeModelsFromListing, isAllowedModel, modelLimits, modelSupportsVision, modelTier, providerKeys,
  type ProviderDef, type Tier,
} from "./catalog";
import { readModelUsage, writeCalls, type CallRecord, type ModelUsage } from "./call-log";
import { ROLE_ROUTES, chainRank, nextTurn, resetRotation, seatFor, type SeatRole } from "./roles";

/**
 * UX Direct's own free-model router, running inside the Worker (no Mac, no tunnel).
 * Takes an OpenAI chat-completions body, picks a free model that fits the agent role, is under
 * its RPM/RPD and not cooling down, and fails over to a different provider on 429/5xx/timeout.
 * Every attempt is logged to Neon (uxd_llm_calls) for routing and the analytics view.
 */

type Env = Record<string, string | undefined>;
type AiBinding = { run(model: string, input: Record<string, unknown>): Promise<unknown> };

export type { GatewayRole } from "./roles";

/** Routing policy per seat (see roles.ts for the model map). */
export const ROLE_POLICIES = ROLE_ROUTES;

/** The seat a request routes as: explicit X-UXD-Agent-Role (aliases allowed), else chat/default heuristics. */
export function resolveRole(headers: Headers, body: Record<string, unknown>): SeatRole {
  const seat = seatFor(headers.get("x-uxd-agent-role") || "");
  if (seat) return seat;
  if ((headers.get("x-freellm-task-type") || "").toLowerCase() === "chat") return "fast-retry";
  const model = typeof body.model === "string" ? body.model : "";
  if (model === "auto:fast") return "chat";
  if (body.stream === true) return "chat";
  return "default";
}

// ---------- environment ----------

function cfEnv(): Record<string, unknown> {
  try { return getCloudflareContext().env as unknown as Record<string, unknown>; } catch { return {}; }
}

export function gatewayEnv(): Env {
  const env: Env = { ...process.env };
  for (const [key, value] of Object.entries(cfEnv())) if (typeof value === "string" && env[key] === undefined) env[key] = value;
  return env;
}

function aiBinding(): AiBinding | null {
  const candidate = cfEnv().AI as Partial<AiBinding> | undefined;
  return candidate && typeof candidate.run === "function" ? candidate as AiBinding : null;
}

function waitUntil(promise: Promise<unknown>) {
  const settled = promise.catch((error) => console.warn("[uxd-gateway] log write failed", error));
  try { getCloudflareContext().ctx.waitUntil(settled); } catch { /* local/test: fire and forget */ }
}

// ---------- shared state (per isolate; Neon is the cross-isolate truth) ----------

const cooldowns = new Map<string, number>();
const localHits = new Map<string, number[]>();
const discovered = new Map<string, { models: string[]; at: number }>();
let usageCache: { rows: Map<string, ModelUsage>; at: number } | null = null;
let keyCursor = 0;

const USAGE_TTL_MS = 15_000;
const DISCOVERY_TTL_MS = 6 * 60 * 60 * 1000;

const slot = (provider: string, model: string) => provider + "/" + model;

export function resetGatewayStateForTests() {
  cooldowns.clear(); localHits.clear(); discovered.clear(); usageCache = null; keyCursor = 0; resetRotation();
}

async function usageMap(): Promise<Map<string, ModelUsage>> {
  if (usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) return usageCache.rows;
  let rows: ModelUsage[] = [];
  try { rows = await readModelUsage(); } catch (error) { console.warn("[uxd-gateway] usage read failed", error); }
  const map = new Map(rows.map((row) => [slot(row.provider, row.model), row]));
  usageCache = { rows: map, at: Date.now() };
  // Hits newer than this snapshot stay counted locally.
  for (const [key, hits] of localHits) localHits.set(key, hits.filter((at) => at > Date.now() - 60_000));
  return map;
}

function recordLocalHit(key: string) {
  const hits = localHits.get(key) || [];
  hits.push(Date.now());
  localHits.set(key, hits.slice(-200));
}

function nextUtcMidnight(now = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

/** How long a model is benched after a failure (null = no bench, just try the next one). */
export function cooldownFor(status: number, message: string, retryAfter: string | null, now = Date.now()): number | null {
  const retrySeconds = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
  if (status === 429) {
    if (/per[\s_-]?day|daily|requests per day|RPD|quota.*day|day.*quota/i.test(message)) return Math.min(nextUtcMidnight(now), now + 12 * 3600_000);
    return now + (Number.isFinite(retrySeconds) ? Math.min(Math.max(retrySeconds, 5), 3600) * 1000 : 60_000);
  }
  // Model exists but is outside the free tier (Mistral large/medium): skip it for a day.
  if ((status === 403 || status === 401 || status === 429) && /subscription tier|not available (in|on|for) your|paid (plan|tier|version)|unavailable for free/i.test(message)) return now + 24 * 3600_000;
  if (status === 401 || status === 403) return now + 3600_000;
  if (status === 404 || (status === 400 && /model.*(not|does not|doesn't) (exist|found|support)|unknown model|decommissioned|deprecated|no longer available/i.test(message))) return now + 24 * 3600_000;
  if (status === 402) return now + 6 * 3600_000;
  if (status === 413 || /context|too long|maximum.*tokens|token limit/i.test(message)) return null;
  if (status >= 500 || status === 0) return now + 30_000;
  return null;
}

// ---------- candidates ----------

export type Candidate = { provider: ProviderDef; model: string; tier: Tier; score: number };

async function providerModels(provider: ProviderDef, env: Env): Promise<string[]> {
  if (!provider.discover) return provider.models;
  const cached = discovered.get(provider.id);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.models;
  const key = providerKeys(provider, env)[0];
  let models = provider.models;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    const response = await fetch(provider.baseUrl + "/models", { headers: { Authorization: "Bearer " + key }, signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) {
      const live = freeModelsFromListing(provider, await response.json());
      if (live.length) {
        models = pickDetectedModels(provider.models, live);
      }
    }
  } catch { /* detection is best-effort; defaults stay */ }
  discovered.set(provider.id, { models, at: Date.now() });
  return models;
}

const TIER_ORDER: Record<Tier, number> = { strong: 0, medium: 1, fast: 2 };

/**
 * Detected free models win over the hand-kept defaults (ids drift monthly): every live model,
 * best tier first (defaults first inside a tier), capped at 10 so routing stays cheap.
 * Two fast models are always kept so chat roles have something quick.
 */
export function pickDetectedModels(defaults: string[], live: string[]): string[] {
  const rank = (model: string) => TIER_ORDER[modelTier(model)] * 100 + (defaults.includes(model) ? defaults.indexOf(model) : 50);
  const sorted = [...new Set(live)].sort((a, b) => rank(a) - rank(b));
  const fast = sorted.filter((model) => modelTier(model) === "fast").slice(0, 2);
  const picked = [...new Set([...sorted.filter((model) => modelTier(model) !== "fast").slice(0, 8), ...fast])];
  return picked.length ? picked : defaults;
}

export function estimatePromptTokens(body: Record<string, unknown>): number {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let chars = 0;
  let images = 0;
  for (const message of messages) {
    const content = message && typeof message === "object" ? (message as { content?: unknown }).content : "";
    if (typeof content === "string") chars += content.length;
    else if (Array.isArray(content)) for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "image_url") images++;
      else if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") chars += (part as { text: string }).text.length;
    }
  }
  return Math.ceil(chars / 3.6) + images * 1_500;
}

export function hasImages(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.some((message) => {
    const content = message && typeof message === "object" ? (message as { content?: unknown }).content : null;
    return Array.isArray(content) && content.some((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "image_url");
  });
}

/** Pure ranking step (exported for tests). */
export function rankCandidates(input: {
  providers: Array<{ provider: ProviderDef; models: string[] }>;
  role: SeatRole;
  promptTokens: number;
  vision: boolean;
  usage: Map<string, ModelUsage>;
  cooldowns: Map<string, number>;
  localHits: Map<string, number[]>;
  pinned?: { provider?: string; model: string };
  now?: number;
  random?: () => number;
  maxAttempts?: number;
  /** Rotation index for the seat's primary pool (spreads parallel calls across providers). */
  turn?: number;
}): Candidate[] {
  const now = input.now ?? Date.now();
  const random = input.random ?? Math.random;
  const policy = ROLE_POLICIES[input.role];
  const turn = input.turn ?? 0;
  const list: Candidate[] = [];
  for (const { provider, models } of input.providers) {
    if ((input.cooldowns.get(provider.id + "/*") ?? 0) > now) continue;
    // Account-wide daily allowance (OpenRouter: 50 free calls a day across every :free model).
    if (provider.accountRpd) {
      let today = 0;
      for (const [key, row] of input.usage) if (key.startsWith(provider.id + "/")) today += row.today;
      if (today >= Math.floor(provider.accountRpd * 0.9)) continue;
    }
    for (const model of models) {
      if (!isAllowedModel(provider, model)) continue;
      if (input.pinned && (input.pinned.model !== model || (input.pinned.provider && input.pinned.provider !== provider.id))) continue;
      const key = slot(provider.id, model);
      if ((input.cooldowns.get(key) ?? 0) > now) continue;
      const usage = input.usage.get(key);
      if ((usage?.cooldownUntil ?? 0) > now) continue;
      if (input.vision && (provider.id === "workers-ai" || !modelSupportsVision(model))) continue;
      if (input.promptTokens > provider.maxInputTokens) continue;
      const limits = modelLimits(provider, model);
      const recentLocal = (input.localHits.get(key) || []).filter((at) => at > now - 60_000).length;
      const minuteUse = Math.max(usage?.lastMinute ?? 0, recentLocal);
      if (minuteUse >= Math.max(1, Math.floor(limits.rpm * 0.85))) continue;
      if (limits.rpd && (usage?.today ?? 0) >= Math.floor(limits.rpd * 0.9)) continue;
      const tier = modelTier(model);
      const tierIndex = policy.tiers.indexOf(tier);
      const calls = usage?.calls24h ?? 0;
      const success = ((usage?.ok24h ?? 0) + 2) / (calls + 2.5);
      const latencySeconds = (usage?.avgLatencyMs ?? 0) / 1000;
      const rank = chainRank(policy, provider.id, model, turn);
      const score = (40 - Math.min(rank, 40)) * 50
        + (3 - tierIndex) * 40
        + success * 60
        - latencySeconds * (policy.lowLatency ? 4 : 0.8)
        - (minuteUse / limits.rpm) * 20
        + random() * 18;
      list.push({ provider, model, tier, score });
    }
  }
  list.sort((a, b) => b.score - a.score);
  // Spread load: the next hop prefers a different provider than the one that just failed.
  const ordered: Candidate[] = [];
  const pool = [...list];
  while (pool.length) {
    const last = ordered[ordered.length - 1]?.provider.id;
    const index = pool.findIndex((candidate) => candidate.provider.id !== last);
    ordered.push(pool.splice(index >= 0 ? index : 0, 1)[0]);
  }
  return ordered.slice(0, input.maxAttempts ?? policy.maxAttempts);
}

// ---------- provider calls ----------

const OPENAI_FIELDS = new Set(["model", "messages", "temperature", "top_p", "max_tokens", "stream", "stop", "response_format", "seed", "presence_penalty", "frequency_penalty"]);

export function providerBody(provider: ProviderDef, model: string, body: Record<string, unknown>, jsonMode: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) if (OPENAI_FIELDS.has(key)) out[key] = value;
  out.model = model;
  if (!jsonMode) delete out.response_format;
  const requested = typeof body.max_tokens === "number" ? body.max_tokens : undefined;
  if (requested && requested > provider.maxOutputTokens) out.max_tokens = provider.maxOutputTokens;
  if (out.stream === true && ["groq", "cerebras", "openrouter", "nvidia"].includes(provider.id)) out.stream_options = { include_usage: true };
  return out;
}

type AttemptOutcome =
  | { ok: true; response: Response; usage?: Usage; streamed: boolean }
  | { ok: false; status: number; message: string; retryAfter: string | null };
type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n");
  return "";
}

function sse(text: string, model: string): string {
  return "data: " + JSON.stringify({ object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }) + "\n\n"
    + "data: " + JSON.stringify({ object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n";
}

/** Answer text from a Workers AI result: chat (`choices`), legacy (`response`) or Responses API (`output`). */
export function workersAiText(result: Record<string, unknown> | null | undefined): unknown {
  if (!result) return "";
  const choices = Array.isArray(result.choices) ? result.choices as Array<{ message?: { content?: unknown } }> : null;
  if (choices) return choices[0]?.message?.content;
  if (result.response !== undefined && result.response !== null) return result.response;
  if (typeof result.output_text === "string") return result.output_text;
  if (Array.isArray(result.output)) {
    const parts: string[] = [];
    for (const item of result.output as Array<{ type?: string; content?: Array<{ type?: string; text?: unknown }> }>) {
      if (item?.type !== "message" || !Array.isArray(item.content)) continue;
      for (const part of item.content) if (typeof part?.text === "string") parts.push(part.text);
    }
    return parts.join("");
  }
  return "";
}

async function callWorkersAi(model: string, body: Record<string, unknown>, signal: AbortSignal): Promise<AttemptOutcome> {
  const ai = aiBinding();
  if (!ai) return { ok: false, status: 503, message: "AI binding missing", retryAfter: null };
  const messages = (Array.isArray(body.messages) ? body.messages : []).map((message) => {
    const record = message as { role?: unknown; content?: unknown };
    return { role: String(record.role || "user"), content: textOf(record.content) };
  });
  const maxTokens = Math.min(typeof body.max_tokens === "number" ? body.max_tokens : 4_096, 4_096);
  const temperature = typeof body.temperature === "number" ? { temperature: body.temperature } : {};
  // gpt-oss on Workers AI speaks the Responses API ("input"); the rest take chat "messages".
  const run = /gpt-oss/.test(model)
    ? ai.run(model, { input: messages, max_output_tokens: maxTokens, reasoning: { effort: "low" }, ...temperature })
    : ai.run(model, { messages, max_tokens: maxTokens, ...temperature });
  const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true }));
  try {
    const result = await Promise.race([run, aborted]) as Record<string, unknown>;
    const raw = workersAiText(result);
    const text = typeof raw === "string" ? raw : raw && typeof raw === "object" ? JSON.stringify(raw) : "";
    if (!text.trim()) return { ok: false, status: 502, message: "empty answer", retryAfter: null };
    const usage = (result?.usage || undefined) as Usage | undefined;
    const response = body.stream === true
      ? new Response(sse(text, model), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } })
      : Response.json({ id: "wai-" + Date.now(), object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], ...(usage ? { usage } : {}) });
    return { ok: true, response, usage, streamed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /capacity|neuron|limit|429/i.test(message) ? 429 : signal.aborted ? 0 : 502;
    return { ok: false, status, message: message.slice(0, 300), retryAfter: null };
  }
}

async function callOpenAiCompatible(provider: ProviderDef, key: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<AttemptOutcome> {
  let response: Response;
  try {
    response = await fetch(provider.baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Accept: payload.stream === true ? "text/event-stream" : "application/json",
        ...(provider.id === "openrouter" ? { "HTTP-Referer": "https://ux-direct.app", "X-Title": "UX Direct" } : {}),
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    return { ok: false, status: 0, message: signal.aborted ? "timed out" : (error instanceof Error ? error.message : String(error)).slice(0, 300), retryAfter: null };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
      message = String(typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message ?? text);
    } catch { /* plain text */ }
    return { ok: false, status: response.status, message: message.slice(0, 300) || "HTTP " + response.status, retryAfter: response.headers.get("retry-after") };
  }
  if (payload.stream === true) return { ok: true, response, streamed: true };
  try {
    const json = await response.json() as Record<string, unknown>;
    const choice = Array.isArray(json.choices) ? json.choices[0] as { message?: { content?: unknown; tool_calls?: unknown } } : undefined;
    const content = choice?.message?.content;
    if (!textOf(content).trim() && !choice?.message?.tool_calls) return { ok: false, status: 502, message: "empty answer", retryAfter: null };
    return { ok: true, response: Response.json({ ...json, model: json.model || payload.model }), usage: json.usage as Usage | undefined, streamed: false };
  } catch (error) {
    return { ok: false, status: signal.aborted ? 0 : 502, message: signal.aborted ? "timed out" : "unreadable JSON: " + String(error).slice(0, 120), retryAfter: null };
  }
}

/** Pass an SSE stream through while reading the final usage chunk for the log. */
function meterStream(body: ReadableStream<Uint8Array>, onDone: (usage: Usage | undefined, error?: string) => void): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  let usage: Usage | undefined;
  const scan = (text: string) => {
    const lines = (pending + text).split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:") || !line.includes("\"usage\"")) continue;
      try {
        const parsed = JSON.parse(line.slice(5).trim()) as { usage?: Usage };
        if (parsed.usage) usage = parsed.usage;
      } catch { /* partial or non-JSON line */ }
    }
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { scan(decoder.decode(chunk, { stream: true })); controller.enqueue(chunk); },
    flush() { scan(decoder.decode() + "\n"); onDone(usage); },
  }));
}

function failure(status: number, message: string, errors: string[]): Response {
  return Response.json(
    { error: { message: message + (errors.length ? " Attempts: " + errors.join(" | ") : ""), type: "uxd_gateway_error" } },
    { status, headers: { "x-uxd-gateway": "uxd" } },
  );
}

export type GatewayAvailability = { providers: Array<{ id: string; label: string; models: string[] }> };

export async function gatewayAvailability(): Promise<GatewayAvailability> {
  const env = gatewayEnv();
  const providers = configuredProviders(env, Boolean(aiBinding()));
  const withModels = await Promise.all(providers.map(async (provider) => ({ id: provider.id, label: provider.label, models: await providerModels(provider, env) })));
  return { providers: withModels };
}

/**
 * Run one OpenAI chat-completions request through the gateway.
 * Returns an OpenAI-shaped Response (JSON or SSE) with `x-routed-via: provider/model`.
 * Status 503 with `x-uxd-gateway-empty: 1` means no provider/model was available at all.
 */
export async function gatewayChatCompletion(rawBody: string, headers: Headers, signal?: AbortSignal | null): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { return failure(400, "Request body is not JSON.", []); }
  const env = gatewayEnv();
  const role = resolveRole(headers, body);
  const policy = ROLE_POLICIES[role];
  const requestId = headers.get("x-uxd-request-id") || crypto.randomUUID();
  const providers = configuredProviders(env, Boolean(aiBinding()));
  const requestedModel = typeof body.model === "string" ? body.model.trim() : "auto";
  // "auto", "auto:*" and FreeLLMAPI-style aliases route freely; "provider:model" or a known model id pins it.
  const pinned = /^auto(:|$)/.test(requestedModel) || !requestedModel ? undefined
    : requestedModel.includes(":") && providers.some((provider) => requestedModel.startsWith(provider.id + ":"))
      ? { provider: requestedModel.split(":")[0], model: requestedModel.slice(requestedModel.indexOf(":") + 1) }
      : { model: requestedModel };
  const [withModels, usage] = await Promise.all([
    Promise.all(providers.map(async (provider) => ({ provider, models: await providerModels(provider, env) }))),
    usageMap(),
  ]);
  const maxAttempts = Math.max(1, Math.min(10, Number(env.UXD_GW_MAX_ATTEMPTS) || policy.maxAttempts));
  const turn = nextTurn(role);
  let candidates = rankCandidates({
    providers: withModels, role, promptTokens: estimatePromptTokens(body), vision: hasImages(body),
    usage, cooldowns, localHits, pinned, maxAttempts, turn,
  });
  if (!candidates.length && pinned && !headers.get("x-uxd-gateway-strict")) {
    candidates = rankCandidates({ providers: withModels, role, promptTokens: estimatePromptTokens(body), vision: hasImages(body), usage, cooldowns, localHits, maxAttempts, turn });
  }
  if (!candidates.length) {
    const response = failure(503, providers.length
      ? "Every free model is cooling down or at its rate limit right now."
      : "No gateway provider is configured (add a provider key as a Worker secret).", []);
    response.headers.set("x-uxd-gateway-empty", "1");
    return response;
  }

  const records: CallRecord[] = [];
  const errors: string[] = [];
  let lastStatus = 502;
  let jsonRetryUsed = false;
  const plainRetryAt = new Set<number>();
  for (let index = 0; index < candidates.length; index++) {
    if (signal?.aborted) { errors.push("stopped by caller"); break; }
    const { provider, model } = candidates[index];
    const key = slot(provider.id, model);
    // Never send a paid OpenRouter id, whatever the ranking or a pinned request says.
    if (!isAllowedModel(provider, model)) { errors.push(key + ": refused (not a :free model)"); continue; }
    const keys = providerKeys(provider, env);
    const apiKey = keys.length ? keys[(keyCursor++) % keys.length] : "";
    const payload = providerBody(provider, model, body, !plainRetryAt.has(index));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, policy.attemptTimeoutMs);
    const started = Date.now();
    recordLocalHit(key);
    const outcome = provider.id === "workers-ai"
      ? await callWorkersAi(model, payload, controller.signal)
      : await callOpenAiCompatible(provider, apiKey, payload, controller.signal);
    // Streams keep the timer cleared only after headers; the body has no app-imposed limit.
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    const latencyMs = Date.now() - started;
    const base = { requestId, gateway: "uxd" as const, role, provider: provider.id, model, attempt: index + 1, stream: body.stream === true };

    if (outcome.ok) {
      const responseHeaders = new Headers(outcome.response.headers);
      responseHeaders.set("x-routed-via", key);
      responseHeaders.set("x-uxd-gateway", "uxd");
      responseHeaders.delete("content-length");
      if (outcome.streamed && outcome.response.body) {
        const metered = meterStream(outcome.response.body, (streamUsage) => {
          waitUntil(writeCalls([...records, { ...base, ok: true, httpStatus: 200, latencyMs, promptTokens: streamUsage?.prompt_tokens, completionTokens: streamUsage?.completion_tokens, totalTokens: streamUsage?.total_tokens }]));
        });
        return new Response(metered, { status: 200, headers: responseHeaders });
      }
      records.push({ ...base, ok: true, httpStatus: 200, latencyMs, promptTokens: outcome.usage?.prompt_tokens, completionTokens: outcome.usage?.completion_tokens, totalTokens: outcome.usage?.total_tokens });
      waitUntil(writeCalls(records));
      return new Response(outcome.response.body, { status: 200, headers: responseHeaders });
    }

    lastStatus = outcome.status || 504;
    const until = cooldownFor(outcome.status, outcome.message, outcome.retryAfter);
    if (until) cooldowns.set(key, until);
    // Account-wide daily cap hit: the whole provider is out until it resets.
    if (until && outcome.status === 429 && /free-models-per-day|per[\s_-]?day.*(account|key)/i.test(outcome.message)) cooldowns.set(provider.id + "/*", until);
    records.push({ ...base, ok: false, httpStatus: outcome.status, latencyMs, error: outcome.message, ...(until ? { cooldownUntil: new Date(until).toISOString() } : {}) });
    errors.push(key + ": " + (outcome.status ? "HTTP " + outcome.status + " " : "") + outcome.message.slice(0, 140));
    // Some free models reject JSON mode with a 400/422: retry the same model once without it.
    if (!jsonRetryUsed && body.response_format !== undefined && [400, 422].includes(outcome.status) && !until) {
      jsonRetryUsed = true;
      candidates.splice(index + 1, 0, candidates[index]);
      plainRetryAt.add(index + 1);
    }
  }
  waitUntil(writeCalls(records));
  const allRateLimited = records.length > 0 && records.every((record) => record.httpStatus === 429);
  return failure(allRateLimited ? 429 : lastStatus >= 500 || lastStatus === 0 ? 502 : lastStatus, "No free model in the UX Direct gateway returned an answer.", errors);
}
