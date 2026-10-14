/**
 * UX Direct Intermediate Representation (UXD-IR).
 *
 * A compact, versioned protocol for exchanging visual evidence, decisions and
 * native Figma operation plans between specialist stages. This is deliberately
 * not model-private chain-of-thought: it contains bounded evidence and artifacts
 * that can be validated, stored and explained later.
 */
export const UXD_IR_VERSION = 1 as const;

export type UxdIrStageRole = "vision" | "reasoning" | "execution" | "memory" | "explanation";
export type UxdIrStageStatus = "started" | "completed" | "failed" | "skipped" | "awaiting_confirmation";

export type UxdIrNode = {
  id: string;
  type: string;
  name: string;
  bounds?: [number, number, number, number];
  text?: string;
};

export type UxdIrTraceStage = {
  role: UxdIrStageRole;
  status: UxdIrStageStatus;
  model?: string;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  observedCostUsd?: number | null;
  note?: string;
};

export type UxdIrTrace = {
  v: typeof UXD_IR_VERSION;
  runId: string;
  projectKey: string;
  capability: string;
  mode: "action" | "explain";
  status: "running" | "awaiting_confirmation" | "completed" | "failed" | "cancelled";
  intentSummary: string;
  createdAt: string;
  stages: UxdIrTraceStage[];
  artifacts?: {
    visionEvidence?: unknown;
    operationPlan?: unknown;
  };
};

type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maxChars: number): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, maxChars)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Flatten Figma node trees to a bounded node index. The model sees stable IDs
 * and only the properties needed to target operations, not a duplicated tree.
 */
export function compactFigmaNodes(input: unknown, maxNodes = 160): UxdIrNode[] {
  const limit = Math.max(1, Math.min(240, Math.floor(maxNodes)));
  const output: UxdIrNode[] = [];
  const visitedObjects = new WeakSet<object>();
  const seenIds = new Set<string>();

  const visit = (value: unknown) => {
    if (output.length >= limit || !isRecord(value)) return;
    if (visitedObjects.has(value)) return;
    visitedObjects.add(value);

    const id = boundedString(value.id, 200);
    const type = boundedString(value.type, 48);
    const name = boundedString(value.name, 160);
    if (id && type && !seenIds.has(id)) {
      seenIds.add(id);
      const boundsRecord = isRecord(value.absoluteBoundingBox) ? value.absoluteBoundingBox : value;
      const x = finite(boundsRecord.x);
      const y = finite(boundsRecord.y);
      const width = finite(boundsRecord.width);
      const height = finite(boundsRecord.height);
      const bounds = x !== undefined && y !== undefined && width !== undefined && height !== undefined
        ? [x, y, width, height] as [number, number, number, number]
        : undefined;
      const text = boundedString(value.characters ?? value.text, 200);
      output.push({
        id,
        type,
        name: name || type,
        ...(bounds ? { bounds } : {}),
        ...(text ? { text } : {}),
      });
    }

    if (isRecord(value.tree)) visit(value.tree);
    if (Array.isArray(value.children)) {
      for (const child of value.children) {
        if (output.length >= limit) break;
        visit(child);
      }
    }
  };

  if (Array.isArray(input)) {
    for (const item of input) {
      if (output.length >= limit) break;
      visit(item);
    }
  } else {
    visit(input);
  }
  return output;
}

