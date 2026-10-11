import type { CapabilityDefinition } from "./types";

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityDefinition>();

  register(capability: CapabilityDefinition): void {
    if (this.capabilities.has(capability.id)) {
      throw new Error(`Capability already registered: ${capability.id}`);
    }
    this.capabilities.set(capability.id, capability);
  }

  get(id: string): CapabilityDefinition | undefined {
    return this.capabilities.get(id);
  }

  list(): Array<Pick<CapabilityDefinition, "id" | "description" | "risk" | "costClass" | "requiresApproval">> {
    return [...this.capabilities.values()].map(({ id, description, risk, costClass, requiresApproval }) => ({
      id, description, risk, costClass, requiresApproval,
    }));
  }

  async execute(id: string, input: Record<string, unknown>, options: { humanApproved?: boolean } = {}) {
    const capability = this.get(id);
    if (!capability) throw new Error(`Unknown capability: ${id}`);
    if (capability.costClass === "paid-model") {
      throw new Error("Paid model capabilities are disabled until explicitly configured and approved.");
    }
    if (capability.costClass === "external-write" && !options.humanApproved) {
      throw new Error("External write capability requires explicit human approval.");
    }
    if (capability.requiresApproval && !options.humanApproved) {
      throw new Error(`Capability requires human approval: ${id}`);
    }
    return capability.run(input);
  }
}
