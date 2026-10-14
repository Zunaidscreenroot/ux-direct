import { CapabilityRegistry } from "./capability-registry";

export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  const freeCapability = (id: string, description: string) => ({
    id, description, version: "1.0", tags: [id.split(".")[0] ?? id], modalities: ["text", "structured-data"] as const,
    risk: "low" as const, costClass: "free-local" as const, requiresApproval: false,
    async run(input: Record<string, unknown>) {
      return { accepted: true, capabilityId: id, inputSummary: Object.keys(input), mode: "local-placeholder" };
    },
  });
  registry.register(freeCapability("requirements.extract", "Structure requirements and unresolved questions"));
  registry.register(freeCapability("context.retrieve", "Retrieve approved project context and evidence"));
  registry.register(freeCapability("ux.plan", "Create UX journey and screen plans"));
  registry.register(freeCapability("ux.critique", "Run deterministic UX quality checklist"));
  registry.register(freeCapability("review.package", "Prepare a human-review package"));
  registry.register({
    id: "figma.read",
    version: "1.0",
    description: "Read an allowlisted Figma file after security checks",
    tags: ["figma", "inspect", "design"],
    modalities: ["figma-nodes", "image"],
    available: () => false,
    risk: "medium",
    costClass: "external-read",
    requiresApproval: true,
    async run() { throw new Error("Figma adapter is not connected; no Figma action was performed."); },
  });
  return registry;
}