/** Parse JSON-only model output, accepting a single fenced JSON block. */
export function parseUxdirJson(text: string): JsonRecord | null {
  const cleaned = text.trim()
    .replace(/^\u0060\u0060\u0060(?:json)?\s*/i, "")
    .replace(/\s*\u0060\u0060\u0060$/, "");
  try {
    const value: unknown = JSON.parse(cleaned);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export type UxdIrVisionEvidence = {
  v: typeof UXD_IR_VERSION;
  stage: "vision";
  frame: { width?: number; height?: number };
  facts: Array<{ key: string; value: string | number | boolean; source: "pixels" | "layer_tree" | "inference" }>;
  elements: Array<{ id: string; role?: string; text?: string; bounds?: [number, number, number, number] }>;
  observations: Array<{ kind: string; targets: string[]; evidence: string; confidence: number }>;
  uncertainties: string[];
};

/**
 * Validate and normalize vision output before another model or executor sees it.
 * Unknown node IDs are discarded rather than propagated into an action plan.
 */
export function normalizeVisionEvidence(
  value: unknown,
  allowedNodeIds: ReadonlySet<string>,
  frameSize?: { width?: number; height?: number },
): UxdIrVisionEvidence | null {
  if (!isRecord(value) || value.v !== UXD_IR_VERSION || value.stage !== "vision") return null;
  const facts = Array.isArray(value.facts) ? value.facts.slice(0, 32).flatMap((fact) => {
    if (!isRecord(fact) || typeof fact.key !== "string") return [];
    const rawValue = fact.value;
    if (!(typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean")) return [];
    const source = fact.source === "pixels" || fact.source === "layer_tree" ? fact.source : "inference";
    return [{ key: fact.key.slice(0, 80), value: typeof rawValue === "string" ? rawValue.slice(0, 180) : rawValue, source }];
  }) : [];
  const elements = Array.isArray(value.elements) ? value.elements.slice(0, 100).flatMap((element) => {
    if (!isRecord(element) || typeof element.id !== "string" || !allowedNodeIds.has(element.id)) return [];
    const boundsValue = Array.isArray(element.bounds) && element.bounds.length === 4 &&
      element.bounds.every((part) => typeof part === "number" && Number.isFinite(part))
      ? element.bounds.slice(0, 4) as [number, number, number, number]
      : undefined;
    return [{
      id: element.id,
      ...(typeof element.role === "string" ? { role: element.role.slice(0, 80) } : {}),
      ...(typeof element.text === "string" ? { text: element.text.slice(0, 180) } : {}),
      ...(boundsValue ? { bounds: boundsValue } : {}),
    }];
  }) : [];
  const observations = Array.isArray(value.observations) ? value.observations.slice(0, 32).flatMap((observation) => {
    if (!isRecord(observation) || typeof observation.kind !== "string" || typeof observation.evidence !== "string") return [];
    const targets = Array.isArray(observation.targets)
      ? observation.targets.filter((target): target is string => typeof target === "string" && allowedNodeIds.has(target)).slice(0, 12)
      : [];
    const confidence = typeof observation.confidence === "number" && Number.isFinite(observation.confidence)
      ? Math.max(0, Math.min(1, observation.confidence))
      : 0.5;
    return [{ kind: observation.kind.slice(0, 60), targets, evidence: observation.evidence.slice(0, 220), confidence }];
  }) : [];
  const uncertainties = Array.isArray(value.uncertainties)
    ? value.uncertainties.filter((entry): entry is string => typeof entry === "string").slice(0, 12).map((entry) => entry.slice(0, 180))
    : [];
  if (!facts.length && !elements.length && !observations.length) return null;
  const frame = isRecord(value.frame) ? value.frame : {};
  const width = typeof frame.width === "number" && Number.isFinite(frame.width)
    ? Math.max(1, Math.min(10000, frame.width)) : frameSize?.width;
  const height = typeof frame.height === "number" && Number.isFinite(frame.height)
    ? Math.max(1, Math.min(10000, frame.height)) : frameSize?.height;
  return {
    v: UXD_IR_VERSION,
    stage: "vision",
    frame: { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) },
    facts,
    elements,
    observations,
    uncertainties,
  };
}

/** Validate only the compact variation envelope and its structural minimum. */
export function validateUxdirVariationPlan(value: unknown, expectedCount: number): { valid: boolean; reason?: string; variationCount: number; operationCount: number } {
  if (!isRecord(value) || !Array.isArray(value.variations)) {
    return { valid: false, reason: "missing_variations", variationCount: 0, operationCount: 0 };
  }
  const variations = value.variations;
  if (variations.length !== expectedCount) {
    return { valid: false, reason: "variation_count", variationCount: variations.length, operationCount: 0 };
  }
  const allowedActions = new Set([
    "update-text", "rename-node", "set-fill", "move-node", "resize-node",
    "create-text", "create-rectangle", "create-ellipse", "create-line", "create-frame", "create-svg",
    "set-text-style", "set-corner-radius", "set-stroke", "set-opacity", "set-visible",
    "set-layout", "set-layout-sizing", "set-layout-positioning", "set-constraints", "set-clip-content",
    "set-layout-grid", "set-effects", "set-description", "create-component", "detach-instance",
    "set-locked", "set-blend-mode", "set-rotation", "clone-node", "remove-node", "reorder-node",
  ]);
  const structuralActions = new Set([
    "set-layout", "set-layout-sizing", "set-layout-positioning", "set-constraints", "set-layout-grid",
    "move-node", "resize-node", "set-rotation", "reorder-node", "clone-node", "create-component", "detach-instance",
  ]);
  const styleActions = new Set([
    "set-fill", "set-text-style", "set-corner-radius", "set-stroke", "set-opacity", "set-blend-mode",
    "set-locked", "set-effects", "set-visible",
  ]);
  const contentActions = new Set([
    "update-text", "create-text", "create-rectangle", "create-ellipse", "create-line", "create-frame",
    "create-svg", "set-description", "rename-node",
  ]);
  let operationCount = 0;
  for (const variation of variations) {
    if (!isRecord(variation) || typeof variation.name !== "string" || !variation.name.trim() ||
      !Array.isArray(variation.operations) || variation.operations.length < 6 || variation.operations.length > 16) {
      return { valid: false, reason: "operation_count_or_name", variationCount: variations.length, operationCount };
    }
    const operations = variation.operations;
    if (!operations.every((operation) => isRecord(operation) && typeof operation.action === "string" && allowedActions.has(operation.action))) {
      return { valid: false, reason: "unsupported_action", variationCount: variations.length, operationCount };
    }
    const categories = new Set(operations.map((operation) => {
      const action = isRecord(operation) ? String(operation.action) : "";
      return structuralActions.has(action) ? "structure" : styleActions.has(action) ? "style" : contentActions.has(action) ? "content" : "other";
    }));
    const structuralCount = operations.filter((operation) => isRecord(operation) && structuralActions.has(String(operation.action))).length;
    if (categories.size < 2 || structuralCount < 2) {
      return { valid: false, reason: "structural_quality_gate", variationCount: variations.length, operationCount };
    }
    operationCount += operations.length;
  }
  return { valid: true, variationCount: variations.length, operationCount };
}

export function summarizeUxdIrTrace(trace: Pick<UxdIrTrace, "runId" | "capability" | "mode" | "status" | "stages">): string {
  const completed = trace.stages.filter((stage) => stage.status === "completed").length;
  const failed = trace.stages.filter((stage) => stage.status === "failed").length;
  return [
    "Run " + trace.runId,
    "Capability: " + trace.capability,
    "Mode: " + trace.mode,
    "Status: " + trace.status,
    "Stages completed: " + completed,
    "Stages failed: " + failed,
  ].join(" · ");
}

/** Stable, coarse error labels only; raw request text and prompts are never logged. */
export function classifyUxdIrError(message: string): string {
  if (/budget|pricing|ledger/i.test(message)) return "budget";
  if (/timeout|timed out|abort/i.test(message)) return "timeout";
  if (/json|schema|quality gate|validation/i.test(message)) return "validation";
  if (/rate limit|quota|429/i.test(message)) return "rate_limit";
  return "provider";
}
