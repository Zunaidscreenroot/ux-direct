/**
 * Shared contract for independently installable Figma "hands".
 *
 * The server owns orchestration, model routing, retrieval and budget decisions.
 * Plugin code owns local Figma context gathering and execution of approved operations.
 */

export const UX_HAND_IDS = [
  "cockpit",
  "wireframe-foundry",
  "ux-auditor",
  "benchmark-lab",
  "journey-architect",
  "quality-handoff",
] as const;

export type UXHandId = (typeof UX_HAND_IDS)[number];

/**
 * Workspace IDs are data, not a closed enum. A new client/project can be
 * registered in the workspace store without adding new Brain code paths.
 */
export type ProjectProfileId = string;

export type ProjectLifecycle = "brownfield" | "greenfield";
export type HandRole = "primary" | "specialist";
export type HandInvocation = "default" | "on-demand" | "foundation-only";
export type TaskRisk = "low" | "medium" | "high";
export type OutputKind =
  | "text"
  | "research-report"
  | "journey-spec"
  | "design-system-manifest"
  | "figma-mutations"
  | "audit-report"
  | "handoff-package";

export interface UXHandDefinition {
  id: UXHandId;
  name: string;
  role: HandRole;
  description: string;
  pluginPackage: string;
  invocation: HandInvocation;
  capabilities: readonly string[];
  outputs: readonly OutputKind[];
}

export interface HandTaskConstraints {
  editableFigmaOutput?: boolean;
  preserveOriginals?: boolean;
  maxRunCostInr?: number;
  maxAttempts?: number;
  requireHumanApprovalForWrites?: boolean;
}

export interface HandTaskContext {
  selectedFrameIds?: string[];
  referenceFrameIds?: string[];
  sourceIds?: string[];
  viewport?: { width: number; height: number; platform?: "mobile" | "desktop" | "responsive" };
  approvedKitVersion?: string;
}

/**
 * Wire contract shared by all plugins and the Brain API.
 * Never put provider API keys, provider-selected model IDs, or client-built
 * system prompts in this request. Those decisions belong to the server.
 */
export interface HandTaskRequest {
  contractVersion: "1.0";
  requestId: string;
  idempotencyKey: string;
  handId: UXHandId;
  capabilityId: string;
  projectId: ProjectProfileId;
  objective: string;
  userPrompt: string;
  context?: HandTaskContext;
  constraints?: HandTaskConstraints;
}

export interface HandTaskResult {
  contractVersion: "1.0";
  requestId: string;
  handId: UXHandId;
  capabilityId: string;
  projectId: ProjectProfileId;
  status: "completed" | "needs-review" | "blocked" | "failed";
  summary: string;
  outputs: Array<{
    kind: OutputKind;
    label: string;
    artifactRef?: string;
    version?: string;
  }>;
  validation: {
    passed: boolean;
    checksPassed: number;
    checksFailed: number;
    findings: Array<{
      code: string;
      severity: "info" | "warning" | "error";
      message: string;
      sourceRef?: string;
    }>;
  };
  usage?: {
    estimatedCostInr?: number;
    reportedCostInr?: number;
    inputTokens?: number;
    outputTokens?: number;
    attemptCount: number;
  };
}

/** These definitions describe architecture/target plugin boundaries. */
export const UX_HANDS: readonly UXHandDefinition[] = [
  {
    id: "cockpit",
    name: "Cockpit",
    role: "primary",
    description: "Always-available daily hand for screen creation, redesign, routine audits and iteration.",
    pluginPackage: "plugins/cockpit",
    invocation: "default",
    capabilities: [
      "screen.generate",
      "screen.redesign",
      "screen.variations",
      "screen.adapt-responsive",
      "pattern.reuse",
      "ux.audit-routine",
      "design.iterate",
    ],
    outputs: ["figma-mutations", "audit-report", "text"],
  },
  {
    id: "wireframe-foundry",
    name: "Wireframe Foundry",
    role: "specialist",
    description: "Generates a reusable high-fidelity UX wireframe kit; it is not the final production UI design system.",
    pluginPackage: "plugins/wireframe-foundry",
    invocation: "on-demand",
    capabilities: [
      "wireframe-foundry.analyse-references",
      "wireframe-foundry.generate-foundations",
      "wireframe-foundry.generate-components",
      "wireframe-foundry.generate-bfci-patterns",
      "wireframe-foundry.export-manifest",
    ],
    outputs: ["design-system-manifest", "figma-mutations", "text"],
  },
  {
    id: "ux-auditor",
    name: "UX Auditor",
    role: "specialist",
    description: "Runs deep and independent heuristic, visual, form, content, trust and edge-state audits.",
    pluginPackage: "plugins/ux-auditor",
    invocation: "on-demand",
    capabilities: [
      "ux.audit-heuristic",
      "ux.audit-visual",
      "ux.audit-forms",
      "ux.audit-content",
      "ux.audit-trust",
      "ux.audit-journey-coverage",
    ],
    outputs: ["audit-report", "text"],
  },
  {
    id: "benchmark-lab",
    name: "Benchmark Lab",
    role: "specialist",
    description: "Collects source-backed public/approved research and compares product flows and UX patterns.",
    pluginPackage: "plugins/benchmark-lab",
    invocation: "on-demand",
    capabilities: [
      "benchmark.research",
      "benchmark.compare-flows",
      "benchmark.compare-patterns",
      "benchmark.identify-opportunities",
    ],
    outputs: ["research-report", "text"],
  },
  {
    id: "journey-architect",
    name: "Journey Architect",
    role: "specialist",
    description: "Structures requirements, information architecture, end-to-end journeys, states and recovery branches.",
    pluginPackage: "plugins/journey-architect",
    invocation: "on-demand",
    capabilities: [
      "journey.decompose-requirements",
      "journey.map",
      "journey.model-states",
      "journey.specify-screens",
      "journey.validate-coverage",
    ],
    outputs: ["journey-spec", "text"],
  },
  {
    id: "quality-handoff",
    name: "UX Quality & Handoff",
    role: "specialist",
    description: "Runs final structural/visual/readiness checks and prepares implementation-facing handoff.",
    pluginPackage: "plugins/quality-handoff",
    invocation: "on-demand",
    capabilities: [
      "quality.visual-regression",
      "quality.design-system-conformance",
      "quality.accessibility",
      "quality.responsive",
      "handoff.prepare",
    ],
    outputs: ["audit-report", "handoff-package", "text"],
  },
] as const;

export function getHandDefinition(id: UXHandId): UXHandDefinition {
  const hand = UX_HANDS.find((candidate) => candidate.id === id);
  if (!hand) throw new Error(`Unknown UX hand: ${id}`);
  return hand;
}
