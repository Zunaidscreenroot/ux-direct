import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { BFCI_CAPABILITIES, classifyBfciCapability, orderedModelIds, type BfciCapabilityId } from "@/src/figma/bfci-capabilities";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";
import { getModelLearningContext, recordModelLearningEvent } from "@/src/figma/model-learning";
import { resolveKnowledgeProjectKey, retrieveProjectKnowledge } from "@/src/figma/knowledge-rag";
import { assembleAugmentedContext } from "@/src/figma/context-assembly";
import {
  callOpenRouterChat,
  checkPluginRateLimit,
  getPluginModelList,
  isAllowedPluginOrigin,
  pluginCorsHeaders,
  PluginOpenRouterError,
  reserveDailyPaidModelBudget,
  getDailyPaidModelBudgetStatus,
  settleDailyPaidModelBudget,
  type DailyPaidBudgetReservation,
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
    "Use the approved native Figma action set: update-text, rename-node, set-fill, set-stroke, set-opacity, set-visible, set-locked, set-blend-mode, move-node, resize-node, set-rotation, set-corner-radius, set-text-style, set-layout, set-layout-sizing, set-layout-positioning, set-constraints, set-clip-content, set-layout-grid, set-effects, set-description, create-component, detach-instance, reorder-node, clone-node, remove-node (selected child nodes only), create-text, create-rectangle, create-ellipse, create-line, create-frame, and create-svg. Restrict every operation to the selected frame or one of its descendants.",
    "When the user requests an edit, return ONLY a JSON object shaped like {\"operations\":[...]}; no Markdown or prose.",
    "Each operation is a bounded JSON object with action-specific targetId or parentId and parameters. Create actions must target a FRAME in the selection; update-text targets TEXT; set-layout targets FRAME. Text styling supports fontFamily/fontStyle/fontSize/color/letterSpacing/lineHeight/paragraphSpacing/textAlignHorizontal/textAlignVertical/textAutoResize/textCase/textDecoration. The native plugin validates node types, numeric bounds, SVG safety and frame scope before applying.",
    "Use only IDs shown in the Figma context. Limit the proposal to 32 operations. Never remove the selected root frame or mutate pages. Use remove-node only for an explicitly requested child-layer removal. Never call arbitrary APIs or create outside the selected frame. Use #RRGGBB colors. If safe supported edits cannot meet the request, return {\"operations\":[]}.",
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
    "Supported design actions (use only node IDs in the supplied frame tree): update-text, rename-node, set-fill, set-stroke, set-opacity, set-visible, set-locked, set-blend-mode, move-node, resize-node, set-rotation, set-corner-radius, set-text-style, set-layout, set-layout-sizing, set-layout-positioning, set-constraints, set-clip-content, set-layout-grid, set-effects, set-description, create-component (child frames only), detach-instance, reorder-node, clone-node, remove-node (child layers only), create-text, create-rectangle, create-ellipse, create-line, create-frame, and create-svg. Create actions use parentId referencing a FRAME inside the clone. SVG markup must be bounded (under 10,000 characters) and contain no script, foreignObject, external href, or javascript URL. set-text-style can set fontFamily, fontStyle, fontSize, color, letterSpacing, lineHeight, paragraphSpacing, textAlignHorizontal, textAlignVertical, textAutoResize, textCase, and textDecoration. set-layout accepts layoutMode NONE/HORIZONTAL/VERTICAL, itemSpacing, padding, alignment and sizing fields. set-layout-sizing accepts horizontal/vertical HUG/FILL/FIXED; set-layout-positioning accepts AUTO/ABSOLUTE. set-constraints accepts horizontal LEFT/CENTER/RIGHT/LEFT_RIGHT/SCALE and vertical TOP/CENTER/BOTTOM/TOP_BOTTOM/SCALE. Keep every mutation inside the cloned frame tree; the original must remain unchanged.",
    "Each variation must be a meaningful visual alternative, not just a renamed duplicate. Prioritize the most important improvements across hierarchy, spacing, card treatment, contrast, copy, or CTA emphasis. Keep the existing product purpose and essential information. Use remove-node only when the user explicitly requests removing a child from the new clone; never remove the root or mutate the original. Never call arbitrary APIs or use IDs outside the selected frame. Use #RRGGBB colors. Do not output empty operations arrays.",
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
  const learningRequestId = randomUUID();
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
  const incomingMessages: unknown[] = Array.isArray(body.messages) ? body.messages.slice(-6) : [];
  const rawMessages = incomingMessages.filter(isChatHistoryMessage);
  if (!rawMessages.length || rawMessages.length !== incomingMessages.length) {
    return json(request, { error: "Conversation messages are missing or invalid." }, 400);
  }
  const totalChars = rawMessages.reduce((total, message) => total + message.content.length, 0);
  if (totalChars > 22000) return json(request, { error: "Conversation exceeds the 22,000-character safe input limit." }, 413);

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
  }).slice(0, 16000);
  const previewDataUrl = typeof selection.previewDataUrl === "string" ? selection.previewDataUrl : "";
  if (previewDataUrl && (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(previewDataUrl) || previewDataUrl.length > 2800000)) {
    return json(request, { error: "Selected-frame preview is not a valid bounded JPEG image." }, 400);
  }

  const variationIntent = body.intent === "design-variation";
  const lastUserPrompt = [...rawMessages].reverse().find((message) => message.role === "user")?.content ?? "";
  const selectedLayerNames = items.map((item) => isRecord(item) && typeof item.name === "string" ? item.name : "").filter(Boolean).slice(0, 12).join(" ");
  // Client knowledge scope comes from the explicit cockpit selector, never inferred from user prompt text.
  // Older clients without a valid project selection can only access the explicitly shared BFCI namespace.
  const activeProjectKey = resolveKnowledgeProjectKey(typeof body.project === "string" ? body.project : "") || "INDIA_BFCI_SHARED";
  const activeProjectLabel = activeProjectKey === "UJJIVAN_SFB"
    ? "Ujjivan Small Finance Bank"
    : activeProjectKey === "DMI_HFC"
      ? "DMI Housing Finance"
      : "shared Indian BFCI";
  const inferredCapability = classifyBfciCapability({
    intent: typeof body.intent === "string" ? body.intent : "chat",
    prompt: lastUserPrompt,
    hasScreenshot: Boolean(previewDataUrl),
  });
  // Routing policy originates in the Figma cockpit. The server validates its
  // capability/model allowlists and enforces budgets, but does not reorder a
  // cockpit-supplied route using a second intelligence policy.
  const clientRoute = isRecord(body.clientRoute) ? body.clientRoute : null;
  const clientCapabilityId = typeof clientRoute?.capabilityId === "string" &&
    Object.prototype.hasOwnProperty.call(BFCI_CAPABILITIES, clientRoute.capabilityId)
    ? clientRoute.capabilityId as BfciCapabilityId
    : null;
  const requestedClientModels = Array.isArray(clientRoute?.modelOrder)
    ? [...new Set(clientRoute.modelOrder.filter((id): id is string => typeof id === "string").slice(0, 5))]
    : [];
  const useClientRoute = clientRoute?.source === "cockpit" && Boolean(clientCapabilityId) && requestedClientModels.length > 0;
  const capability = useClientRoute && clientCapabilityId
    ? BFCI_CAPABILITIES[clientCapabilityId]
    : inferredCapability;
  const clientSystemPrompt = typeof body.systemPrompt === "string" && body.systemPrompt.length <= 32000
    ? body.systemPrompt.trim()
    : "";
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
    "Active project: " + activeProjectLabel + ". Use only financial values, due dates, policies and product rules supplied in the prompt, screenshot, selected frame or approved reference context. Never invent an APR, fee, eligibility criterion, disclosure, consent requirement or regulatory claim.",
    "Preserve every essential customer-facing financial amount, due date, account detail, status and consent meaning unless the user explicitly asks to change it.",
    "Quality target: " + capability.targetQuality + "/100. Check: " + capability.qualityChecks.join("; ") + ".",
    capability.id === "bfci.banking-risk-review"
      ? "Provide potential UX risks and recommended mitigations, not legal/compliance certification. Clearly mark missing product-owner or compliance confirmation."
      : "",
    capability.id === "bfci.screen-audit"
      ? "The selected-frame screenshot is attached to the latest user message as image content. Inspect the rendered screenshot. Provide 4–6 actionable findings covering hierarchy, text legibility, contrast, spacing/alignment and primary CTA as relevant. For each finding, state the visible evidence, why it matters and a recommended change. Separate visual observations from assumptions. Do not invent measurements or details."
      : "",
    capability.id === "bfci.screen-redesign"
      ? "This is a redesign capability, not a clone capability. Prefer substantial layout, spacing, hierarchy, card/section and CTA changes. Use the available operation budget to make a cohesive alternative rather than a handful of cosmetic edits."
      : "",
  ].filter(Boolean).join("\n\n");
  const learningProjectKey = activeProjectKey === "UJJIVAN_SFB"
    ? "ujjivan-sfb"
    : activeProjectKey === "DMI_HFC"
      ? "dmi-housing-finance"
      : "general";
  const learning = await getModelLearningContext(capability.id, learningProjectKey);
  const retrievalQuery = [
    lastUserPrompt,
    "Active capability: " + capability.label,
    "Page: " + (typeof selection.pageName === "string" ? selection.pageName : ""),
    "Selected layers: " + selectedLayerNames,
  ].filter(Boolean).join("\n").slice(0, 4000);
  const shortGreeting = /^(hi|hello|hey|thanks|thank you|ok|okay|good morning|good afternoon)[.!\\s]*$/i.test(lastUserPrompt.trim());
  const knowledge = lastUserPrompt.trim().length >= 12 && !shortGreeting
    ? await retrieveProjectKnowledge(activeProjectKey, retrievalQuery)
    : { available: true, projectKey: activeProjectKey, hits: [], context: "", retrievalMode: "skipped" as const };
  const baseAugmentedPrompt = useClientRoute && clientSystemPrompt
    ? clientSystemPrompt + "\n\n" + capabilityGuardrails
    : baseSystemPrompt + "\n\n" + capabilityGuardrails;
  const assembledContext = assembleAugmentedContext({
    basePrompt: baseAugmentedPrompt,
    projectKey: activeProjectKey,
    projectLabel: activeProjectLabel,
    capabilityLabel: capability.label,
    learningContext: learning.promptContext,
    knowledgeContext: knowledge.context,
  });
  const systemPrompt = assembledContext.systemPrompt;

  // Attach the exported JPEG to the latest user turn. Previously the screenshot
  // was used only for model selection and cost estimation, while OpenRouter
  // received text-only messages; that made the "visual scan complete" status
  // misleading. Only the current visual request carries the image, not history.
  const latestUserMessageIndex = rawMessages.map((message) => message.role).lastIndexOf("user");
  const messagesWithVisualEvidence: PluginChatMessage[] = rawMessages.map((message, index): PluginChatMessage => {
    let content: PluginChatMessage["content"] = message.content;
    if (visualIntent && previewDataUrl && message.role === "user" && index === latestUserMessageIndex) {
      content = [
        {
          type: "text",
          text: message.content +
            "\n\nThe selected Figma frame screenshot is attached as image evidence. Inspect the rendered pixels directly. Ground visual findings in the image, and distinguish visible observations from inferences. Do not claim you cannot see rendered pixels when this image is attached.",
        },
        { type: "image_url", image_url: { url: previewDataUrl } },
      ];
    }
    return {
      role: message.role as "user" | "assistant",
      content,
    };
  });
  const inputMessages: PluginChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...messagesWithVisualEvidence,
  ];

  const availableById = new Map(modelOptions.map((model) => [model.id, model]));
  const configuredOrder = orderedModelIds(capability);
  const routeOrder = useClientRoute ? requestedClientModels : configuredOrder;
  let orderedCandidates = routeOrder
    .map((id) => availableById.get(id))
    .filter((model): model is (typeof modelOptions)[number] => Boolean(model && model.available &&
      (useClientRoute || model.automaticRouting !== false)));

  // For an incidental screenshot attached to a small edit, upgrade only to a
  // low-cost vision model if the free text route cannot consume the image.
  if (visualIntent) {
    orderedCandidates = orderedCandidates.filter((model) => model.supportsImages);
    if (!orderedCandidates.length && capability.id === "bfci.screen-edit") {
      const safeVision = availableById.get("anthropic/claude-haiku-5.5");
      if (safeVision?.available) orderedCandidates = [safeVision];
    }
  }
  // The capability registry remains the hard constraint: memory can reorder only
  // already-approved candidates, and only where at least three prior attempts exist.
  const matureLearnedCandidates = orderedCandidates
    .filter((model) => (learning.modelScores[model.id]?.attempts ?? 0) >= 3)
    .sort((a, b) => (learning.modelScores[b.id]?.routingScore ?? -Infinity) - (learning.modelScores[a.id]?.routingScore ?? -Infinity));
  if (!useClientRoute && matureLearnedCandidates.length > 1) {
    let learnedIndex = 0;
    orderedCandidates = orderedCandidates.map((model) =>
      (learning.modelScores[model.id]?.attempts ?? 0) >= 3 ? matureLearnedCandidates[learnedIndex++] : model
    );
  }
  // An image request must never land on a text-only model, even after learning.
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
  let dailyBudgetInfo: DailyPaidBudgetReservation | null = null;
  const maxOutputTokens = Math.min(3200, capability.maxOutputTokens);
  // The system prompt already includes selected-frame metadata. Avoid counting it twice.
  const estimatedInputTokens = Math.ceil(
    (systemPrompt.length + rawMessages.reduce((sum, message) => sum + message.content.length, 0)) / 4
  ) + (visualIntent ? 6000 : 800);

  let paidAuditAttempts = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (capability.id === "bfci.screen-audit" && candidate.tier === "paid" && paidAuditAttempts >= 1) {
      lastError = new PluginOpenRouterError("Visual audit stopped after one paid attempt; no additional paid retry was sent.", 402);
      break;
    }
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
        "The per-task estimated cost ceiling for " + capability.label + " would be exceeded by the next retry (estimated task total $" +
          (reservedEstimatedCostUsd + estimatedCallCostUsd).toFixed(4) + " of $" + capability.maxEstimatedCostUsd.toFixed(2) +
          "). This is separate from the shared ₹50 rolling 24-hour budget. UX Direct will not send another paid request.",
        402,
      );
      continue;
    }
    reservedEstimatedCostUsd += estimatedCallCostUsd;
    let attemptLatencyMs: number | undefined;
    let attemptObservedCostUsd: number | null = null;
    let attemptUsage = { promptTokens: null as number | null, completionTokens: null as number | null, totalTokens: null as number | null };
    let validationPassed = false;
    let operationProfile: Record<string, unknown> = {};
    try {
      if (candidate.tier === "paid") {
        const reservation = await reserveDailyPaidModelBudget({
          estimatedCostUsd: estimatedCallCostUsd,
          model: candidate.id,
          requestId: learningRequestId + ":" + index,
        });
        if (!reservation.allowed) {
          throw new PluginOpenRouterError(
            "Daily AI budget reached: ₹" + reservation.spentInr.toFixed(2) + " of ₹" + reservation.limitInr.toFixed(2) +
            " was reserved in the last 24 hours. Estimated remaining budget: ₹" + reservation.remainingInr.toFixed(2) +
            ". No additional paid model call was made.",
            402,
          );
        }
        dailyBudgetInfo = reservation;
        if (capability.id === "bfci.screen-audit") paidAuditAttempts += 1;
      }
      const result = await callOpenRouterChat(candidate.id, inputMessages, {
        maxTokens: maxOutputTokens,
        temperature: variationIntent ? 0.15 : designIntent ? 0.1 : 0.35,
        timeoutMs: 30000,
        reasoningEffort: capability.reasoningEffort,
      });
      attemptLatencyMs = result.latencyMs;
      attemptObservedCostUsd = result.observedCostUsd;
      attemptUsage = result.usage;
      // Provider charges may apply even when a downstream JSON or quality gate rejects the response.
      if (candidate.tier === "paid" && attemptObservedCostUsd !== null) {
        await settleDailyPaidModelBudget({ requestId: learningRequestId + ":" + index, actualCostUsd: attemptObservedCostUsd });
      }
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
            "create-text", "create-rectangle", "create-ellipse", "create-line", "create-frame", "create-svg",
            "set-text-style", "set-corner-radius", "set-stroke", "set-opacity", "set-visible",
            "set-layout", "set-layout-sizing", "set-layout-positioning", "set-constraints", "set-clip-content",
            "set-layout-grid", "set-effects", "set-description", "create-component", "detach-instance",
            "set-locked", "set-blend-mode", "set-rotation", "clone-node", "remove-node", "reorder-node",
          ]);
          if (!item.operations.every((op) => isRecord(op) && typeof op.action === "string" && allowedActions.has(op.action))) return false;
          const categories = new Set(item.operations.map((op) => {
            const action = isRecord(op) ? op.action : "";
            if (["set-layout", "set-layout-sizing", "set-layout-positioning", "set-constraints", "set-layout-grid", "move-node", "resize-node", "set-rotation", "reorder-node", "set-visible", "set-clip-content", "clone-node", "remove-node", "create-component", "detach-instance"].includes(String(action))) return "structure";
            if (["set-fill", "set-text-style", "set-corner-radius", "set-stroke", "set-opacity", "set-blend-mode", "set-locked", "set-effects"].includes(String(action))) return "style";
            if (["update-text", "create-text", "create-rectangle", "create-ellipse", "create-line", "create-frame", "create-svg", "set-description"].includes(String(action))) return "content";
            return "other";
          }));
          const structuralCount = item.operations.filter((op) =>
            isRecord(op) && ["set-layout", "set-layout-sizing", "set-layout-positioning", "set-constraints", "set-layout-grid", "move-node", "resize-node", "set-rotation", "reorder-node", "clone-node", "create-component", "detach-instance"].includes(String(op.action))
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
        const operations = envelope.flatMap((item) => isRecord(item) && Array.isArray(item.operations) ? item.operations : []);
        const isAction = (operation: unknown, actions: string[]) => isRecord(operation) && actions.includes(String(operation.action));
        const structuralOperations = operations.filter((op) => isAction(op, ["set-layout", "set-layout-sizing", "set-layout-positioning", "set-constraints", "set-layout-grid", "move-node", "resize-node", "set-rotation", "reorder-node", "clone-node", "create-component", "detach-instance"])).length;
        const styleOperations = operations.filter((op) => isAction(op, ["set-fill", "set-text-style", "set-corner-radius", "set-stroke", "set-opacity", "set-visible", "set-locked", "set-blend-mode", "set-effects"])).length;
        const contentOperations = operations.filter((op) => isAction(op, ["update-text", "create-text", "create-rectangle", "create-ellipse", "create-line", "create-frame", "create-svg", "set-description", "rename-node"])).length;
        operationProfile = {
          variations: envelope.length,
          totalOperations: operations.length,
          structuralOperations,
          styleOperations,
          contentOperations,
          qualityGate: "passed",
        };
        validationPassed = true;
      }
      await recordModelLearningEvent({
        requestId: learningRequestId,
        capability: capability.id,
        modelId: candidate.id,
        modelTier: candidate.tier,
        outcome: validationPassed ? "validated" : "usable",
        validationPassed,
        latencyMs: attemptLatencyMs,
        estimatedCostUsd: estimatedCallCostUsd,
        observedCostUsd: attemptObservedCostUsd,
        promptTokens: attemptUsage.promptTokens ?? undefined,
        completionTokens: attemptUsage.completionTokens ?? undefined,
        totalTokens: attemptUsage.totalTokens ?? undefined,
        operationProfile,
      });
      const wasFallback = candidate.id !== selectedModel.id;
      return json(request, {
        content: result.content,
        capability: capability.id,
        capabilityLabel: capability.label,
        qualityTarget: capability.targetQuality,
        paidRequired: capability.paidRequired,
        estimatedCostUsd: estimatedCallCostUsd,
        observedCostUsd: result.observedCostUsd,
        usage: result.usage,
        estimatedCostBudgetUsd: capability.maxEstimatedCostUsd,
        estimatedReservedCostUsd: reservedEstimatedCostUsd,
        dailyBudget: dailyBudgetInfo ? await getDailyPaidModelBudgetStatus() : undefined,
        contextAssembly: {
          projectKey: assembledContext.projectKey,
          retrievedSources: knowledge.hits.length,
          retrievalMode: knowledge.retrievalMode || "none",
          knowledgeAvailable: knowledge.available,
          addedChars: assembledContext.addedChars,
        },
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
      const budgetGuardFailure = error instanceof PluginOpenRouterError && /daily (?:AI )?budget reached|daily spend ledger|daily paid-model budget/i.test(error.message);
      const validationFailure = variationIntent && error instanceof Error && /invalid variation-plan JSON|quality gate/i.test(error.message);
      const budgetBlocked = (status === 402 || budgetGuardFailure) && /budget|pricing|price metadata|daily|ledger/i.test(error instanceof Error ? error.message : "");
      await recordModelLearningEvent({
        requestId: learningRequestId,
        capability: capability.id,
        modelId: candidate.id,
        modelTier: candidate.tier,
        outcome: budgetBlocked ? "budget_blocked" : validationFailure ? "validation_failure" : "provider_error",
        validationPassed: false,
        latencyMs: attemptLatencyMs,
        estimatedCostUsd: estimatedCallCostUsd,
        observedCostUsd: attemptObservedCostUsd,
        promptTokens: attemptUsage.promptTokens ?? undefined,
        completionTokens: attemptUsage.completionTokens ?? undefined,
        totalTokens: attemptUsage.totalTokens ?? undefined,
        operationProfile,
        errorCategory: budgetBlocked ? "budget" : validationFailure ? "validation" : "provider",
      });
      if (status === 401 || status === 403 || status === 400 || budgetGuardFailure) break;
    }
  }

  const reason = lastError instanceof Error ? lastError.message : "No configured model returned a usable response.";
  const status = lastError instanceof PluginOpenRouterError ? lastError.status : 502;
  return json(request, { error: reason, capability: capability.id, estimatedCostBudgetUsd: capability.maxEstimatedCostUsd, estimatedReservedCostUsd: reservedEstimatedCostUsd, dailyBudget: await getDailyPaidModelBudgetStatus(), dailyBudgetLimitInr: 50, provider: "openrouter", model: selectedModel.id }, status >= 400 && status <= 599 ? status : 502);
}
