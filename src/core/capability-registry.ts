import type { CapabilityDefinition, CapabilityModality, CapabilityRisk } from "./types";

export interface CapabilityDiscoveryRequest {
  intentTags?: readonly string[];
  requiredModalities?: readonly CapabilityModality[];
  allowedRisk?: CapabilityRisk;
  includeUnavailable?: boolean;
  includeExternalWrites?: boolean;
}

export interface DiscoveredCapability {
  id: string;
  version: string;
  description: string;
  tags: readonly string[];
  modalities: readonly CapabilityModality[];
  risk: CapabilityRisk;
  costClass: CapabilityDefinition["costClass"];
  requiresApproval: boolean;
  available: boolean;
  intentMatch: number;
}

export interface CapabilityRegistryOptions {
  /** Defaults to false. Enabling this is server configuration, not model intent. */
  allowPaidModelCapabilities?: boolean;
}

export interface CapabilityExecutionOptions {
  humanApproved?: boolean;
  paidBudgetReserved?: boolean;
  /** Server-generated allowlist for the current request; when supplied it fails closed. */
  allowedCapabilityIds?: readonly string[];
}

const RISK_RANK: Record<CapabilityRisk, number> = { low: 0, medium: 1, high: 2 };

/** High-level capability inventory with runtime discovery and policy-gated execution. */
export class CapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityDefinition>();
  private readonly allowPaidModelCapabilities: boolean;

  constructor(options: CapabilityRegistryOptions = {}) {
    this.allowPaidModelCapabilities = options.allowPaidModelCapabilities ?? false;
  }

  register(capability: CapabilityDefinition): void {
    if (!capability.id.trim() || !capability.description.trim()) {
      throw new Error("Capability id and description are required.");
    }
    if (this.capabilities.has(capability.id)) {
      throw new Error(`Capability already registered: ${capability.id}`);
    }
    this.capabilities.set(capability.id, capability);
  }

  get(id: string): CapabilityDefinition | undefined {
    return this.capabilities.get(id);
  }

  list(): DiscoveredCapability[] {
    return this.discover({ includeUnavailable: true, includeExternalWrites: true });
  }

  discover(request: CapabilityDiscoveryRequest = {}): DiscoveredCapability[] {
    const requestedTags = new Set((request.intentTags ?? []).map((tag) => tag.toLowerCase()));
    const requestedModalities = request.requiredModalities ?? [];
    const maxRisk = request.allowedRisk ? RISK_RANK[request.allowedRisk] : RISK_RANK.high;

    return [...this.capabilities.values()]
      .map((capability) => this.toCard(capability, requestedTags))
      .filter((card) => {
        if (!request.includeUnavailable && !card.available) return false;
        if (RISK_RANK[card.risk] > maxRisk) return false;
        if (card.costClass === "paid-model" && !this.allowPaidModelCapabilities) return false;
        if (card.costClass === "external-write" && request.includeExternalWrites !== true) return false;
        if (!requestedModalities.every((modality) => card.modalities.includes(modality))) return false;
        return true;
      })
      .sort((a, b) => b.intentMatch - a.intentMatch
        || RISK_RANK[a.risk] - RISK_RANK[b.risk]
        || a.id.localeCompare(b.id));
  }

  async execute(
    id: string,
    input: Record<string, unknown>,
    options: CapabilityExecutionOptions = {},
  ): Promise<Record<string, unknown>> {
    const capability = this.get(id);
    if (!capability) throw new Error(`Unknown capability: ${id}`);
    if (options.allowedCapabilityIds && !options.allowedCapabilityIds.includes(id)) {
      throw new Error(`Capability is not allowed for this execution: ${id}`);
    }
    if (capability.available && !capability.available()) {
      throw new Error(`Capability is currently unavailable: ${id}`);
    }
    if (capability.costClass === "paid-model") {
      if (!this.allowPaidModelCapabilities) {
        throw new Error("Paid model capabilities are disabled until explicitly configured and approved.");
      }
      if (!options.paidBudgetReserved) {
        throw new Error("Budget must be reserved before invoking a paid model capability.");
      }
    }
    if (capability.costClass === "external-write" && !options.humanApproved) {
      throw new Error("External write capability requires explicit human approval.");
    }
    if (capability.requiresApproval && !options.humanApproved) {
      throw new Error(`Capability requires human approval: ${id}`);
    }
    if (capability.validateInput) {
      const validation = capability.validateInput(input);
      if (!validation.valid) throw new Error(`Invalid input for ${id}: ${validation.errors.join("; ")}`);
    }
    return capability.run(input);
  }

  private toCard(
    capability: CapabilityDefinition,
    requestedTags: ReadonlySet<string>,
  ): DiscoveredCapability {
    const tags = capability.tags ?? [];
    const tagSet = new Set(tags.map((tag) => tag.toLowerCase()));
    const available = capability.available ? capability.available() : true;
    return {
      id: capability.id,
      version: capability.version ?? "1.0",
      description: capability.description,
      tags,
      modalities: capability.modalities ?? ["text"],
      risk: capability.risk,
      costClass: capability.costClass,
      requiresApproval: capability.requiresApproval,
      available,
      intentMatch: [...requestedTags].reduce((score, tag) => score + Number(tagSet.has(tag)), 0),
    };
  }
}
