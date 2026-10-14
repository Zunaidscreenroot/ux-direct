import { NextResponse } from "next/server";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";
import {
  callOpenRouterChat,
  checkPluginRateLimit,
  getPluginModelList,
  isAllowedPluginOrigin,
  pluginCorsHeaders,
  PluginOpenRouterError,
  type PluginChatMessage,
} from "@/src/figma/plugin-ai-api";

type JsonRecord = Record<string, unknown>;
type ChatHistoryMessage = { role: "user" | "assistant"; content: string };
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isChatHistoryMessage(value: unknown): value is ChatHistoryMessage {
  if (!isRecord(value)) return false;
  return (value.role === "user" || value.role === "assistant") &&
    typeof value.content === "string" && value.content.length <= 8000;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(request: Request, value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: pluginCorsHeaders(request) });
}
export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: pluginCorsHeaders(request) });
}

function requestFigmaEditSystemPrompt(selectionContext: string): string {
  return [
    "You are UX Direct, a senior product/UX designer working inside the user's currently selected Figma frame.",
    "Use the user's requested model and the supplied Figma metadata; never claim an edit was applied until the plugin confirms it.",
    "Allowed Figma operations are limited to update-text, rename-node, set-fill, create-text, and create-rectangle.",
    "When the user requests an edit, return ONLY a JSON object shaped like {\"operations\":[...]}; no Markdown or prose.",
    "An operation may be: {\"action\":\"update-text\",\"targetId\":\"existing TEXT node id\",\"text\":\"replacement\"}; {\"action\":\"rename-node\",\"targetId\":\"existing node id\",\"name\":\"new name\"}; {\"action\":\"set-fill\",\"targetId\":\"existing node id\",\"color\":\"#RRGGBB\"}; {\"action\":\"create-text\",\"parentId\":\"FRAME node id\",\"text\":\"label\",\"x\":16,\"y\":16,\"fontSize\":14,\"color\":\"#RRGGBB\"}; or {\"action\":\"create-rectangle\",\"parentId\":\"FRAME node id\",\"width\":120,\"height\":48,\"x\":16,\"y\":16,\"color\":\"#RRGGBB\"}.",
    "Use only IDs shown in the Figma context. Limit the proposal to eight operations. Never delete nodes, mutate pages, call arbitrary APIs, or create outside the selected frame. Use #RRGGBB colors. If safe supported edits cannot meet the request, return {\"operations\":[]}.",
    "Current Figma context: " + selectionContext,
  ].join("\n\n");
}

function requestVariationSystemPrompt(selectionContext: string): string {
  return [
    "You are UX Direct, a senior product/UX designer creating new screen variations inside Figma.",
    "The selected frame is the source reference. The original must remain unchanged. The native plugin will clone it into sibling frames and apply your operations only to each clone.",
    "Return ONLY JSON shaped like {\"variations\":[{\"name\":\"Frame name\",\"rationale\":\"Short design direction\",\"operations\":[...]}]}; no Markdown or prose.",
    "Return exactly two clearly distinct variations unless the user explicitly asks for a different count. Maximum three variations, and maximum eight operations per variation.",
    "Use only node IDs in the supplied selected-frame tree. targetId is for an existing node to update; parentId is for a FRAME that will receive a new child. IDs refer to the original tree and the plugin maps them onto the cloned tree.",
    "Supported operations: {\"action\":\"update-text\",\"targetId\":\"TEXT node id\",\"text\":\"replacement\"}; {\"action\":\"rename-node\",\"targetId\":\"node id\",\"name\":\"new name\"}; {\"action\":\"set-fill\",\"targetId\":\"node id\",\"color\":\"#RRGGBB\"}; {\"action\":\"move-node\",\"targetId\":\"node id\",\"x\":16,\"y\":16}; {\"action\":\"resize-node\",\"targetId\":\"node id\",\"width\":320,\"height\":80}; {\"action\":\"create-text\",\"parentId\":\"FRAME node id\",\"text\":\"label\",\"x\":16,\"y\":16,\"fontSize\":14,\"color\":\"#RRGGBB\"}; or {\"action\":\"create-rectangle\",\"parentId\":\"FRAME node id\",\"width\":120,\"height\":48,\"x\":16,\"y\":16,\"color\":\"#RRGGBB\"}.",
    "Each variation must be a meaningful visual alternative, not just a renamed duplicate. Use 3-8 high-impact changes across hierarchy, spacing, card treatment, contrast, copy, or CTA emphasis where suitable. Keep the existing product purpose and essential information. Never delete nodes, call arbitrary APIs, or use IDs outside the selected frame. Use #RRGGBB colors. Do not output empty operations arrays.",
    "Current Figma context: " + selectionContext,
  ].join("\\n\\n");
}

