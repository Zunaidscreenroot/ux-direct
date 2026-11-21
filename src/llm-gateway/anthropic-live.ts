import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic as the primary provider for A11y Studio's Live audit (Zunaid, 2026-11-21).
 *
 * Three seats, each pinned to ONE model so two runs of the same audit read alike. The free
 * gateway (src/llm-gateway, seats of the same name in roles.ts) is the fixed fallback.
 *
 *   live-vision  page screenshot(s) + prompt → JSON findings   claude-haiku-5-5, effort low
 *   live-review  text only, the reasoning step over a module   claude-sonnet-5-5, effort medium
 *   live-text    the vision prompt without images              claude-haiku-5-5, effort low
 *
 * Cost rules: Opus, Fable and Mythos are never used (refused even if set through env). The system
 * prompt is marked for prompt caching, since it is identical across the calls of one run.
 *
 * Errors carry a code the caller acts on: "used_up" (no credit / key refused: switch path) or
 * "busy" (rate limit, overloaded, timeout: retry).
 */

export type LiveSeat = "live-vision" | "live-review" | "live-text";
export const LIVE_SEATS: readonly LiveSeat[] = ["live-vision", "live-review", "live-text"];

type Effort = "low" | "medium" | "high";
type SeatConfig = { model: string; effort: Effort; envModel: string };

const SEAT_CONFIG: Record<LiveSeat, SeatConfig> = {
  "live-vision": { model: "claude-haiku-5-5", effort: "low", envModel: "UXD_LIVE_VISION_MODEL" },
  "live-review": { model: "claude-sonnet-5-5", effort: "medium", envModel: "UXD_LIVE_REVIEW_MODEL" },
  "live-text": { model: "claude-haiku-5-5", effort: "low", envModel: "UXD_LIVE_TEXT_MODEL" },
};

/** Only Haiku and Sonnet are allowed: the expensive lines are refused outright. */
export function allowedLiveModel(model: string): boolean {
  return /^claude-(haiku|sonnet)-/i.test(model) && !/opus|fable|mythos/i.test(model);
}

export function isLiveSeat(seat: string): seat is LiveSeat {
  return (LIVE_SEATS as readonly string[]).includes(seat);
}

export function liveModelFor(seat: LiveSeat, env: Record<string, string | undefined>): string {
  const override = String(env[SEAT_CONFIG[seat].envModel] || "").trim();
  return override && allowedLiveModel(override) ? override : SEAT_CONFIG[seat].model;
}

export type LiveErrorCode = "used_up" | "busy" | "no_key" | "refused" | "bad_request";
export class LiveError extends Error {
  constructor(public code: LiveErrorCode, message: string, public status = 502) { super(message); }
}

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type OpenAIMessage = { role: string; content: string | Part[] };

/** OpenAI-shaped messages → Anthropic system blocks + messages. Images must already be data URLs. */
export function toAnthropic(messages: OpenAIMessage[]): { system: Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[] } {
  const systemText: string[] = [];
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") { systemText.push(typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n")); continue; }
    const role = m.role === "assistant" ? "assistant" : "user";
    let content: string | Anthropic.ContentBlockParam[];
    if (typeof m.content === "string") content = m.content;
    else content = m.content.map((p): Anthropic.ContentBlockParam => {
      if (p.type === "text") return { type: "text", text: p.text };
      const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]*)$/i.exec(p.image_url.url);
      if (!match) throw new LiveError("bad_request", "An image must be a data URL.", 400);
      const media = (match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase()) as "image/png" | "image/jpeg" | "image/webp";
      return { type: "image", source: { type: "base64", media_type: media, data: match[2] } };
    });
    // Anthropic wants alternating turns: merge two user turns in a row.
    const last = out[out.length - 1];
    if (last && last.role === role) {
      const a = typeof last.content === "string" ? [{ type: "text", text: last.content } as Anthropic.TextBlockParam] : last.content;
      const b = typeof content === "string" ? [{ type: "text", text: content } as Anthropic.TextBlockParam] : content;
      last.content = [...a, ...b];
    } else out.push({ role, content });
  }
  const system: Anthropic.TextBlockParam[] = systemText.length
    ? [{ type: "text", text: systemText.join("\n\n"), cache_control: { type: "ephemeral" } }]
    : [];
  return { system, messages: out };
}

