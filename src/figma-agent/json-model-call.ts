import { providerFetch } from "@/src/providers/provider-fetch";
import { FIGMA_AGENT_MODELS, UX_DIRECT_DESIGN_ROLE } from "@/src/providers/openrouter-models";
import { getResolvedActiveChatProvider } from "@/src/providers/runtime-chat-provider";
import { figmaAttemptTimeoutMs, figmaModelChain, figmaRoutingHeaders, routedVia, shouldRetryWithoutJsonMode, type AgentRole } from "@/src/providers/active-chat-provider";
import { extractJsonObject } from "@/src/figma-agent/extract-json-object";

export type JsonModelContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export type JsonModelResult =
  | { ok: true; data: Record<string, unknown>; raw: string; model: string; routedVia?: string }
  | { ok: false; status: number; error: string; errors: string[] };

/**
 * One JSON-mode completion on the active provider (FreeLLMAPI `auto` in production),
 * walking the configured Figma model chain. `accept` rejects a decoded object so the
 * next model is tried; it is how each quick task enforces its own schema.
 */
export async function callFigmaJsonModel(options: {
  system: string;
  user: JsonModelContent;
  hasVisionInput: boolean;
  maxTokens: number;
  temperature?: number;
  title: string;
  origin: string;
  /** Per-attempt timeout override (sub-agents use a short one so they never hold up the planner). */
  timeoutMs?: number;
  /** Accept any JSON object, not only ones with the usual review/plan keys (sub-agents use their own keys). */
  anyObject?: boolean;
  /** Aborts every attempt (sub-agents share one hard deadline). */
  signal?: AbortSignal;
  /** Stop after this many attempts (sub-agents make one call each). */
  maxAttempts?: number;
  /** Small, latency-sensitive call: FreeLLMAPI routes it as a chat task (agency designers). */
  fast?: boolean;
  /** Agent role for the own gateway's model choice (planner, section-designer, critic …). */
  role?: AgentRole;
  accept: (data: Record<string, unknown>, raw: string) => string | null;
}): Promise<JsonModelResult> {
  const provider = await getResolvedActiveChatProvider();
  if (!provider.configured || !provider.apiKey) {
    return { ok: false, status: 503, error: provider.configurationError || provider.label + " is not configured.", errors: [] };
  }
  const endpoint = provider.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const models = figmaModelChain(provider, options.hasVisionInput, FIGMA_AGENT_MODELS.map((entry) => entry.id));
  const attempts = models.map((model) => ({ model, jsonMode: true }));
  const errors: string[] = [];
  const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
  for (let index = 0; index < attempts.length && index < maxAttempts; index++) {
    if (options.signal?.aborted) {
      errors.push("stopped: shared deadline reached");
      break;
    }
    const { model, jsonMode } = attempts[index];
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? figmaAttemptTimeoutMs(provider, index, 60000, 45000));
    try {
      const response = await providerFetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + provider.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...figmaRoutingHeaders(provider, { fast: options.fast, role: options.role }),
          ...(provider.id === "openrouter" ? { "HTTP-Referer": options.origin, "X-OpenRouter-Title": options.title } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: UX_DIRECT_DESIGN_ROLE + "\n" + options.system },
            { role: "user", content: options.user },
          ],
          ...(provider.id === "openrouter" && model === "openrouter/auto" ? { plugins: [{ id: "auto-router", cost_tier: "low" }] } : {}),
          temperature: options.temperature ?? 0.3,
          ...(model.startsWith("qwen/") ? { reasoning: { effort: "low" } } : {}),
          max_tokens: options.maxTokens,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
        cache: "no-store",
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch((readError: unknown) => {
        if (controller.signal.aborted) throw readError;
        return null;
      });
      const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
      if (!response.ok) {
        const providerError = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
        errors.push(model + (jsonMode ? "" : " (no JSON mode)") + ": " + String(providerError.message || "HTTP " + response.status).slice(0, 180));
        if (jsonMode && shouldRetryWithoutJsonMode(provider, response.status)) attempts.splice(index + 1, 0, { model, jsonMode: false });
        continue;
      }
      const choices = Array.isArray(record.choices) ? record.choices : [];
      const choice = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : {};
      const message = choice.message && typeof choice.message === "object" ? choice.message as Record<string, unknown> : {};
      const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      const decoded = extractJsonObject(message.content) ?? extractJsonObject(message.parsed) ?? extractJsonObject(message.tool_calls)
        ?? (options.anyObject ? parseAnyObject(raw) : null)
        ?? (/^\s*(```(json)?\s*)?\[/i.test(raw) ? {} : null);
      if (!decoded) {
        errors.push(model + ": response contained no JSON object.");
        continue;
      }
      const rejection = options.accept(decoded, raw);
      if (rejection) {
        errors.push(model + ": " + rejection.slice(0, 200));
        continue;
      }
      return { ok: true, data: decoded, raw, model: (typeof record.model === "string" && record.model) || model, routedVia: routedVia(response) };
    } catch (error) {
      errors.push(model + ": " + (controller.signal.aborted ? "timed out" : String(error instanceof Error ? error.message : error).slice(0, 160)));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromParent);
    }
  }
  return { ok: false, status: 502, error: "No free model returned a usable answer.", errors };
}

function parseAnyObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim().replace(/^\uFEFF/, "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
