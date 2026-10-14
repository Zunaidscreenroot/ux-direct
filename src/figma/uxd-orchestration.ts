import {
  callOpenRouterChat,
  reserveDailyPaidModelBudget,
  settleDailyPaidModelBudget,
  PluginOpenRouterError,
  type PluginChatMessage,
  type PluginModelDefinition,
  type DailyPaidBudgetReservation,
} from "@/src/figma/plugin-ai-api";
import { recordModelLearningEvent } from "@/src/figma/model-learning";
import {
  compactFigmaNodes,
  normalizeVisionEvidence,
  parseUxdirJson,
  validateUxdirVariationPlan,
  UXD_IR_VERSION,
  type UxdIrNode,
  type UxdIrTrace,
  type UxdIrTraceStage,
} from "@/src/figma/uxd-ir";
import { persistUxdIrTrace } from "@/src/figma/uxd-traces";

type AvailableModel = PluginModelDefinition & {
  provider: "openrouter";
  available: boolean;
  reason: string;
};

type NumericUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type UxdVariationPipelineInput = {
  runId: string;
  projectKey: string;
  capability: string;
  mode: "variation" | "audit";
  userIntent: string;
  pageName: string;
  frameItems: unknown[];
  frameWidth?: number;
  frameHeight?: number;
  screenshotDataUrl: string;
  variationCount: number;
  visionModels: AvailableModel[];
  reasoningModels: AvailableModel[];
  maxEstimatedCostUsd: number;
};

export type UxdVisionReasoningPipelineResult = {
  content: string;
  model: string;
  modelTier: "free-tier" | "paid";
  latencyMs: number;
  usage: NumericUsage;
  estimatedCostUsd: number;
  observedCostUsd: number | null;
  trace: UxdIrTrace;
  dailyBudgetInfo: DailyPaidBudgetReservation | null;
};

function cleanIntent(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, 600);
}

function estimateInputTokens(messages: PluginChatMessage[]): number {
  let chars = 0;
  let imageCount = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      chars += message.content.length;
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") chars += part.text.length;
      else if (part.type === "image_url") imageCount += 1;
    }
  }
  // Base64 itself is transport data, not prompt text. Reserve a conservative
  // visual-token allowance instead of counting each base64 character as a token.
  return Math.ceil(chars / 4) + imageCount * 6000;
}

function sumUsage(current: NumericUsage, next: NumericUsage): NumericUsage {
  const sum = (a: number | null, b: number | null) => a === null && b === null ? null : (a ?? 0) + (b ?? 0);
  return {
    promptTokens: sum(current.promptTokens, next.promptTokens),
    completionTokens: sum(current.completionTokens, next.completionTokens),
    totalTokens: sum(current.totalTokens, next.totalTokens),
  };
}

function addObservedCost(current: number | null, next: number | null): number | null {
  return current === null && next === null ? null : (current ?? 0) + (next ?? 0);
}

function priceEstimate(model: AvailableModel, messages: PluginChatMessage[], maxTokens: number): number {
  if (model.tier === "free-tier") return 0;
  if (model.inputUsdPerMillion === null || model.outputUsdPerMillion === null) {
    throw new PluginOpenRouterError("Model " + model.id + " has no verified pricing and is excluded from automatic orchestration.", 402);
  }
  const inputTokens = estimateInputTokens(messages);
  return Math.max(0.000001, ((inputTokens * model.inputUsdPerMillion) + (maxTokens * model.outputUsdPerMillion)) / 1_000_000);
}

