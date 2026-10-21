import { NextResponse } from "next/server";
import { z } from "zod";
import { retrieveBrainContext } from "@/src/memory/shared-brain";
import { resolveBrainScopes } from "@/src/memory/chat-context";
import { captureVerifiedTaskLesson, resolveFigmaTaskProject } from "@/src/memory/task-learning";
import { finishTaskRun } from "@/src/memory/task-run-log";
import { neonRequest } from "@/src/memory/neon-rest";
import { sanitizeInlineLearningCandidate } from "@/src/memory/inline-learning";
import { FIGMA_AGENT_MODELS, UX_DIRECT_DESIGN_ROLE } from "@/src/providers/openrouter-models";
import { extractJsonObject } from "@/src/figma-agent/extract-json-object";
import { normalizeVisualReview } from "@/src/figma-agent/normalize-visual-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin || ALLOWED_ORIGINS.has(origin);
}
function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  const permitted = origin && (origin === new URL(request.url).origin || ALLOWED_ORIGINS.has(origin));
  return {
    ...(permitted ? { "Access-Control-Allow-Origin": origin! } : {}),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
function safeImage(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 52000) return null;
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null;
}
type SafeNode = Record<string, unknown>;
function compactNode(value: unknown, state: { count: number }, depth = 0): SafeNode | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || state.count >= 100) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.id !== "string" || typeof source.type !== "string") return null;
  state.count += 1;
  const node: SafeNode = { id: source.id.slice(0, 100), type: source.type.slice(0, 40) };
  for (const key of ["name", "text"] as const) {
    if (typeof source[key] === "string") node[key] = (source[key] as string).slice(0, key === "text" ? 280 : 100);
  }
  for (const key of ["x", "y", "width", "height", "rotation", "fontSize", "childCount", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom"] as const) {
    if (typeof source[key] === "number" && Number.isFinite(source[key])) node[key] = source[key];
  }
  for (const key of ["layoutMode", "layoutWrap", "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning",
    "primaryAxisSizingMode", "counterAxisSizingMode", "primaryAxisAlignItems", "counterAxisAlignItems", "textAutoResize"] as const) {
    if (typeof source[key] === "string") node[key] = (source[key] as string).slice(0, 40);
  }
  if (Array.isArray(source.fillColors)) node.fillColors = source.fillColors.filter((item): item is string => typeof item === "string").slice(0, 4);
  if (Array.isArray(source.children) && depth < 4) {
    node.children = [];
    for (const child of source.children.slice(0, 35)) {
      const nested = compactNode(child, state, depth + 1);
      if (nested) (node.children as SafeNode[]).push(nested);
      if (state.count >= 100) break;
    }
  }
  return node;
}
function compactCanvas(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { nodes: [] };
  const source = value as Record<string, unknown>;
  const state = { count: 0 };
  const nodes = Array.isArray(source.nodes)
    ? source.nodes.slice(0, 8).map((node) => compactNode(node, state)).filter((node): node is SafeNode => !!node)
    : [];
  return {
    pageName: typeof source.pageName === "string" ? source.pageName.slice(0, 120) : "",
    nodeCount: state.count,
    truncated: state.count >= 100 || source.truncated === true,
    nodes,
  };
}
export async function OPTIONS(request: Request) {
  const headers = corsHeaders(request);
  if (!isAllowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  return new Response(null, { status: 204, headers });
}

export async function POST(request: Request) {
  const headers = corsHeaders(request);
  if (!isAllowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const body: unknown = await request.json().catch(() => null);
  const schema = z.object({
    prompt: z.string().trim().min(2).max(5000),
    sourceCanvas: z.unknown().optional(),
    outputCanvas: z.unknown().optional(),
    sourceImage: z.string().max(52000).nullable().optional(),
    outputImage: z.string().max(52000).nullable().optional(),
    taskRunId: z.string().uuid().optional(),
    finalizeTask: z.boolean().optional(),
    taskOutcome: z.enum(["verified", "failed"]).optional(),
    learningCandidate: z.unknown().optional(),
    outcomeSummary: z.string().trim().max(3900).optional(),
    executionFailure: z.string().trim().min(3).max(2000).optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
    retrieval: z.object({
      status: z.enum(["complete", "empty", "degraded", "disabled"]),
      memoryIds: z.array(z.string().uuid()).max(12), chunkIds: z.array(z.string().max(200)).max(8), chars: z.number().int().min(0).max(5200),
    }).strict().optional(),
  }).strict();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Visual review input is invalid.", details: parsed.error.issues }, { status: 400, headers });
  const retrieval = parsed.data.retrieval || { status: "disabled" as const, memoryIds: [], chunkIds: [], chars: 0 };
  const project = resolveFigmaTaskProject(parsed.data.prompt);

  // Final outcome logging is an explicit one-shot operation. Intermediate QA
  // passes must not race each other or persist an unverified success/failure.
  if (parsed.data.finalizeTask === true) {
    const taskRunId = parsed.data.taskRunId;
    const outcome = parsed.data.taskOutcome;
    if (!taskRunId || !outcome) {
      return NextResponse.json({ error: "Task finalization requires taskRunId and taskOutcome." }, { status: 400, headers });
    }
    const lookupPath = "uxd_task_runs?id=eq." + encodeURIComponent(taskRunId) +
      "&select=id,status,outcome,lesson&limit=1";
    const existingResult = await neonRequest(lookupPath).catch(() => null);
    const existing = Array.isArray(existingResult) ? existingResult[0] as Record<string, unknown> | undefined : undefined;
    if (!existing?.id) {
      return NextResponse.json({ error: "The task run could not be confirmed before finalization." }, { status: 503, headers });
    }
    if (existing.status === "completed" && existing.outcome === outcome) {
      return NextResponse.json({ ok: true, logged: true, alreadyFinalized: true }, { headers });
    }

    const failureMessage = outcome === "failed"
      ? (parsed.data.executionFailure || "The native Figma task did not pass final quality verification.")
      : undefined;
    const candidate = outcome === "verified" ? sanitizeInlineLearningCandidate(parsed.data.learningCandidate) : null;
    const learned = await captureVerifiedTaskLesson({
      id: taskRunId,
      outcome,
      project,
      taskContext: parsed.data.prompt,
      candidate,
      failureMessage,
      durationMs: parsed.data.durationMs,
      retrieval,
    });
    await finishTaskRun({
      id: taskRunId,
      outcome,
      durationMs: parsed.data.durationMs || 0,
      retrieval,
      lesson: learned.lesson ? { ...learned.lesson, status: learned.status } : null,
      summary: parsed.data.outcomeSummary,
      errorSummary: failureMessage,
    });

    const confirmedResult = await neonRequest(lookupPath).catch(() => null);
    const confirmed = Array.isArray(confirmedResult) ? confirmedResult[0] as Record<string, unknown> | undefined : undefined;
    if (!confirmed || confirmed.status !== "completed" || confirmed.outcome !== outcome) {
      return NextResponse.json({ error: "Task outcome persistence could not be confirmed." }, { status: 503, headers });
    }
    return NextResponse.json({
      ok: true,
      logged: true,
      lessonStatus: learned.status,
      memoryId: learned.memoryId || null,
    }, { headers });
  }
  if (!parsed.data.sourceCanvas || !parsed.data.outputCanvas) {
    return NextResponse.json({ error: "Source and output canvas evidence are required for visual review." }, { status: 400, headers });
  }
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return NextResponse.json({ error: "OpenRouter is not configured." }, { status: 503, headers });
  const sourceImage = safeImage(parsed.data.sourceImage);
  const outputImage = safeImage(parsed.data.outputImage);
  const sourceCanvas = compactCanvas(parsed.data.sourceCanvas);
  const outputCanvas = compactCanvas(parsed.data.outputCanvas);
  let memoryContext = "Shared memory was unavailable for this review.";
  try {
    const brain = await retrieveBrainContext({
      query: (parsed.data.prompt + " UX visual quality hierarchy spacing readability source fidelity").slice(0, 2000),
      scopeKeys: resolveBrainScopes(parsed.data.prompt),
      limit: 3,
      maxChars: 1800,
      includeKnowledge: true,
    });
    memoryContext = "Shared brain retrieval " + brain.retrieval.status + ": " +
      brain.retrieval.memoryCount + " memories and " + brain.retrieval.knowledgeChunkCount + " knowledge chunks.";
  } catch { /* Review can still use visual and structural evidence. */ }

  const userContent: Array<Record<string, unknown>> = [{
    type: "text",
    text: JSON.stringify({
      userRequest: parsed.data.prompt,
      sourceCanvas,
      outputCanvas,
      sourceScreenshotAvailable: !!sourceImage,
      outputScreenshotAvailable: !!outputImage,
      reviewCriteria: [
        "fidelity to source product and flow",
        "visual hierarchy and information order",
        "layout rhythm and alignment",
        "text fit, clipping, overlap and readable contrast",
        "component consistency and action hierarchy",
        "specificity of content instead of generic cards",
      ],
      instruction: "Return evidence-based findings and manual fix suggestions only. This is a single advisory QA pass; do not imply that patches will be applied automatically. If screenshots are absent, do not invent visual observations.",
    }),
  }];
  if (sourceImage) userContent.push({ type: "image_url", image_url: { url: sourceImage } });
  if (outputImage) userContent.push({ type: "image_url", image_url: { url: outputImage } });

  const endpoint = ((process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, "")) + "/chat/completions";
  // Figma review uses the same Auto-first LOW-cost chain if explicitly invoked.
  const models = FIGMA_AGENT_MODELS.map((entry) => entry.id);
  const errors: string[] = [];
  for (const [modelIndex, model] of models.entries()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), modelIndex === 0 ? 24000 : 20000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
          "HTTP-Referer": new URL(request.url).origin,
          "X-OpenRouter-Title": "UX Direct Visual QA",
        },
        body: JSON.stringify({
          model,
          ...(model === "openrouter/auto" ? { plugins: [{ id: "auto-router", cost_tier: "low" }] } : {}),
          messages: [
            {
              role: "system",
              content: [
                UX_DIRECT_DESIGN_ROLE,
                "You are the visual QA reviewer inside a native Figma design agent. Compare source and output honestly and return evidence-based actionable defects.",
                "Return JSON only with required keys: issues (array of {severity:'high'|'medium'|'low', issue:string, evidence:string, fix:string}), score (number 0–100), summary (string); learningCandidate (null or {activate:true,title,normalizedRule,rationale,scopeKey,feedbackKind,keywords,originalLanguage}). When quality gate passes, provide one reusable, generalized native Figma workflow/design pattern. Do not turn one-off screen defects, client-specific details, screenshots, node IDs, or private text into a lesson. Use the narrowest safe scope; the backend validates scope, privacy and the existing 50% relevance gate.",
                "Compare the source screenshot with the generated screenshot when both exist. Evaluate whether the result meaningfully preserves the selected screen's specific purpose/components and improves craft. Look for generic redesign patterns, clipped text, poor spacing, hierarchy, alignment, contrast, content density and weak CTA priority.",
                "If screenshots are missing, treat the review as structural-only. Do not claim to see visual details. If no actionable issues remain, return an empty issues array.",
                "Be conservative about passing: score the result against professional production-ready quality, not merely basic validity. Penalize empty/placeholder groups, content loss, repeated generic cards, missing important source values, weak hierarchy, insufficient contrast, overflow, and incomplete layer trees. A high score requires evidence that the actual output is materially complete and specific to the user's task.",
                memoryContext,
              ].join("\n"),
            },
            { role: "user", content: userContent },
          ],
          temperature: 0.1,
          max_tokens: 1800,
          response_format: { type: "json_object" },
        }),
        cache: "no-store",
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
      if (!response.ok) {
        const providerError = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
        errors.push(model + ": " + String(providerError.message || "HTTP " + response.status).slice(0, 180));
        continue;
      }
      const choices = Array.isArray(record.choices) ? record.choices : [];
      const choice = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : {};
      const message = choice.message && typeof choice.message === "object" ? choice.message as Record<string, unknown> : {};
      const decoded = extractJsonObject(message.content)
        ?? extractJsonObject(message.parsed)
        ?? extractJsonObject(message.tool_calls)
        ?? extractJsonObject(message);
      const decodedRecord = decoded ? { ...decoded } : {};
      const learningCandidate = decodedRecord.learningCandidate;
      delete decodedRecord.learningCandidate;
      const normalizedReview = normalizeVisualReview(decodedRecord);
      const reviewSchema = z.object({
        issues: z.array(z.object({
          severity: z.enum(["high", "medium", "low"]),
          issue: z.string().trim().min(1).max(240),
          evidence: z.string().trim().min(1).max(300),
          fix: z.string().trim().min(1).max(300),
        }).strict()).max(12),
        score: z.number().min(0).max(100),
        summary: z.string().trim().min(1).max(500),
      }).strict();
      const validated = reviewSchema.safeParse(normalizedReview);
      if (!validated.success) {
        const returnedFields = decodedRecord ? Object.keys(decodedRecord).slice(0, 10).join(",") : "no-json-object";
        errors.push(model + ": response did not normalize to the visual QA schema (fields=" + returnedFields +
          ", issue-array=" + String(Boolean(decodedRecord.issues || decodedRecord.findings || decodedRecord.defects || decodedRecord.problems)) + ").");
        continue;
      }
      const unresolvedHighSeverity = validated.data.issues.some(issue => issue.severity === "high");
      const visualInspection = !!sourceImage && !!outputImage;
      const qualityGatePassed = validated.data.score >= 90 && visualInspection &&
        !unresolvedHighSeverity && validated.data.issues.length === 0;
      const safeLearningCandidate = sanitizeInlineLearningCandidate(learningCandidate);
      return NextResponse.json({
        ok: true,
        review: validated.data,
        qualityGate: {
          passed: qualityGatePassed,
          minimumScore: 90,
          unresolvedHighSeverity,
          issueCount: validated.data.issues.length,
          message: qualityGatePassed
            ? "Visual QA passed."
            : !visualInspection
              ? "Visual QA cannot pass without both source and output screenshots."
              : "Visual QA found issues. The bounded plugin repair loop may attempt a correction; completion remains blocked until final verification."
        },
        learning: safeLearningCandidate ? "candidate-ready-for-final-verification" : "no-candidate",
        learningCandidate: safeLearningCandidate,
        visualInspection,
        outputImageInspected: !!outputImage,
        model: typeof record.model === "string" ? record.model : model,
      }, { headers });
    } catch (error) {
      errors.push(model + ": " + (controller.signal.aborted ? "timed out" : error instanceof Error ? error.message.slice(0, 150) : "request failed"));
    } finally {
      clearTimeout(timer);
    }
  }
  return NextResponse.json({
    error: "Visual QA could not complete.",
    details: errors.slice(0, 2),
  }, { status: 502, headers });
}
