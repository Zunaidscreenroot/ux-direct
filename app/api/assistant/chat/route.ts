import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { buildBrainSystemPrompt, buildRetrievalQuery, resolveBrainScopes } from "@/src/memory/chat-context";
import { retrieveBrainContext, saveBrainFeedback } from "@/src/memory/shared-brain";
import { detectCoachingSignal, detectExplicitTrainingIntent, resolveChatLearningScope } from "@/src/memory/learning-signal";
import { collectFreeModelCandidates, hasAssistantTextDelta, isFreeModelId } from "@/src/providers/openrouter-chat";

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
  learningStatus?: "none" | "draft_saved" | "skipped_sensitive" | "failed";
  learningDraftId?: string;
};

const MAX_MESSAGES = 100;
const MAX_TOTAL_CHARS = 80000;
const MAX_MODEL_ATTEMPTS = 2;
const FIRST_TEXT_TIMEOUT_MS = 5500;
const FALLBACK_HEDGE_DELAY_MS = 900;
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
    "X-UXD-Learning-Status": brain.learningStatus || "none",
  });
  if (brain.learningDraftId) headers.set("X-UXD-Learning-Draft-Id", brain.learningDraftId);
  if (model) headers.set("X-UXD-Model", model);
  return headers;
}

async function retrieveMemory(_request: Request, query: string): Promise<BrainContextInfo> {
  const startedAt = Date.now();
  if (!query.trim()) {
    return { contextText: "", status: "empty", memoryCount: 0, knowledgeChunkCount: 0, durationMs: 0 };
  }

  try {
    // Same-Worker direct retrieval avoids an extra HTTP hop to our own brain API.
    const context = await retrieveBrainContext({
      query: query.slice(0, 3000),
      scopeKeys: resolveBrainScopes(query),
      limit: 3,
      maxChars: 1800,
      includeKnowledge: true,
    });
    return {
      contextText: context.contextText.slice(0, 5200),
      status: context.retrieval.status,
      memoryCount: safeCount(context.retrieval.memoryCount),
      knowledgeChunkCount: safeCount(context.retrieval.knowledgeChunkCount),
      durationMs: Date.now() - startedAt,
    };
  } catch {
    return { contextText: "", status: "degraded", memoryCount: 0, knowledgeChunkCount: 0, durationMs: Date.now() - startedAt };
  }
}

type ChatLearningCapture = {
  status: "none" | "draft_saved" | "skipped_sensitive" | "failed";
  draftId?: string;
};

function learningKind(text: string): "cost_optimization" | "duplicate_finding" | "severity_calibration" | "accessibility" | "design_system" | "general" {
  if (/\b(cost|token|budget|slow|faster|latency|model|inference|spend)\b/i.test(text)) return "cost_optimization";
  if (/\b(duplicate|repeated|repeat|same finding|overlap)\b/i.test(text)) return "duplicate_finding";
  if (/\b(severity|critical|major|minor|high priority|low priority)\b/i.test(text)) return "severity_calibration";
  if (/\b(accessibility|keyboard|contrast|screen reader|wcag|accessible)\b/i.test(text)) return "accessibility";
  if (/\b(design system|component|design token|consisten)\b/i.test(text)) return "design_system";
  return "general";
}

function learningTitle(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  const firstSentence = cleaned.split(/[.!?\n]/)[0]?.trim() || cleaned;
  return ("Chat learning · " + firstSentence).slice(0, 180);
}

function learningKeywords(text: string): string[] {
  const stop = new Set(["remember","please","should","could","would","from","this","that","with","your","into","when","then","aage","se","mein","me","hai","hoga","karna","karo","chat","brain","train","relevant","lagega"]);
  return [...new Set((text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []).filter((word) => !stop.has(word)))].slice(0, 16);
}

