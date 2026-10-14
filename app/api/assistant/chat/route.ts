import { NextResponse } from "next/server";
import { classifyBfciCapability, orderedModelIds } from "@/src/figma/bfci-capabilities";
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

function requestVariationSystemPrompt(selectionContext: string, variationCount: number): string {
  return [
    "You are UX Direct, a senior product/UX designer creating new screen variations inside Figma.",
    "The selected frame is the source reference. The original must remain unchanged. The native plugin will clone it into sibling frames and apply your operations only to each clone.",
    "Return ONLY JSON shaped like {\"variations\":[{\"name\":\"Frame name\",\"rationale\":\"Short design direction\",\"operations\":[...]}]}; no Markdown or prose.",
    `Return exactly ${variationCount} clearly distinct variation(s), with no extra variations. Use 8–14 high-impact operations per variation (maximum 16). Do not satisfy a redesign by only changing copy or renaming the frame: materially improve hierarchy, auto-layout/spacing, typography, card treatment, contrast, CTA priority and grouping.`,
    "Use only node IDs in the supplied selected-frame tree. targetId is for an existing node to update; parentId is for a FRAME that will receive a new child. IDs refer to the original tree and the plugin maps them onto the cloned tree.",
    "Supported operations: {\"action\":\"update-text\",\"targetId\":\"TEXT node id\",\"text\":\"replacement\"}; {\"action\":\"rename-node\",\"targetId\":\"node id\",\"name\":\"new name\"}; {\"action\":\"set-fill\",\"targetId\":\"node id\",\"color\":\"#RRGGBB\"}; {\"action\":\"move-node\",\"targetId\":\"node id\",\"x\":16,\"y\":16}; {\"action\":\"resize-node\",\"targetId\":\"node id\",\"width\":320,\"height\":80}; {\"action\":\"set-text-style\",\"targetId\":\"TEXT node id\",\"fontSize\":16,\"fontStyle\":\"Semi Bold\"}; {\"action\":\"set-corner-radius\",\"targetId\":\"node id\",\"radius\":12}; {\"action\":\"set-stroke\",\"targetId\":\"node id\",\"color\":\"#RRGGBB\",\"width\":1}; {\"action\":\"set-opacity\",\"targetId\":\"node id\",\"opacity\":1}; {\"action\":\"set-visible\",\"targetId\":\"node id\",\"visible\":true}; {\"action\":\"set-layout\",\"targetId\":\"FRAME node id\",\"layoutMode\":\"VERTICAL\",\"itemSpacing\":12,\"paddingTop\":16,\"paddingRight\":16,\"paddingBottom\":16,\"paddingLeft\":16}; {\"action\":\"reorder-node\",\"targetId\":\"node id\",\"index\":0}; {\"action\":\"create-text\",\"parentId\":\"FRAME node id\",\"text\":\"label\",\"x\":16,\"y\":16,\"fontSize\":14,\"color\":\"#RRGGBB\"}; or {\"action\":\"create-rectangle\",\"parentId\":\"FRAME node id\",\"width\":120,\"height\":48,\"x\":16,\"y\":16,\"color\":\"#RRGGBB\"}. Use only values supported by the target node type; keep edits inside the source frame tree.",
    "Each variation must be a meaningful visual alternative, not just a renamed duplicate. Prioritize the most important improvements across hierarchy, spacing, card treatment, contrast, copy, or CTA emphasis. Keep the existing product purpose and essential information. Never delete nodes, call arbitrary APIs, or use IDs outside the selected frame. Use #RRGGBB colors. Do not output empty operations arrays.",
    "Current Figma context: " + selectionContext,
  ].join("\n\n");
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
    return json(request, { error: "Select an approved UX Direct model." }, 400);
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
  const lastUserPrompt = [...rawMessages].reverse().find((message) => message.role === "user")?.content ?? "";
  const capability = classifyBfciCapability({
    intent: typeof body.intent === "string" ? body.intent : "chat",
    prompt: lastUserPrompt,
    hasScreenshot: Boolean(previewDataUrl),
  });
  const variationCountMatch = variationIntent
    ? /\b(one|two|three|1|2|3)\s+(?:new\s+)?(?:screen\s+)?variations?\b/i.exec(lastUserPrompt)
    : null;
  const variationCount = variationCountMatch
    ? ({ one: 1, two: 2, three: 3, "1": 1, "2": 2, "3": 3 } as Record<string, number>)[variationCountMatch[1].toLowerCase()] ?? 2
    : 2;
  const designIntent = body.intent === "design-operation" || variationIntent;
  const visualIntent = Boolean(previewDataUrl);
  const baseSystemPrompt = variationIntent
    ? requestVariationSystemPrompt(selectionContext, variationCount)
    : designIntent
      ? requestFigmaEditSystemPrompt(selectionContext)
      : conversationSystemPrompt(selectionContext);
  const capabilityGuardrails = [
    "Active UX Direct capability: " + capability.id + " — " + capability.label + ".",
    "BFCI profile: DMI Housing Finance. Use only financial values, due dates, policies and product rules supplied in the prompt, screenshot, selected frame or approved reference context. Never invent an APR, fee, eligibility criterion, disclosure, consent requirement or regulatory claim.",
    "Preserve every essential customer-facing financial amount, due date, account detail, status and consent meaning unless the user explicitly asks to change it.",
    "Quality target: " + capability.targetQuality + "/100. Check: " + capability.qualityChecks.join("; ") + ".",
    capability.id === "bfci.banking-risk-review"
      ? "Provide potential UX risks and recommended mitigations, not legal/compliance certification. Clearly mark missing product-owner or compliance confirmation."
      : "",
    capability.id === "bfci.screen-audit"
      ? "Base findings on what is actually visible in the supplied screenshot and the selected layer tree. Separate observed issues from inferences."
      : "",
    capability.id === "bfci.screen-redesign"
      ? "This is a redesign capability, not a clone capability. Prefer substantial layout, spacing, hierarchy, card/section and CTA changes. Use the available operation budget to make a cohesive alternative rather than a handful of cosmetic edits."
      : "",
  ].filter(Boolean).join("\n\n");
  const systemPrompt = baseSystemPrompt + "\n\n" + capabilityGuardrails;

  const inputMessages: PluginChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...rawMessages.map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
    })),
  ];

  const availableById = new Map(modelOptions.map((model) => [model.id, model]));
  const configuredOrder = orderedModelIds(capability);
  let orderedCandidates = configuredOrder
    .map((id) => availableById.get(id))
    .filter((model): model is (typeof modelOptions)[number] => Boolean(model && model.available && model.automaticRouting !== false));

  // For an incidental screenshot attached to a small edit, upgrade only to a
  // low-cost vision model if the free text route cannot consume the image.
  if (visualIntent) {
    orderedCandidates = orderedCandidates.filter((model) => model.supportsImages);
    if (!orderedCandidates.length && capability.id === "bfci.screen-edit") {
      const safeVision = availableById.get("anthropic/claude-haiku-5.5");
      if (safeVision?.available) orderedCandidates = [safeVision];
    }
  }
  // The user-selected model remains a preference, but the capability router
  // owns the final choice. An image request must never land on a text-only model.
  const candidates = orderedCandidates.slice(0, Math.max(1, capability.maxModelAttempts));
  if (!candidates.length) {
    return json(request, {
      error: capability.paidRequired
        ? "No approved paid model is available for this high-compute BFCI task."
        : "No approved model is currently available for this task.",
      capability: capability.id,
      paidRequired: capability.paidRequired,
    }, 503);
  }

  let lastError: unknown = null;
  let reservedEstimatedCostUsd = 0;
  const maxOutputTokens = variationIntent
    ? Math.min(4200, capability.maxOutputTokens + 1000)
    : capability.maxOutputTokens;
  // Conservative preflight estimate: text characters/4 plus a bounded image allowance.
  // Price metadata is per million tokens; unknown-price models are not auto-routed.
  const estimatedInputTokens = Math.ceil(
    (selectionContext.length + systemPrompt.length + rawMessages.reduce((sum, message) => sum + message.content.length, 0)) / 4
  ) + (visualIntent ? 2500 : 0);

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const inputRate = candidate.inputUsdPerMillion;
    const outputRate = candidate.outputUsdPerMillion;
    if (candidate.tier === "paid" && (inputRate === null || outputRate === null)) {
      lastError = new PluginOpenRouterError("This model has no verified price metadata and is excluded from automatic routing.", 402);
      continue;
    }
    const estimatedCallCostUsd = candidate.tier === "free-tier"
      ? 0
      : ((estimatedInputTokens * (inputRate ?? 0)) + (maxOutputTokens * (outputRate ?? 0))) / 1_000_000;
    if (candidate.tier === "paid" && reservedEstimatedCostUsd + estimatedCallCostUsd > capability.maxEstimatedCostUsd) {
      lastError = new PluginOpenRouterError(
        "The remaining estimated cost budget for " + capability.label + " is too low for the next model. No additional paid call was made.",
        402,
      );
      continue;
    }
    reservedEstimatedCostUsd += estimatedCallCostUsd;
    try {
      const result = await callOpenRouterChat(candidate.id, inputMessages, {
        maxTokens: maxOutputTokens,
        temperature: variationIntent ? 0.15 : designIntent ? 0.1 : 0.35,
        timeoutMs: 30000,
        reasoningEffort: capability.reasoningEffort,
      });
      if (variationIntent) {
        let plan: unknown;
        try {
          const cleaned = result.content.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
          plan = JSON.parse(cleaned);
        } catch {
          throw new PluginOpenRouterError("Model " + candidate.id + " returned an invalid variation-plan JSON response.", 502);
        }
        const envelope = isRecord(plan) && Array.isArray(plan.variations) ? plan.variations : [];
        const variationOperationsValid = (item: unknown) => {
          if (!isRecord(item) || !Array.isArray(item.operations) || item.operations.length < 6 || item.operations.length > 16) return false;
          const allowedActions = new Set([
            "update-text", "rename-node", "set-fill", "move-node", "resize-node",
            "create-text", "create-rectangle", "set-text-style", "set-corner-radius",
            "set-stroke", "set-opacity", "set-visible", "set-layout", "reorder-node",
          ]);
          if (!item.operations.every((op) => isRecord(op) && typeof op.action === "string" && allowedActions.has(op.action))) return false;
          const categories = new Set(item.operations.map((op) => {
            const action = isRecord(op) ? op.action : "";
            if (["set-layout", "move-node", "resize-node", "reorder-node", "set-visible"].includes(String(action))) return "structure";
            if (["set-fill", "set-text-style", "set-corner-radius", "set-stroke", "set-opacity"].includes(String(action))) return "style";
            if (["update-text", "create-text", "create-rectangle"].includes(String(action))) return "content";
            return "other";
          }));
          const structuralCount = item.operations.filter((op) =>
            isRecord(op) && ["set-layout", "move-node", "resize-node", "reorder-node"].includes(String(op.action))
          ).length;
          return categories.size >= 2 && structuralCount >= 2;
        };
        const structurallyValid = envelope.length === variationCount && envelope.every((item) =>
          isRecord(item) && typeof item.name === "string" && item.name.trim().length > 0 &&
          variationOperationsValid(item)
        );
        if (!structurallyValid) {
          throw new PluginOpenRouterError("Model " + candidate.id + " returned a plan that did not meet the redesign quality gate (expected 6–16 operations including layout/structure changes).", 502);
        }
      }
      const wasFallback = candidate.id !== selectedModel.id;
      return json(request, {
        content: result.content,
        capability: capability.id,
        capabilityLabel: capability.label,
        qualityTarget: capability.targetQuality,
        paidRequired: capability.paidRequired,
        estimatedCostUsd: estimatedCallCostUsd,
        estimatedCostBudgetUsd: capability.maxEstimatedCostUsd,
        estimatedReservedCostUsd: reservedEstimatedCostUsd,
        provider: "openrouter",
        model: result.model,
        tier: candidate.tier,
        latencyMs: result.latencyMs,
        routingStrategy: visualIntent
          ? "vision-direct"
          : wasFallback
            ? candidate.tier === "paid" ? "paid-fallback" : "free-first-fallback"
            : candidate.tier === "paid" ? "paid-direct" : "direct",
        fallbackReason: wasFallback ? "UX Direct selected an alternate model based on this capability and model health." : undefined,
      });
    } catch (error) {
      lastError = error;
      const status = error instanceof PluginOpenRouterError ? error.status : 502;
      if (status === 401 || status === 403 || status === 400) break;
    }
  }

  const reason = lastError instanceof Error ? lastError.message : "No configured model returned a usable response.";
  const status = lastError instanceof PluginOpenRouterError ? lastError.status : 502;
  return json(request, { error: reason, capability: capability.id, estimatedCostBudgetUsd: capability.maxEstimatedCostUsd, estimatedReservedCostUsd: reservedEstimatedCostUsd, provider: "openrouter", model: selectedModel.id }, status >= 400 && status <= 599 ? status : 502);
}