function conversationSystemPrompt(selectionContext: string): string {
  return [
    "You are UX Direct, a conversational senior UX/UI design assistant embedded in Figma.",
    "Be direct, specific, and collaborative. Use the selected frame/layer context to answer audits, UX questions, content questions, and design critique. Keep the user's project conventions in mind.",
    "Do not claim you changed Figma unless the request was explicitly routed as a design operation and the native plugin later confirms the operation result.",
    "Current Figma context: " + selectionContext,
  ].join("\n\n");
}

export async function POST(request: Request) {
  if (!isAllowedPluginOrigin(request)) return json(request, { error: "Origin not allowed." }, 403);
  let parsed: unknown;
  try { parsed = await request.json(); }
  catch { return json(request, { error: "Request body must be valid JSON." }, 400); }
  if (!isRecord(parsed)) return json(request, { error: "Request body must be a JSON object." }, 400);
  const body = parsed;
  if (typeof body.fileKey !== "string" || !isAllowedFigmaFileKey(body.fileKey)) {
    return json(request, { error: "Figma file is not allowlisted." }, 403);
  }
  if (body.provider !== "openrouter" || typeof body.model !== "string") {
    return json(request, { error: "Select an approved OpenRouter model." }, 400);
  }
  const modelOptions = getPluginModelList();
  const selectedModel = modelOptions.find((entry) => entry.id === body.model && entry.provider === "openrouter");
  if (!selectedModel || !selectedModel.available) {
    return json(request, { error: "The selected model is not available in this Vercel Preview." }, 503);
  }
  const incomingMessages: unknown[] = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  const rawMessages = incomingMessages.filter(isChatHistoryMessage);
  if (!rawMessages.length || rawMessages.length !== incomingMessages.length) {
    return json(request, { error: "Conversation messages are missing or invalid." }, 400);
  }
  const totalChars = rawMessages.reduce((total, message) => total + message.content.length, 0);
  if (totalChars > 50000) return json(request, { error: "Conversation exceeds the safe input limit." }, 413);

  const limit = checkPluginRateLimit(request);
  if (!limit.allowed) {
    return json(request, { error: "Conversational Cockpit rate limit reached. Retry in " + limit.retryAfterSeconds + " seconds." }, 429);
  }

  const selection = isRecord(body.selection) ? body.selection : {};
  const items = Array.isArray(selection.items) ? selection.items.slice(0, 12) : [];
  const selectionContext = JSON.stringify({
    pageName: typeof selection.pageName === "string" ? selection.pageName.slice(0, 160) : "",
    totalCount: typeof selection.totalCount === "number" && Number.isFinite(selection.totalCount) ? selection.totalCount : items.length,
    items,
  }).slice(0, 30000);
  const previewDataUrl = typeof selection.previewDataUrl === "string" ? selection.previewDataUrl : "";
  if (previewDataUrl && (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(previewDataUrl) || previewDataUrl.length > 2800000)) {
    return json(request, { error: "Selected-frame preview is not a valid bounded JPEG image." }, 400);
  }

  const variationIntent = body.intent === "design-variation";
  const designIntent = body.intent === "design-operation" || variationIntent;
  const visualIntent = Boolean(previewDataUrl);
  const systemPrompt = variationIntent
    ? requestVariationSystemPrompt(selectionContext)
    : designIntent
      ? requestFigmaEditSystemPrompt(selectionContext)
      : conversationSystemPrompt(selectionContext);

  const inputMessages: PluginChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...rawMessages.map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
    })),
  ];

  let selectedForInference = selectedModel;
  let fallbackReason = "";
  if (visualIntent && !selectedModel.supportsImages) {
    const visionModel = modelOptions.find((model) =>
      model.tier === "free-tier" && model.available && model.supportsImages);
    if (visionModel) {
      selectedForInference = visionModel;
      fallbackReason = "The selected model cannot accept screenshots; used the approved OpenRouter vision model.";
    } else {
      const paidVision = modelOptions.find((model) =>
        model.tier === "paid" && model.available && model.supportsImages);
      if (paidVision) {
        selectedForInference = paidVision;
        fallbackReason = "Free vision routing was unavailable; used the explicitly enabled paid vision model.";
      } else {
        return json(request, { error: "No approved vision model is configured for frame analysis." }, 503);
      }
    }
  }

  const lastUserIndex = inputMessages.map((message) => message.role).lastIndexOf("user");
  if (visualIntent && lastUserIndex >= 0) {
    const lastUserMessage = inputMessages[lastUserIndex];
    const text = String(lastUserMessage.content);
    inputMessages[lastUserIndex] = {
      role: "user",
      content: [
        { type: "text", text: text + "\n\nInspect the supplied screenshot and the layer metadata. Be concrete and cite visible details." },
        { type: "image_url", image_url: { url: previewDataUrl } },
      ],
    };
  }

  const candidates: typeof modelOptions = [];
  if (visualIntent) {
    // Image-bearing requests must use an image-capable model even when the
    // user's dropdown preference is a paid text-only model.
    candidates.push(selectedForInference);
    const paidVision = modelOptions.find((model) =>
      model.tier === "paid" && model.available && model.supportsImages && model.id !== selectedForInference.id);
    if (selectedForInference.tier !== "paid" && paidVision) candidates.push(paidVision);
  } else if (selectedModel.tier === "paid") {
    candidates.push(selectedModel);
  } else {
    candidates.push(selectedModel);
    for (const model of modelOptions) {
      if (model.tier === "free-tier" && model.available && model.id !== selectedModel.id && candidates.length < 2) {
        candidates.push(model);
      }
    }
    const paidFallback = modelOptions.find((model) =>
      model.tier === "paid" && model.available && model.id === "deepseek/deepseek-v4-flash-0731");
    if (paidFallback) candidates.push(paidFallback);
  }

  let lastError: unknown = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const result = await callOpenRouterChat(candidate.id, inputMessages, {
        maxTokens: variationIntent ? 1600 : designIntent ? 1400 : 1100,
        temperature: variationIntent ? 0.15 : designIntent ? 0.1 : 0.35,
        timeoutMs: 30000,
      });
      const wasFallback = candidate.id !== selectedModel.id;
      return json(request, {
        content: result.content,
        provider: "openrouter",
        model: result.model,
        tier: candidate.tier,
        latencyMs: result.latencyMs,
        routingStrategy: visualIntent
          ? "vision-direct"
          : wasFallback
            ? candidate.tier === "paid" ? "paid-fallback" : "free-first-fallback"
            : candidate.tier === "paid" ? "paid-direct" : "direct",
        fallbackReason: fallbackReason || (wasFallback ? "The selected model did not complete the request; a configured fallback model responded." : undefined),
      });
    } catch (error) {
      lastError = error;
      const status = error instanceof PluginOpenRouterError ? error.status : 502;
      if (status === 401 || status === 403 || status === 400) break;
      if (selectedModel.tier === "paid") break;
    }
  }

  const reason = lastError instanceof Error ? lastError.message : "OpenRouter did not return a usable response.";
  const status = lastError instanceof PluginOpenRouterError ? lastError.status : 502;
  return json(request, { error: reason, provider: "openrouter", model: selectedModel.id }, status >= 400 && status <= 599 ? status : 502);
}