async function captureChatLearning(text: string): Promise<ChatLearningCapture> {
  const value = text.trim();
  if (value.length < 12 || (!detectCoachingSignal(value) && !detectExplicitTrainingIntent(value))) return { status: "none" };
  // Never persist likely credentials/secrets as training material.
  if (/\b(api[_ -]?key|password\s*[:=]|secret\s*[:=]|private key|recovery phrase|bearer\s+[A-Za-z0-9._-]{20,})\b/i.test(value)) {
    return { status: "skipped_sensitive" };
  }
  const captured = value.slice(0, 2400);
  try {
    const saved = await saveBrainFeedback({
      rawFeedback: captured,
      summary: captured.slice(0, 500),
      title: learningTitle(captured),
      normalizedRule: "Owner-provided reusable guidance to review (original wording preserved): " + captured,
      rationale: "Captured from an explicit chat coaching/correction signal. This remains a draft and must be approved before it affects shared-brain retrieval.",
      scopeKey: resolveChatLearningScope(captured),
      feedbackKind: learningKind(captured),
      keywords: learningKeywords(captured),
      originalLanguage: /[\u0900-\u097f]/.test(captured) ? "Hindi" : /\b(yaad|aage se|galat|galti|karo|karna|hoga|chahiye|mein|hai)\b/i.test(captured) ? "Hinglish" : "English",
      sourceProduct: "ux-direct",
      idempotencyKey: "uxd-chat-learning-" + createHash("sha256").update(captured).digest("hex"),
      metadata: { capturedFrom: "ux-direct-chat", captureVersion: 1, requiresOwnerApproval: true, inferenceCalls: 0 },
    });
    return { status: "draft_saved", draftId: saved.id };
  } catch {
    return { status: "failed" };
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

  // Conversational chat has no app-imposed output-token ceiling or history compaction.
  const promptMessages = messages;
  const userTurns = promptMessages.filter((message) => message.role === "user");
  const lastUserMessage = userTurns[userTurns.length - 1]?.content || "";
  const previousUserMessage = userTurns[userTurns.length - 2]?.content || "";
  const retrievalQuery = buildRetrievalQuery(lastUserMessage, previousUserMessage);
  const [brainBase, learning] = await Promise.all([
    retrieveMemory(request, retrievalQuery),
    captureChatLearning(lastUserMessage),
  ]);
  const brain: BrainContextInfo = { ...brainBase, learningStatus: learning.status, ...(learning.draftId ? { learningDraftId: learning.draftId } : {}) };
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
  let lastError = "No usable response was returned by the available free OpenRouter models.";
  let lastStatus = 502;
  const origin = new URL(request.url).origin;

  const startAttempt = (currentModel: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FIRST_TEXT_TIMEOUT_MS);
    const promise = (async (): Promise<{ model: string; probe: ProbedStream; controller: AbortController }> => {
      try {
        const providerResponse = await fetch(endpoint, {
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
            provider: { allow_fallbacks: false },
          }),
          cache: "no-store",
          signal: controller.signal,
        });
        if (!providerResponse.ok) {
          const details = (await providerResponse.text().catch(() => "")).replace(/[\r\n]+/g, " ").trim().slice(0, 260);
          const status = providerResponse.status;
          const message = [401, 403].includes(status)
            ? "OpenRouter rejected the configured API key or account access (HTTP " + status + ")."
            : "Free model " + currentModel + " returned HTTP " + status + (details ? ": " + details : ".");
          throw Object.assign(new Error(message), { status });
        }
        const probe = await probeForFirstText(providerResponse);
        if (!probe.hasText) {
          if (probe.reader) await probe.reader.cancel().catch(() => {});
          throw Object.assign(new Error("Free model " + currentModel + " returned an empty text stream before its first token."), { status: 502 });
        }
        // Stop the startup timer once the first visible text arrives; let the full answer stream without an app-imposed timeout.
        clearTimeout(timer);
        return { model: currentModel, probe, controller };
      } catch (error) {
        if (controller.signal.aborted) {
          throw Object.assign(new Error("Free model " + currentModel + " did not start producing text within " + FIRST_TEXT_TIMEOUT_MS + "ms."), { status: 504 });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
    return { controller, promise };
  };

  const firstAttempt = startAttempt(candidates[0]);
  let winner: { model: string; probe: ProbedStream; controller: AbortController } | null = null;
  const firstOutcome = firstAttempt.promise.then(
    (value) => ({ kind: "ready" as const, value }),
    (error) => ({ kind: "failed" as const, error }),
  );
  const early = await Promise.race([
    firstOutcome,
    new Promise<{ kind: "hedge" }>((resolve) => setTimeout(() => resolve({ kind: "hedge" }), FALLBACK_HEDGE_DELAY_MS)),
  ]);
  const attempts = [firstAttempt];

  if (early.kind === "ready") {
    winner = early.value;
  } else if (candidates.length > 1) {
    // Hedge with a second free model if the primary has not produced visible text quickly.
    const secondAttempt = startAttempt(candidates[1]);
    attempts.push(secondAttempt);
    try {
      winner = await Promise.any(attempts.map((attempt) => attempt.promise));
    } catch (error) {
      const errors = error instanceof AggregateError ? error.errors : [error];
      lastError = errors.map((item) => item instanceof Error ? item.message : "Free model attempt failed.").join(" | ").slice(0, 800);
      const statuses = errors.map((item) => typeof item === "object" && item !== null && "status" in item ? Number((item as { status: unknown }).status) : 502);
      lastStatus = statuses[statuses.length - 1] || 502;
    }
  } else if (early.kind === "failed") {
    lastError = early.error instanceof Error ? early.error.message : "Free model failed before producing text.";
    lastStatus = typeof early.error === "object" && early.error !== null && "status" in early.error ? Number((early.error as { status: unknown }).status) : 502;
  } else {
    try {
      winner = await firstAttempt.promise;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Free model failed before producing text.";
      lastStatus = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : 502;
    }
  }

  if (winner) {
    for (const attempt of attempts) {
      if (attempt.controller !== winner.controller) attempt.controller.abort();
    }
    return forwardProbedStream(winner.probe, brain, winner.model);
  }

  for (const attempt of attempts) attempt.controller.abort();
  const userMessage = "No usable response was returned by the available free OpenRouter models. " + lastError;
  return NextResponse.json(
    { error: userMessage, attemptedModels: candidates.slice(0, MAX_MODEL_ATTEMPTS) },
    { status: lastStatus === 429 ? 429 : 502, headers: brainHeaders(brain) },
  );
}
