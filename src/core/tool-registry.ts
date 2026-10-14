import type { UXHandId } from "./hand-contracts";

export type ToolOperation = "observe" | "research" | "reason" | "transform" | "write";
export type ToolRisk = "low" | "medium" | "high" | "critical";
export type ToolCostClass = "local" | "free-model" | "paid-model" | "external-service";
export type ToolModality = "text" | "image" | "figma-nodes" | "web-evidence" | "structured-data";

export interface ToolExecutionContext {
  requestId: string;
  workspaceId?: string;
  humanApproved: boolean;
  paidBudgetReserved: boolean;
  /** Server-approved tool IDs for this exact execution; required and fail-closed. */
  allowedToolIds: readonly string[];
}

export interface UXToolDefinition {
  id: string;
  version: string;
  description: string;
  operation: ToolOperation;
  tags: readonly string[];
  modalities: readonly ToolModality[];
  providedBy: UXHandId | "brain";
  risk: ToolRisk;
  costClass: ToolCostClass;
  requiresApproval: boolean;
  available: () => boolean;
  validateInput: (input: unknown) => { valid: boolean; errors: string[] };
  execute: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
}

export interface ToolDiscoveryRequest {
  intentTags?: readonly string[];
  requiredModalities?: readonly ToolModality[];
  allowedOperations?: readonly ToolOperation[];
  allowedRisk?: ToolRisk;
  /** Include write tools in candidate plans; execution remains separately gated. */
  includeWriteTools?: boolean;
  allowExternalServices?: boolean;
  includeUnavailable?: boolean;
}

export interface DiscoveredTool {
  id: string;
  version: string;
  description: string;
  operation: ToolOperation;
  tags: readonly string[];
  modalities: readonly ToolModality[];
  providedBy: UXToolDefinition["providedBy"];
  risk: ToolRisk;
  costClass: ToolCostClass;
  requiresApproval: boolean;
  available: boolean;
  intentMatch: number;
}

const RISK_RANK: Record<ToolRisk, number> = {
  low: 0, medium: 1, high: 2, critical: 3,
};

/**
 * Discoverable execution affordances, not a hard-coded list of what the Brain
 * is allowed to reason about. The Brain can compose plans from any compatible
 * tools returned here, while this registry enforces execution/policy boundaries.
 */
export class UXToolRegistry {
  private readonly tools = new Map<string, UXToolDefinition>();

  register(tool: UXToolDefinition): void {
    if (this.tools.has(tool.id)) throw new Error(`Tool already registered: ${tool.id}`);
    if (!tool.id.trim() || !tool.version.trim()) throw new Error("Tool id and version are required.");
    this.tools.set(tool.id, tool);
  }

  get(id: string): UXToolDefinition | undefined {
    return this.tools.get(id);
  }

  describe(): DiscoveredTool[] {
    return [...this.tools.values()].map((tool) => this.toCard(tool, []));
  }

  discover(request: ToolDiscoveryRequest = {}): DiscoveredTool[] {
    const intentTags = new Set((request.intentTags ?? []).map((tag) => tag.toLowerCase()));
    const requiredModalities = request.requiredModalities ?? [];
    const allowedOperations = request.allowedOperations
      ? new Set(request.allowedOperations)
      : undefined;
    const maxRisk = request.allowedRisk ? RISK_RANK[request.allowedRisk] : RISK_RANK.high;

    return [...this.tools.values()]
      .map((tool) => this.toCard(tool, [...intentTags]))
      .filter((tool) => {
        if (!request.includeUnavailable && !tool.available) return false;
        if (allowedOperations && !allowedOperations.has(tool.operation)) return false;
        if (RISK_RANK[tool.risk] > maxRisk) return false;
        if (tool.operation === "write" && request.includeWriteTools === false) return false;
        if (tool.costClass === "external-service" && !request.allowExternalServices) return false;
        if (!requiredModalities.every((modality) => tool.modalities.includes(modality))) return false;
        return true;
      })
      .sort((a, b) => b.intentMatch - a.intentMatch || RISK_RANK[a.risk] - RISK_RANK[b.risk]);
  }

  async invoke(
    id: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const tool = this.tools.get(id);
    if (!tool) throw new Error(`Unknown tool: ${id}`);
    if (!context.allowedToolIds.includes(id)) {
      throw new Error(`Tool is not allowed for this execution: ${id}`);
    }
    if (!tool.available()) throw new Error(`Tool is currently unavailable: ${id}`);
    const requiresExplicitApproval = tool.requiresApproval
      || tool.risk === "critical"
      || (tool.operation === "write" && tool.risk === "high");
    if (requiresExplicitApproval && !context.humanApproved) {
      throw new Error(`Human approval is required before invoking tool: ${id}`);
    }
    if ((tool.costClass === "paid-model" || tool.costClass === "external-service")
      && !context.paidBudgetReserved) {
      throw new Error(`Budget must be reserved before invoking paid/external tool: ${id}`);
    }
    const validation = tool.validateInput(input);
    if (!validation.valid) {
      throw new Error(`Invalid input for ${id}: ${validation.errors.join("; ")}`);
    }
    return tool.execute(input, context);
  }

  private toCard(
    tool: UXToolDefinition,
    intentTags: readonly string[],
  ): DiscoveredTool {
    const available = tool.available();
    const tags = new Set(tool.tags.map((tag) => tag.toLowerCase()));
    const intentMatch = intentTags.reduce((score, tag) => score + (tags.has(tag) ? 1 : 0), 0);
    return {
      id: tool.id,
      version: tool.version,
      description: tool.description,
      operation: tool.operation,
      tags: tool.tags,
      modalities: tool.modalities,
      providedBy: tool.providedBy,
      risk: tool.risk,
      costClass: tool.costClass,
      requiresApproval: tool.requiresApproval,
      available,
      intentMatch,
    };
  }
}
