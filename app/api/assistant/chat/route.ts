import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { buildBrainSystemPrompt, buildRetrievalQuery, resolveBrainScopes } from "@/src/memory/chat-context";
import { retrieveBrainContext, saveBrainFeedback } from "@/src/memory/shared-brain";
import { detectCoachingSignal, detectExplicitTrainingIntent, resolveChatLearningScope, resolveLearningScope } from "@/src/memory/learning-signal";
import { containsSensitiveMaterial, createLearningMarkerTransform, referencesUnstatedClient, type InlineLearningCandidate } from "@/src/memory/inline-learning";
import { recordOperationalEvent } from "@/src/observability/event-log";
import { hasAssistantTextDelta } from "@/src/providers/freellmapi-chat";
import { FREELLMAPI_MODELS, UX_DIRECT_DESIGN_ROLE } from "@/src/providers/freellmapi-models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_FIGMA_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
function originIsAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin || ALLOWED_FIGMA_ORIGINS.has(origin);
}
function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  const allowed = origin && (origin === new URL(request.url).origin || ALLOWED_FIGMA_ORIGINS.has(origin));
  return {
    ...(allowed ? { "Access-Control-Allow-Origin": origin! } : {}),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

type Message = { role: "user" | "assistant"; content: string };
type BrainStatus = "complete" | "empty" | "degraded" | "disabled";
type BrainContextInfo = {
  contextText: string;
  status: BrainStatus;
  memoryCount: number;
  knowledgeChunkCount: number;
  durationMs: number;
  learningStatus?: "none" | "learned" | "skipped_sensitive" | "failed";
  learningRecordId?: string;
  /** @deprecated Retained for older cockpit clients; this now identifies an activated learning record. */
  learningDraftId?: string;
};

const MAX_MESSAGES = 100;
const MAX_TOTAL_CHARS = 80000;
const ROUTER_MODEL = FREELLMAPI_MODELS[0];
const FIRST_TEXT_TIMEOUT_MS = 30_000;
const SYSTEM_PROMPT = [
  UX_DIRECT_DESIGN_ROLE + " You are UX Direct, a thoughtful UI/UX design partner.",
  "Focus on evidence-led UX, information architecture, user journeys, interaction design, accessibility, and measurable business hypotheses.",
  "Prioritize Indian BFSI when relevant, especially DMI Finance, DMI Housing Finance, DMI Wealth, and Ujjivan Small Finance Bank.",
  "Be conversational like a helpful design colleague. Answer directly, explain trade-offs, and ask a follow-up only when a missing detail genuinely blocks the work.",
  "Be concise by default. Answer the question first, avoid repeating the prompt, and reserve long structured explanations for requests that need them.",
  "Never invent evidence, claim you inspected a website when you did not, or treat a hypothesis as a measured business outcome.",
  "For UX findings, distinguish observed evidence, interpretation, severity, recommendation, and validation.",
  "Only use retrieved approved shared-brain context when it is relevant. Current user instructions and direct evidence take precedence.",
  "Private task-learning protocol: if this response contains one durable, reusable UX/product/design-system/accessibility/workflow lesson learned from the user's task, append exactly one final marker after the answer: <UXD_LEARNING>{JSON}</UXD_LEARNING>. JSON fields: title, normalizedRule, rationale, scopeKey, feedbackKind, keywords, originalLanguage. Omit the marker for greetings, simple facts, transient requests, speculative conclusions, or tasks with no reusable lesson. Keep normalizedRule concise and generalizable. Prefer narrow project/client scope; use indian-bfsi only for reusable Indian financial-services patterns, project:ux-direct for Figma/plugin/tooling, project:ux-audit for audit workflow, project:general-ux for general task patterns, and UX_SHARED_BRAIN only for genuinely cross-product rules. Never include raw prompts, screenshot or canvas text, personal identifiers, financial/health details, secrets, or confidential client facts. The private marker is removed before the answer reaches the user; never explain it in normal prose.",
].join(" ");

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function brainHeaders(brain: BrainContextInfo, model?: string, request?: Request): Headers {
  const headers = new Headers({
    "Cache-Control": "no-cache, no-transform",
    "X-UXD-Brain-Status": brain.status,
    "X-UXD-Brain-Memories": String(brain.memoryCount),
    "X-UXD-Brain-References": String(brain.knowledgeChunkCount),
    "X-UXD-Brain-Latency-Ms": String(Math.max(0, Math.round(brain.durationMs))),
    "X-UXD-Learning-Status": brain.learningStatus || "none",
  });
  if (brain.learningRecordId) {
    headers.set("X-UXD-Learning-Record-Id", brain.learningRecordId);
    // Backwards-compatible header for older plugin/cockpit builds.
    headers.set("X-UXD-Learning-Draft-Id", brain.learningRecordId);
  }
  if (model) headers.set("X-UXD-Model", model);
  if (request) {
    new Headers(corsHeaders(request)).forEach((value, key) => headers.set(key, value));
  }
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
  status: "none" | "learned" | "skipped_sensitive" | "failed";
  recordId?: string;
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

async function captureChatLearning(text: string, taskContext = "", sourceProduct: "ux-direct" | "figma-plugin" = "ux-direct"): Promise<ChatLearningCapture> {
  const value = text.trim();
  if (value.length < 12 || (!detectCoachingSignal(value) && !detectExplicitTrainingIntent(value))) return { status: "none" };
  // Never persist likely secrets or personal/financial identifiers as training material.
  if (containsSensitiveMaterial(value)) {
    return { status: "skipped_sensitive" };
  }
  const captured = value.slice(0, 2250);
  try {
    const saved = await saveBrainFeedback({
      rawFeedback: captured,
      summary: captured.slice(0, 500),
      title: learningTitle(captured),
      normalizedRule: "Reusable guidance extracted from an owner correction (original wording preserved): " + captured,
      rationale: "Captured from an explicit chat coaching/correction signal and activated automatically after relevance and project-scope checks.",
      scopeKey: resolveChatLearningScope(captured + "\nConversation task context: " + taskContext.slice(0, 1800)),
      feedbackKind: learningKind(captured),
      keywords: learningKeywords(captured),
      originalLanguage: /[\u0900-\u097f]/.test(captured) ? "Hindi" : /\b(yaad|aage se|galat|galti|karo|karna|hoga|chahiye|mein|hai)\b/i.test(captured) ? "Hinglish" : "English",
      sourceProduct,
      idempotencyKey: "uxd-chat-learning-" + createHash("sha256").update(sourceProduct + "|" + captured).digest("hex"),
      metadata: { capturedFrom: sourceProduct + "-chat", captureVersion: 3, requiresOwnerApproval: false, automaticActivation: true, inferenceCalls: 0 },
    });
    return { status: saved.activated === true ? "learned" : "none", recordId: saved.id };
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

async function persistInlineTaskLearning(
  candidate: InlineLearningCandidate,
  context: string,
  sourceProduct: "ux-direct" | "figma-plugin",
): Promise<void> {
  try {
    // Explicit coaching already has its own capture path; avoid writing a duplicate.
    if (detectCoachingSignal(context) || detectExplicitTrainingIntent(context)) return;
    if (referencesUnstatedClient(candidate, context)) {
      recordOperationalEvent({
        source: sourceProduct === "figma-plugin" ? "figma-plugin" : "dashboard",
        event: "Inline task learning filtered",
        status: "info",
        summary: "A task-derived candidate named a client not present in the task context; nothing was stored.",
        category: "Shared Brain",
      });
      return;
    }
    const scopeKey = resolveLearningScope(candidate.scopeKey, "general", context);
    const rule = candidate.normalizedRule.trim();
    const idempotencyKey = "uxd-inline-task-learning-" + createHash("sha256")
      .update([sourceProduct, scopeKey, rule.toLowerCase()].join("|"))
      .digest("hex");
    const saved = await saveBrainFeedback({
      rawFeedback: "Task-derived reusable lesson: " + rule,
      summary: rule.slice(0, 500),
      title: candidate.title,
      normalizedRule: rule,
      rationale: "Extracted from a UX Direct task response. The raw conversation and canvas material are not persisted in shared memory.",
      scopeKey,
      feedbackKind: candidate.feedbackKind,
      keywords: candidate.keywords,
      examples: [],
      originalLanguage: candidate.originalLanguage,
      sourceProduct,
      idempotencyKey,
      metadata: {
        captureMode: "automatic-inline-task-learning",
        rawTaskBriefPersisted: false,
        rawCanvasContentPersisted: false,
        requiresOwnerApproval: false,
        automaticActivation: true,
      },
    });
    recordOperationalEvent({
      source: sourceProduct === "figma-plugin" ? "figma-plugin" : "dashboard",
      event: "Inline task learning evaluated",
      status: saved.activated === true ? "success" : "info",
      summary: saved.activated === true
        ? "A compact task-derived lesson passed shared-brain relevance and scope checks."
        : "A matching task-derived lesson remains inactive because it was previously archived or rejected.",
      category: "Shared Brain",
    });
  } catch (error) {
    const filtered = error instanceof Error && /below the 50% ingestion threshold/i.test(error.message);
    recordOperationalEvent({
      source: sourceProduct === "figma-plugin" ? "figma-plugin" : "dashboard",
      event: filtered ? "Inline task learning filtered" : "Inline task learning capture failed",
      status: filtered ? "info" : "warning",
      summary: filtered
        ? "The compact task-derived candidate did not meet the relevance threshold; nothing was stored."
        : "Optional task-derived learning could not be stored; the chat response was still completed.",
      category: "Shared Brain",
    });
  }
}

function forwardProbedStream(
  probe: ProbedStream,
  brain: BrainContextInfo,
  model: string,
  request: Request,
  learningContext: string,
): Response {
  let streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const candidates: InlineLearningCandidate[] = [];
  const source = new ReadableStream<Uint8Array>({
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
  const filtered = source.pipeThrough(createLearningMarkerTransform((candidate) => {
    if (candidates.length === 0) candidates.push(candidate);
  }));
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      streamReader = filtered.getReader();
      try {
        while (true) {
          const result = await streamReader.read();
          if (result.done) break;
          controller.enqueue(result.value);
        }
        if (candidates[0]) {
          const origin = request.headers.get("origin");
          const sourceProduct = origin && ALLOWED_FIGMA_ORIGINS.has(origin) ? "figma-plugin" : "ux-direct";
          await persistInlineTaskLearning(candidates[0], learningContext, sourceProduct);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        streamReader = null;
      }
    },
    async cancel(reason) {
      if (streamReader) await streamReader.cancel(reason).catch(() => {});
      else if (probe.reader) await probe.reader.cancel(reason).catch(() => {});
    },
  });
  const headers = brainHeaders(brain, model, request);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("X-Accel-Buffering", "no");
  return new Response(body, { headers });
}
export async function OPTIONS(request: Request) {
  if (!originIsAllowed(request)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: corsHeaders(request) });
  }
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: Request) {
  const responseHeaders = corsHeaders(request);
  if (!originIsAllowed(request)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: responseHeaders });
  }
  const key = process.env.FREELLMAPI_API_KEY?.trim();
  const baseUrl = process.env.FREELLMAPI_BASE_URL?.trim().replace(/\/+$/, "");
  if (!key || !baseUrl) {
    return NextResponse.json({ error: "Configure FREELLMAPI_BASE_URL and FREELLMAPI_API_KEY on the UX Direct Worker." }, { status: 503, headers: responseHeaders });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400, headers: responseHeaders });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400, headers: responseHeaders });
  }
  const value = body as Record<string, unknown>;
  // Let FreeLLMAPI choose the model dynamically; never pin a stale provider/model ID from the browser.
  const model = ROUTER_MODEL;
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > MAX_MESSAGES) {
    return NextResponse.json({ error: "messages must contain between 1 and " + MAX_MESSAGES + " entries." }, { status: 400, headers: responseHeaders });
  }

  const messages: Message[] = [];
  let totalChars = 0;
  for (const item of value.messages) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return NextResponse.json({ error: "Invalid message entry." }, { status: 400, headers: responseHeaders });
    }
    const message = item as Record<string, unknown>;
    if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string" || !message.content.trim() || message.content.length > 20000) {
      return NextResponse.json({ error: "Each message needs a user/assistant role and non-empty text up to 20,000 characters." }, { status: 400, headers: responseHeaders });
    }
    totalChars += message.content.length;
    messages.push({ role: message.role, content: message.content });
  }
  if (totalChars > MAX_TOTAL_CHARS) {
    return NextResponse.json({ error: "Conversation is too long. Start a new chat to continue." }, { status: 413, headers: responseHeaders });
  }

  // Conversational chat has no app-imposed output-token ceiling or history compaction.
  const promptMessages = messages;
  const userTurns = promptMessages.filter((message) => message.role === "user");
  const lastUserMessage = userTurns[userTurns.length - 1]?.content || "";
  const previousUserMessage = userTurns[userTurns.length - 2]?.content || "";
  const retrievalQuery = buildRetrievalQuery(lastUserMessage, previousUserMessage);
  const chatOrigin = request.headers.get("origin");
  const chatSourceProduct = chatOrigin && ALLOWED_FIGMA_ORIGINS.has(chatOrigin) ? "figma-plugin" : "ux-direct";
  const [brainBase, learning] = await Promise.all([
    retrieveMemory(request, retrievalQuery),
    captureChatLearning(lastUserMessage, previousUserMessage, chatSourceProduct),
  ]);
  const brain: BrainContextInfo = {
    ...brainBase,
    learningStatus: learning.status,
    ...(learning.recordId ? { learningRecordId: learning.recordId, learningDraftId: learning.recordId } : {}),
  };
  const systemContent = buildBrainSystemPrompt(SYSTEM_PROMPT, brain);
  const endpoint = baseUrl + "/chat/completions";
  const candidates = [ROUTER_MODEL];
  const failures: string[] = [];
  let lastStatus = 502;
  const origin = new URL(request.url).origin;

  const startAttempt = (currentModel: string, startupTimeoutMs = FIRST_TEXT_TIMEOUT_MS) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), startupTimeoutMs);
    const promise = (async (): Promise<{ model: string; probe: ProbedStream; controller: AbortController }> => {
      try {
        const providerResponse = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            model: currentModel,
            messages: [{ role: "system", content: systemContent }, ...promptMessages],
            stream: true,
            temperature: 0.4,
            max_tokens: 25000,

            stream_options: { include_usage: true },
          }),
          cache: "no-store",
          signal: controller.signal,
        });
        if (!providerResponse.ok) {
          const details = (await providerResponse.text().catch(() => "")).replace(/[\r\n]+/g, " ").trim().slice(0, 260);
          const status = providerResponse.status;
          const message = [401, 403].includes(status)
            ? "FreeLLMAPI rejected the configured API key or account access (HTTP " + status + ")."
            : "Model " + currentModel + " via FreeLLMAPI returned HTTP " + status + (details ? ": " + details : ".");
          throw Object.assign(new Error(message), { status });
        }
        const probe = await probeForFirstText(providerResponse);
        if (!probe.hasText) {
          if (probe.reader) await probe.reader.cancel().catch(() => {});
          throw Object.assign(new Error("Model " + currentModel + " via FreeLLMAPI returned an empty text stream before its first token."), { status: 502 });
        }
        // Stop the startup timer once the first visible text arrives; let the full answer stream without an app-imposed timeout.
        clearTimeout(timer);
        return { model: currentModel, probe, controller };
      } catch (error) {
        if (controller.signal.aborted) {
          throw Object.assign(new Error("Model " + currentModel + " via FreeLLMAPI did not start producing text within " + FIRST_TEXT_TIMEOUT_MS + "ms."), { status: 504 });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
    return { controller, promise };
  };

  const attempts: Array<ReturnType<typeof startAttempt>> = [];
  let winner: { model: string; probe: ProbedStream; controller: AbortController } | null = null;

  // One server-selected FreeLLMAPI Auto route only; never retry on a named model.
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex];
    const attempt = startAttempt(candidate, candidateIndex === 0 ? FIRST_TEXT_TIMEOUT_MS : 16000);
    attempts.push(attempt);
    try {
      winner = await attempt.promise;
      break;
    } catch (error) {
      attempt.controller.abort();
      const detail = error instanceof Error ? error.message : "The model failed before producing text.";
      failures.push(candidate + ": " + detail);
      lastStatus = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status: unknown }).status)
        : 502;
    }
  }

  if (winner) {
    for (const attempt of attempts) {
      if (attempt.controller !== winner.controller) attempt.controller.abort();
    }
    return forwardProbedStream(winner.probe, brain, winner.model, request, lastUserMessage + "\n" + previousUserMessage);
  }

  for (const attempt of attempts) attempt.controller.abort();
  const userMessage = "FreeLLMAPI Auto failed to start a usable response. " + failures.join(" | ");
  return NextResponse.json(
    { error: userMessage, attemptedModels: candidates },
    { status: lastStatus === 429 ? 429 : 502, headers: brainHeaders(brain, undefined, request) },
  );
}
