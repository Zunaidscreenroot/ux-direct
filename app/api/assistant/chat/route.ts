import { NextResponse } from "next/server";
import { buildBrainSystemPrompt, resolveBrainScopes } from "@/src/memory/chat-context";
import { collectFreeModelCandidates, compactRecentMessages, hasAssistantTextDelta, isFreeModelId } from "@/src/providers/openrouter-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Message = { role: "user" | "assistant"; content: string };
type BrainStatus = "complete" | "empty" | "degraded" | "disabled";
type BrainContextInfo = {
  contextText: string;
  status: BrainStatus;
  memoryCount: number;
  knowledgeChunkCount: number;
  durationMs: number;
};

const MAX_MESSAGES = 100;
const MAX_TOTAL_CHARS = 80000;
const MAX_MODEL_ATTEMPTS = 2;
const MODEL_ATTEMPT_TIMEOUT_MS = 8000;
const TOTAL_MODEL_BUDGET_MS = 12000;
const SYSTEM_PROMPT = [
  "You are UX Direct, a thoughtful senior product UX partner.",
  "Focus on evidence-led UX, information architecture, user journeys, interaction design, accessibility, and measurable business hypotheses.",
  "Prioritize Indian BFSI when relevant, especially DMI Finance, DMI Housing Finance, DMI Wealth, and Ujjivan Small Finance Bank.",
  "Be conversational like a helpful design colleague. Answer directly, explain trade-offs, and ask a follow-up only when a missing detail genuinely blocks the work.",
  "Be concise by default. Answer the question first, avoid repeating the prompt, and reserve long structured explanations for requests that need them.",
  "Never invent evidence, claim you inspected a website when you did not, or treat a hypothesis as a measured business outcome.",
  "For UX findings, distinguish observed evidence, interpretation, severity, recommendation, and validation.",
  "Only use retrieved approved shared-brain context when it is relevant. Current user instructions and direct evidence take precedence.",
].join(" ");

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function brainHeaders(brain: BrainContextInfo, model?: string): Headers {
  const headers = new Headers({
    "Cache-Control": "no-cache, no-transform",
    "X-UXD-Brain-Status": brain.status,
    "X-UXD-Brain-Memories": String(brain.memoryCount),
    "X-UXD-Brain-References": String(brain.knowledgeChunkCount),
    "X-UXD-Brain-Latency-Ms": String(Math.max(0, Math.round(brain.durationMs))),
  });
  if (model) headers.set("X-UXD-Model", model);
  return headers;
}

async function retrieveMemory(request: Request, query: string): Promise<BrainContextInfo> {
  const startedAt = Date.now();
  const token = process.env.UX_DIRECT_BRAIN_API_KEY;
  if (!token) {
    return { contextText: "", status: "disabled", memoryCount: 0, knowledgeChunkCount: 0, durationMs: 0 };
  }
  if (!query.trim()) {
    return { contextText: "", status: "empty", memoryCount: 0, knowledgeChunkCount: 0, durationMs: 0 };
  }

  try {
    const endpoint = new URL("/api/brain/retrieve", request.url);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        query: query.slice(0, 3000),
        scopeKeys: resolveBrainScopes(query),
        limit: 3,
        maxChars: 1500,
        includeKnowledge: true,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(1800),
    });
    if (!response.ok) {
      return { contextText: "", status: "degraded", memoryCount: 0, knowledgeChunkCount: 0, durationMs: Date.now() - startedAt };
    }
    const payload = await response.json() as {
      contextText?: unknown;
      retrieval?: { status?: unknown; memoryCount?: unknown; knowledgeChunkCount?: unknown };
    };
    const contextText = typeof payload.contextText === "string" ? payload.contextText.slice(0, 1800) : "";
    const reportedStatus = payload.retrieval?.status;
    const status: BrainStatus = reportedStatus === "complete" || reportedStatus === "empty" || reportedStatus === "degraded"
      ? reportedStatus
      : contextText ? "complete" : "empty";
    return {
      contextText,
      status,
      memoryCount: safeCount(payload.retrieval?.memoryCount),
      knowledgeChunkCount: safeCount(payload.retrieval?.knowledgeChunkCount),
      durationMs: Date.now() - startedAt,
    };
  } catch {
    return { contextText: "", status: "degraded", memoryCount: 0, knowledgeChunkCount: 0, durationMs: Date.now() - startedAt };
  }
}

type ProbedStream = {
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  chunks: Uint8Array[];
  hasText: boolean;
};

async function probeForFirstText(response: Response): Promise<ProbedStream> {
  if (!response.body) return { reader: null, chunks: [], hasText: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  let foundText = false;
  let ended = false;

  while (!foundText && !ended) {
    const result = await reader.read();
    if (result.done) {
      ended = true;
      pending += decoder.decode();
      foundText = pending.trim().length > 0 && hasAssistantTextDelta(pending);
      break;
    }

    chunks.push(result.value);
    const lines = (pending + decoder.decode(result.value, { stream: true })).split(/\r?\n/);
    pending = lines.pop() || "";
    foundText = lines.some(hasAssistantTextDelta);
  }
  return { reader, chunks, hasText: foundText };
}

function forwardProbedStream(probe: ProbedStream, brain: BrainContextInfo, model: string): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const chunk of probe.chunks) controller.enqueue(chunk);
        if (probe.reader) {
          while (true) {
            const result = await probe.reader.read();
            if (result.done) break;
            controller.enqueue(result.value);
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (probe.reader) await probe.reader.cancel(reason).catch(() => {});
    },
  });
  const headers = brainHeaders(brain, model);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("X-Accel-Buffering", "no");
  return new Response(body, { headers });
}