/** Classify an SDK error into what the caller should do next. */
export function classify(error: unknown): LiveError {
  if (error instanceof LiveError) return error;
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError)
    return new LiveError("used_up", "Anthropic refused the key.", 503);
  if (error instanceof Anthropic.RateLimitError) return new LiveError("busy", "Anthropic rate limit; retry shortly.", 429);
  if (error instanceof Anthropic.BadRequestError) {
    // A spent balance comes back as a 400 whose message names the credit balance.
    const message = String(error.message || "") + " " + JSON.stringify((error as { error?: unknown }).error ?? "");
    if (/credit balance|billing|spend limit/i.test(message)) return new LiveError("used_up", "Anthropic credit is used up.", 402);
    return new LiveError("bad_request", "Anthropic rejected the request: " + message.slice(0, 200), 400);
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new LiveError("busy", "Anthropic timed out; retry.", 504);
  if (error instanceof Anthropic.APIError) {
    const status = Number(error.status) || 0;
    if (status === 402) return new LiveError("used_up", "Anthropic credit is used up.", 402);
    if (status === 529 || status >= 500 || status === 0) return new LiveError("busy", "Anthropic is overloaded; retry.", 503);
    return new LiveError("bad_request", "Anthropic error " + status, status || 502);
  }
  return new LiveError("busy", "Anthropic could not be reached.", 503);
}

export type LiveResult = { model: string; text: string; stop: string; usage: Record<string, unknown> };

export async function anthropicLiveCompletion(opts: {
  seat: LiveSeat; messages: OpenAIMessage[]; maxTokens: number; env: Record<string, string | undefined>;
  signal?: AbortSignal | null; client?: Anthropic;
}): Promise<LiveResult> {
  const key = String(opts.env.ANTHROPIC_API_KEY || "").trim();
  if (!opts.client && !key) throw new LiveError("no_key", "Anthropic is not configured on UX Direct.", 503);
  if (opts.env.UXD_LIVE_ANTHROPIC === "off") throw new LiveError("no_key", "Anthropic is switched off for Live audit.", 503);
  const client = opts.client ?? new Anthropic({ apiKey: key, maxRetries: 1, timeout: 90_000 });
  const model = liveModelFor(opts.seat, opts.env);
  const { system, messages } = toAnthropic(opts.messages);
  if (!messages.length) throw new LiveError("bad_request", "No user message.", 400);
  // Thinking tokens come out of max_tokens; give room so the JSON is never cut off. Only used
  // tokens are billed, so the higher ceiling costs nothing unless it is needed.
  const maxTokens = Math.max(opts.maxTokens, opts.seat === "live-review" ? 12_000 : 6_000);
  try {
    const response = await client.messages.create({
      model, max_tokens: maxTokens,
      ...(system.length ? { system } : {}),
      messages,
      output_config: { effort: SEAT_CONFIG[opts.seat].effort },
    }, { signal: opts.signal ?? undefined });
    if (response.stop_reason === "refusal") throw new LiveError("refused", "Anthropic declined this request.", 502);
    // Callers parse JSON: drop a ```json fence if the model wrapped its answer in one.
    const text = response.content.map((block) => (block.type === "text" ? block.text : "")).join("").trim()
      .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    if (!text) throw new LiveError("busy", "Anthropic returned an empty answer.", 502);
    return { model: response.model, text, stop: String(response.stop_reason || "end_turn"), usage: response.usage as unknown as Record<string, unknown> };
  } catch (error) {
    throw classify(error);
  }
}

/** The response shape A11y Studio already reads: {model, choices:[{message:{content}}]}. */
export function openAIShape(result: LiveResult, provider = "anthropic") {
  return {
    id: "live-" + Date.now().toString(36), object: "chat.completion", model: result.model, provider,
    choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: result.stop === "max_tokens" ? "length" : "stop" }],
    usage: result.usage,
  };
}