function visionSystemPrompt(): string {
  return [
    "You are the UX Direct Vision Stone. Produce compact UXD-IR only; never write user-facing prose and never create Figma operations.",
    "Return exactly one JSON object with this shape: {",
    '"v":1,"stage":"vision",',
    '"frame":{"width":360,"height":800},',
    '"facts":[{"key":"payment_total","value":"₹10,000","source":"pixels"}],',
    '"elements":[{"id":"EXACT_EXISTING_NODE_ID","role":"primary_cta","text":"Pay ₹10,000","bounds":[0,0,320,48]}],',
    '"observations":[{"kind":"cta_hierarchy","targets":["EXACT_EXISTING_NODE_ID"],"evidence":"Visible short evidence","confidence":0.0}],',
    '"uncertainties":[]}',
    "Facts must distinguish sources: pixels, layer_tree, or inference. Use only IDs from the supplied compact node index; do not invent node IDs. Coordinates are [x,y,width,height] in Figma pixels if known. Keep evidence concise, preserve all visible financial values and dates exactly, and label uncertainty instead of guessing.",
    "Do not output hidden reasoning, markdown, commentary, or a proposed solution. Return observable evidence only.",
  ].join("\n");
}

function reasoningSystemPrompt(variationCount: number): string {
  return [
    "You are the UX Direct Reasoning Stone. Convert UXD-IR evidence and the user's goal into a native Figma operation plan.",
    "Return ONLY JSON: {\"variations\":[{\"name\":\"Short frame name\",\"rationale\":\"One-sentence design direction\",\"operations\":[...]}]}.",
    "Return exactly " + variationCount + " variation(s). Each must have 6–16 operations, at least two structural/layout operations, and operations spanning at least two of structure/style/content. A renamed clone or copy-only change fails.",
    "Allowed action names: update-text, rename-node, set-fill, set-stroke, set-opacity, set-visible, set-locked, set-blend-mode, move-node, resize-node, set-rotation, set-corner-radius, set-text-style, set-layout, set-layout-sizing, set-layout-positioning, set-constraints, set-clip-content, set-layout-grid, set-effects, set-description, create-component, detach-instance, reorder-node, clone-node, remove-node, create-text, create-rectangle, create-ellipse, create-line, create-frame, create-svg.",
    "Use action-specific fields. Existing-node actions use targetId; creation actions use parentId pointing to a FRAME in the node index. update-text requires a TEXT target. set-layout requires a FRAME target. Colors must be #RRGGBB. Use only supplied node IDs. Never remove the source root. Only remove a child on explicit request.",
    "Preserve loan totals, EMI amounts, dates, rates, product terms and required disclosures unless explicitly asked to change them. If the request asks to change a CTA, update the button label while preserving its meaning and don't alter financial facts.",
    "Do not return explanations outside the JSON. The native plugin executes nothing until its action safety checks pass and the user confirms.",
  ].join("\n");
}

function auditReasoningSystemPrompt(): string {
  return [
    "You are the UX Direct Reasoning Stone for an explicitly requested visual audit.",
    "Use only the supplied compact UXD-IR evidence and selected-frame node index. Natural-language findings are the deliverable for an audit.",
    "Return 4–6 concise actionable findings. Each finding must include visible evidence, why it matters to the customer, and a practical recommendation.",
    "Consider hierarchy, legibility, spacing/alignment, CTA clarity, financial-content clarity, accessibility and recovery where the supplied evidence supports them.",
    "Preserve every supplied financial amount, due date, rate and term. Distinguish observations from assumptions. Do not claim regulatory compliance or invent policy rules.",
    "Do not reveal or claim access to hidden private chain-of-thought. Do not create Figma operations and do not claim edits were applied.",
  ].join("\n");
}

function getNodeSize(items: unknown[], width?: number, height?: number) {
  const root = items.find((value) => value !== null && typeof value === "object" && (value as Record<string, unknown>).type === "FRAME") as Record<string, unknown> | undefined;
  const resolvedWidth = width ?? (root && typeof root.width === "number" ? root.width : undefined);
  const resolvedHeight = height ?? (root && typeof root.height === "number" ? root.height : undefined);
  return {
    ...(typeof resolvedWidth === "number" && Number.isFinite(resolvedWidth) ? { width: resolvedWidth } : {}),
    ...(typeof resolvedHeight === "number" && Number.isFinite(resolvedHeight) ? { height: resolvedHeight } : {}),
  };
}