export async function POST(request: Request) {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    return NextResponse.json({ error: "OpenRouter is not configured. Add OPENROUTER_API_KEY to the UX Direct Worker secrets." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }
  const value = body as Record<string, unknown>;
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!model.endsWith(":free") || !isFreeModelId(model)) {
    return NextResponse.json({ error: "UX Direct chat only accepts an explicit OpenRouter model ending in :free. Paid models and automatic routing are blocked." }, { status: 400 });
  }
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > MAX_MESSAGES) {
    return NextResponse.json({ error: "messages must contain between 1 and " + MAX_MESSAGES + " entries." }, { status: 400 });
  }

  const messages: Message[] = [];
  let totalChars = 0;
  for (const item of value.messages) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return NextResponse.json({ error: "Invalid message entry." }, { status: 400 });
    }
    const message = item as Record<string, unknown>;
    if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string" || !message.content.trim() || message.content.length > 20000) {
      return NextResponse.json({ error: "Each message needs a user/assistant role and non-empty text up to 20,000 characters." }, { status: 400 });
    }
    totalChars += message.content.length;
    messages.push({ role: message.role, content: message.content });
  }
  if (totalChars > MAX_TOTAL_CHARS) {
    return NextResponse.json({ error: "Conversation is too long. Start a new chat to continue." }, { status: 413 });
  }

  const promptMessages = compactRecentMessages(messages, { maxMessages: 14, maxTotalChars: 22000, maxMessageChars: 6000 });
  const lastUserMessage = [...promptMessages].reverse().find((message) => message.role === "user")?.content || "";
  const brain = await retrieveMemory(request, lastUserMessage);
  const systemContent = buildBrainSystemPrompt(SYSTEM_PROMPT, brain);
  const endpoint = ((process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, "")) + "/chat/completions";
  const clientFallbacks = Array.isArray(value.fallbackModels)
    ? value.fallbackModels.filter((entry): entry is string => typeof entry === "string" && isFreeModelId(entry)).slice(0, 12)
    : [];
  const configuredModels = [
    clientFallbacks.join(","),
    process.env.UX_DIRECT_CHAT_FALLBACK_MODELS || "",
    process.env.OPENROUTER_MODELS || "",
  ];
  const candidates = collectFreeModelCandidates(model, configuredModels, [], MAX_MODEL_ATTEMPTS);
  let lastError = "No usable response was returned by a free model.";
  let lastStatus = 502;
  const origin = new URL(request.url).origin;
  const modelDeadline = Date.now() + TOTAL_MODEL_BUDGET_MS;

  for (let index = 0; index < candidates.length && index < MAX_MODEL_ATTEMPTS; index += 1) {
    const remainingMs = modelDeadline - Date.now();
    if (remainingMs < 750) break;
    const currentModel = candidates[index];
    const attemptTimeoutMs = Math.min(MODEL_ATTEMPT_TIMEOUT_MS, remainingMs);
    let providerResponse: Response | null = null;
    try {
      providerResponse = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "HTTP-Referer": origin,
          "X-Title": "UX Direct",
        },
        body: JSON.stringify({
          model: currentModel,
          messages: [{ role: "system", content: systemContent }, ...promptMessages],
          stream: true,
          temperature: 0.4,
          max_tokens: 1100,
          provider: { allow_fallbacks: false },
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
    } catch (error) {
      lastStatus = 502;
      lastError = "Free model " + currentModel + " timed out or could not be reached (" +
        (error instanceof Error ? error.name : "request error") + ").";
    }

    if (providerResponse?.ok) {
      try {
        const probe = await probeForFirstText(providerResponse);
        if (probe.hasText) return forwardProbedStream(probe, brain, currentModel);
        if (probe.reader) await probe.reader.cancel().catch(() => {});
        lastStatus = 502;
        lastError = "Free model " + currentModel + " returned an empty text stream.";
      } catch (error) {
        lastStatus = 502;
        lastError = "Free model " + currentModel + " failed while streaming (" +
          (error instanceof Error ? error.name : "stream error") + ").";
      }
    } else if (providerResponse) {
      lastStatus = providerResponse.status;
      const details = (await providerResponse.text().catch(() => "")).replace(/[\r\n]+/g, " ").trim().slice(0, 260);
      lastError = [401, 403].includes(providerResponse.status)
        ? "OpenRouter rejected the configured API key or account access (HTTP " + providerResponse.status + ")."
        : "Free model " + currentModel + " returned HTTP " + providerResponse.status + (details ? ": " + details : ".");
      if ([401, 403].includes(providerResponse.status)) break;
    }

  }

  const userMessage = "No usable response was returned by the available free OpenRouter models. " + lastError;
  return NextResponse.json(
    { error: userMessage, attemptedModels: candidates.slice(0, MAX_MODEL_ATTEMPTS) },
    { status: lastStatus === 429 ? 429 : 502, headers: brainHeaders(brain) },
  );
}