export async function runUxdVisionReasoningPipeline(input: UxdVariationPipelineInput): Promise<UxdVisionReasoningPipelineResult> {
  const nodes: UxdIrNode[] = compactFigmaNodes(input.frameItems, 160);
  if (!nodes.length) throw new PluginOpenRouterError("UXD-IR could not build a safe node index from the selected frame.", 400);
  if (!input.screenshotDataUrl.startsWith("data:image/jpeg;base64,")) {
    throw new PluginOpenRouterError("UXD-IR vision stage requires the validated selected-frame JPEG.", 400);
  }

  const traceStages: UxdIrTraceStage[] = [];
  const allowedNodeIds = new Set(nodes.map((node) => node.id));
  const frame = { pageName: input.pageName.slice(0, 160), size: getNodeSize(input.frameItems, input.frameWidth, input.frameHeight), nodes };
  let estimatedCostUsd = 0;
  let observedCostUsd: number | null = null;
  let latestReservation: DailyPaidBudgetReservation | null = null;
  let latencyMs = 0;
  let usage: NumericUsage = { promptTokens: null, completionTokens: null, totalTokens: null };
  let visionEvidence: ReturnType<typeof normalizeVisionEvidence> = null;
  let budgetBlocked = false;
  let paidStageCallUsed = false;
  let lastVisionError = "No approved vision model returned usable UXD-IR evidence.";

  const imageUserMessage: PluginChatMessage = {
    role: "user",
    content: [
      { type: "text", text: JSON.stringify({ goal: cleanIntent(input.userIntent), frame, instruction: "Inspect screenshot pixels and return only UXD-IR v1 evidence." }) },
      { type: "image_url", image_url: { url: input.screenshotDataUrl } },
    ],
  };

  for (let index = 0; index < input.visionModels.length && index < 4; index += 1) {
    const model = input.visionModels[index];
    if (!model.available || !model.supportsImages) continue;
    const messages: PluginChatMessage[] = [
      { role: "system", content: visionSystemPrompt() },
      imageUserMessage,
    ];
    let stageEstimate = 0;
    let requestId = input.runId + ":vision:" + index;
    try {
      stageEstimate = priceEstimate(model, messages, 900);
      if (estimatedCostUsd + stageEstimate > input.maxEstimatedCostUsd) {
        lastVisionError = "Vision stage stopped by the per-task estimated cost ceiling.";
        continue;
      }
      if (model.tier === "paid") {
        if (budgetBlocked || (input.mode === "audit" && paidStageCallUsed)) continue;
        const reservation = await reserveDailyPaidModelBudget({ estimatedCostUsd: stageEstimate, model: model.id, requestId });
        latestReservation = reservation;
        if (!reservation.allowed) {
          budgetBlocked = true;
          lastVisionError = "Daily AI budget reached before a paid vision stage; no additional paid call was sent.";
          continue;
        }
      }
      estimatedCostUsd += stageEstimate;
      if (model.tier === "paid") paidStageCallUsed = true;
      const started = Date.now();
      const result = await callOpenRouterChat(model.id, messages, { maxTokens: 900, temperature: 0.05, timeoutMs: 30000, reasoningEffort: "low" });
      latencyMs += Date.now() - started;
      usage = sumUsage(usage, result.usage);
      observedCostUsd = addObservedCost(observedCostUsd, result.observedCostUsd);
      if (model.tier === "paid" && result.observedCostUsd !== null) {
        await settleDailyPaidModelBudget({ requestId, actualCostUsd: result.observedCostUsd });
      }
      const parsed = parseUxdirJson(result.content);
      const normalized = normalizeVisionEvidence(parsed, allowedNodeIds, getNodeSize(input.frameItems, input.frameWidth, input.frameHeight));
      if (!normalized) throw new PluginOpenRouterError("Vision model returned invalid UXD-IR v1 evidence.", 502);
      visionEvidence = normalized;
      traceStages.push({
        role: "vision", status: "completed", model: result.model, latencyMs: result.latencyMs,
        ...(result.usage.promptTokens !== null ? { promptTokens: result.usage.promptTokens } : {}),
        ...(result.usage.completionTokens !== null ? { completionTokens: result.usage.completionTokens } : {}),
        ...(result.usage.totalTokens !== null ? { totalTokens: result.usage.totalTokens } : {}),
        estimatedCostUsd: stageEstimate, observedCostUsd: result.observedCostUsd,
      });
      await recordModelLearningEvent({
        requestId, capability: input.capability, modelId: result.model, modelTier: model.tier,
        outcome: "usable", validationPassed: true, latencyMs: result.latencyMs,
        estimatedCostUsd: stageEstimate, observedCostUsd: result.observedCostUsd,
        promptTokens: result.usage.promptTokens ?? undefined, completionTokens: result.usage.completionTokens ?? undefined,
        totalTokens: result.usage.totalTokens ?? undefined,
        operationProfile: { uxdIrVersion: UXD_IR_VERSION, stage: "vision", evidenceItems: normalized.facts.length + normalized.elements.length + normalized.observations.length },
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Vision stage failed.";
      lastVisionError = message;
      traceStages.push({ role: "vision", status: "failed", model: model.id, estimatedCostUsd: stageEstimate, note: /budget|pricing|ledger/i.test(message) ? "budget_or_pricing" : /json|UXD-IR|empty/i.test(message) ? "invalid_evidence" : "provider_error" });
      await recordModelLearningEvent({
        requestId, capability: input.capability, modelId: model.id, modelTier: model.tier,
        outcome: /budget|pricing|ledger/i.test(message) ? "budget_blocked" : /json|UXD-IR|empty/i.test(message) ? "validation_failure" : "provider_error",
        validationPassed: false, estimatedCostUsd: stageEstimate, errorCategory: /budget|pricing|ledger/i.test(message) ? "budget" : /json|UXD-IR|empty/i.test(message) ? "validation" : "provider",
        operationProfile: { uxdIrVersion: UXD_IR_VERSION, stage: "vision" },
      });
      if (model.tier === "paid" && /daily AI budget|spend ledger|budget reached/i.test(message)) budgetBlocked = true;
    }
  }

  if (!visionEvidence) {
    const failedTrace: UxdIrTrace = {
      v: UXD_IR_VERSION, runId: input.runId, projectKey: input.projectKey, capability: input.capability,
      mode: input.mode === "audit" ? "explain" : "action", status: "failed", intentSummary: cleanIntent(input.userIntent), createdAt: new Date().toISOString(),
      stages: [...traceStages, { role: "reasoning", status: "skipped", note: "vision_evidence_unavailable" }],
    };
    await persistUxdIrTrace(failedTrace, { totalPromptTokens: usage.promptTokens, totalCompletionTokens: usage.completionTokens, estimatedCostUsd, observedCostUsd });
    throw new PluginOpenRouterError(lastVisionError, budgetBlocked ? 402 : 502);
  }

  const reasoningContext = {
    v: UXD_IR_VERSION,
    stage: "reasoning-input",
    goal: cleanIntent(input.userIntent),
    mode: input.mode,
    ...(input.mode === "variation" ? { variationCount: Math.max(1, Math.min(3, Math.floor(input.variationCount))) } : {}),
    frame,
    vision: visionEvidence,
    guardrails: ["preserve_financial_facts", "use_only_known_node_ids", "native_executor_validates_all_mutations",
      ...(input.mode === "variation" ? ["source_frame_unchanged"] : ["audit_is_read_only"])],
  };
  const plannerUserMessage: PluginChatMessage = {
    role: "user",
    content: JSON.stringify(reasoningContext),
  };
  const plannerMessages: PluginChatMessage[] = [
    { role: "system", content: input.mode === "audit" ? auditReasoningSystemPrompt() : reasoningSystemPrompt(reasoningContext.variationCount as number) },
    plannerUserMessage,
  ];

  const reasoningModels = input.reasoningModels.filter((model) => model.available).slice(0, 5);
  let finalPlan: Record<string, unknown> | null = null;
  let finalContent = "";
  let finalModel: AvailableModel | null = null;
  let lastPlanError = "No approved reasoning model returned a valid operation plan.";
  let paidPlanBudgetBlocked = false;

  for (let index = 0; index < reasoningModels.length; index += 1) {
    const model = reasoningModels[index];
    const requestId = input.runId + ":reasoning:" + index;
    let stageEstimate = 0;
    try {
      if (model.tier === "paid" && (paidPlanBudgetBlocked || budgetBlocked || (input.mode === "audit" && paidStageCallUsed))) continue;
      stageEstimate = priceEstimate(model, plannerMessages, 3000);
      if (estimatedCostUsd + stageEstimate > input.maxEstimatedCostUsd) {
        lastPlanError = "Reasoning stage stopped by the per-task estimated cost ceiling.";
        continue;
      }
      if (model.tier === "paid") {
        const reservation = await reserveDailyPaidModelBudget({ estimatedCostUsd: stageEstimate, model: model.id, requestId });
        latestReservation = reservation;
        if (!reservation.allowed) {
          paidPlanBudgetBlocked = true;
          lastPlanError = "Daily AI budget reached before a paid reasoning stage; no additional paid call was sent.";
          continue;
        }
      }
      estimatedCostUsd += stageEstimate;
      if (model.tier === "paid") paidStageCallUsed = true;
      const started = Date.now();
      const result = await callOpenRouterChat(model.id, plannerMessages, { maxTokens: 3000, temperature: 0.1, timeoutMs: 30000, reasoningEffort: "low" });
      latencyMs += Date.now() - started;
      usage = sumUsage(usage, result.usage);
      observedCostUsd = addObservedCost(observedCostUsd, result.observedCostUsd);
      if (model.tier === "paid" && result.observedCostUsd !== null) {
        await settleDailyPaidModelBudget({ requestId, actualCostUsd: result.observedCostUsd });
      }
      let gate: ReturnType<typeof validateUxdirVariationPlan> | null = null;
      if (input.mode === "audit") {
        finalContent = result.content.trim();
        if (!finalContent) throw new PluginOpenRouterError("Reasoning model returned an empty audit.", 502);
      } else {
        const parsed = parseUxdirJson(result.content);
        gate = validateUxdirVariationPlan(parsed, reasoningContext.variationCount as number);
        if (!parsed || !gate.valid) throw new PluginOpenRouterError("Reasoning model returned an operation plan outside UXD-IR quality gates (" + (gate.reason || "invalid_json") + ").", 502);
        finalPlan = parsed;
        finalContent = JSON.stringify(parsed);
      }
      finalModel = model;
      traceStages.push({
        role: "reasoning", status: "completed", model: result.model, latencyMs: result.latencyMs,
        ...(result.usage.promptTokens !== null ? { promptTokens: result.usage.promptTokens } : {}),
        ...(result.usage.completionTokens !== null ? { completionTokens: result.usage.completionTokens } : {}),
        ...(result.usage.totalTokens !== null ? { totalTokens: result.usage.totalTokens } : {}),
        estimatedCostUsd: stageEstimate, observedCostUsd: result.observedCostUsd,
        note: input.mode === "audit" ? "readable_audit_generated_from_uxd_ir" : "operation_plan_passed_structural_gate",
      });
      await recordModelLearningEvent({
        requestId, capability: input.capability, modelId: result.model, modelTier: model.tier,
        outcome: input.mode === "audit" ? "usable" : "validated", validationPassed: input.mode !== "audit", latencyMs: result.latencyMs,
        estimatedCostUsd: stageEstimate, observedCostUsd: result.observedCostUsd,
        promptTokens: result.usage.promptTokens ?? undefined, completionTokens: result.usage.completionTokens ?? undefined,
        totalTokens: result.usage.totalTokens ?? undefined,
        operationProfile: { uxdIrVersion: UXD_IR_VERSION, stage: "reasoning", mode: input.mode, ...(gate ? { variations: gate.variationCount, operations: gate.operationCount } : {}) },
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Reasoning stage failed.";
      lastPlanError = message;
      traceStages.push({ role: "reasoning", status: "failed", model: model.id, estimatedCostUsd: stageEstimate, note: /budget|pricing|ledger/i.test(message) ? "budget_or_pricing" : /json|quality gates|operation plan/i.test(message) ? "invalid_plan" : "provider_error" });
      await recordModelLearningEvent({
        requestId, capability: input.capability, modelId: model.id, modelTier: model.tier,
        outcome: /budget|pricing|ledger/i.test(message) ? "budget_blocked" : /json|quality gates|operation plan/i.test(message) ? "validation_failure" : "provider_error",
        validationPassed: false, estimatedCostUsd: stageEstimate, errorCategory: /budget|pricing|ledger/i.test(message) ? "budget" : /json|quality gates|operation plan/i.test(message) ? "validation" : "provider",
        operationProfile: { uxdIrVersion: UXD_IR_VERSION, stage: "reasoning" },
      });
      if (model.tier === "paid" && /daily AI budget|spend ledger|budget reached/i.test(message)) paidPlanBudgetBlocked = true;
    }
  }

  if (!finalModel || (input.mode === "variation" && !finalPlan)) {
    const failedTrace: UxdIrTrace = {
      v: UXD_IR_VERSION, runId: input.runId, projectKey: input.projectKey, capability: input.capability,
      mode: input.mode === "audit" ? "explain" : "action", status: "failed", intentSummary: cleanIntent(input.userIntent), createdAt: new Date().toISOString(),
      stages: [...traceStages, { role: "execution", status: "skipped", note: input.mode === "audit" ? "audit_failed_before_summary" : "operation_plan_unavailable" }],
      artifacts: { visionEvidence },
    };
    await persistUxdIrTrace(failedTrace, { totalPromptTokens: usage.promptTokens, totalCompletionTokens: usage.completionTokens, estimatedCostUsd, observedCostUsd });
    throw new PluginOpenRouterError(lastPlanError, paidPlanBudgetBlocked ? 402 : 502);
  }

  const trace: UxdIrTrace = {
    v: UXD_IR_VERSION, runId: input.runId, projectKey: input.projectKey, capability: input.capability,
    mode: input.mode === "audit" ? "explain" : "action",
    status: input.mode === "audit" ? "completed" : "awaiting_confirmation",
    intentSummary: cleanIntent(input.userIntent), createdAt: new Date().toISOString(),
    stages: [...traceStages, input.mode === "audit"
      ? { role: "execution", status: "skipped", note: "audit_only_no_mutation" }
      : { role: "execution", status: "awaiting_confirmation", note: "Native Figma executor is waiting for user confirmation and will validate operation scope before applying." }],
    artifacts: { visionEvidence, ...(finalPlan ? { operationPlan: finalPlan } : {}) },
  };
  await persistUxdIrTrace(trace, { totalPromptTokens: usage.promptTokens, totalCompletionTokens: usage.completionTokens, estimatedCostUsd, observedCostUsd });

  return {
    content: input.mode === "audit" ? finalContent : JSON.stringify(finalPlan),
    model: finalModel.id,
    modelTier: finalModel.tier,
    latencyMs,
    usage,
    estimatedCostUsd,
    observedCostUsd,
    trace,
    dailyBudgetInfo: latestReservation,
  };
}
