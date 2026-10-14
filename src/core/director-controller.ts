import type { WorkspaceId } from "./hand-contracts";
import {
  FixtureWorkspaceContextResolver,
  type WorkspaceContextResolver,
  type UXWorkspaceContext,
} from "./workspace-context";
import {
  InMemoryWorldModel,
  type WorldFact,
  type WorldQuery,
} from "./world-model";
import {
  UXToolRegistry,
  type DiscoveredTool,
  type ToolDiscoveryRequest,
} from "./tool-registry";

export interface DirectorTask {
  requestId: string;
  objective: string;
  workspaceId?: WorkspaceId;
  intentTags?: readonly string[];
  requiredModalities?: ToolDiscoveryRequest["requiredModalities"];
  constraints?: Readonly<Record<string, unknown>>;
  toolPolicy?: ToolDiscoveryRequest;
}

export interface DirectorPlanningContext {
  requestId: string;
  objective: string;
  workspace?: UXWorkspaceContext;
  currentWorld: readonly WorldFact[];
  availableTools: readonly DiscoveredTool[];
  constraints: Readonly<Record<string, unknown>>;
  planningDirectives: readonly string[];
}

export interface DirectorPlanStep {
  id: string;
  objective: string;
  toolId: string;
  input: unknown;
  dependsOn: readonly string[];
  expectedEvidence: readonly string[];
  /** Optional planner annotation; the server validator recomputes approval requirements. */
  approvalGate?: boolean;
}

export interface DirectorPlan {
  version: "1.0";
  summary: string;
  rationale: string;
  assumptions: readonly string[];
  unresolvedQuestions: readonly string[];
  steps: readonly DirectorPlanStep[];
  acceptanceCriteria: readonly string[];
}

export interface DirectorPlanValidation {
  valid: boolean;
  errors: string[];
  stepsRequiringApproval: string[];
}

export interface BuildDirectorContextDependencies {
  workspaceResolver?: WorkspaceContextResolver;
  worldModel: InMemoryWorldModel;
  tools: UXToolRegistry;
}

const BASE_DIRECTIVES = [
  "Infer the smallest useful plan from the current task and evidence; do not follow a mandatory client workflow.",
  "Discover only tools that materially improve the outcome; do not invoke every available specialist.",
  "Separate verified facts, approved decisions, observations, inferences and unresolved questions.",
  "Treat workspace metadata as context and scope, not as a separate intelligence or a fixed workflow.",
  "Prefer deterministic validation to another model call when it can settle the question.",
  "Respect tool availability, input schemas, required modality, approval gates and budget reservations.",
  "Every mutating step must produce execution evidence and be followed by verification before success is reported.",
] as const;

function worldQueryFor(task: DirectorTask, workspace: UXWorkspaceContext): WorldQuery {
  return {
    clientId: workspace.clientId,
    projectId: workspace.id,
    clientNamespace: workspace.knowledgeScope.clientNamespace,
    projectNamespace: workspace.knowledgeScope.projectNamespace,
    sharedKnowledgeNamespaces: workspace.knowledgeScope.sharedKnowledgeNamespaces,
    tags: task.intentTags,
    includeInferred: false,
  };
}

/**
 * Builds the bounded, task-specific slice the planner needs. The world model is
 * scope-filtered before it reaches the planner. If no workspace is known, the
 * Brain can still reason with generic tools and supplied task content, then ask
 * for workspace context only if it materially affects the task.
 */
export async function buildDirectorPlanningContext(
  task: DirectorTask,
  dependencies: BuildDirectorContextDependencies,
): Promise<DirectorPlanningContext> {
  const workspaceResolver = dependencies.workspaceResolver ?? new FixtureWorkspaceContextResolver();
  const workspace = task.workspaceId
    ? await workspaceResolver.resolve(task.workspaceId)
    : undefined;

  if (task.workspaceId && !workspace) {
    throw new Error(`Workspace context was requested but not found: ${task.workspaceId}`);
  }

  const currentWorld = workspace
    ? dependencies.worldModel.query(worldQueryFor(task, workspace)).facts
    : [];

  const toolPolicy: ToolDiscoveryRequest = {
    ...(task.toolPolicy ?? {}),
    ...(task.intentTags ? { intentTags: task.intentTags } : {}),
    ...(task.requiredModalities ? { requiredModalities: task.requiredModalities } : {}),
  };
  const availableTools = dependencies.tools.discover(toolPolicy);

  return {
    requestId: task.requestId,
    objective: task.objective,
    workspace,
    currentWorld,
    availableTools,
    constraints: task.constraints ?? {},
    planningDirectives: BASE_DIRECTIVES,
  };
}

function detectCycle(
  steps: readonly DirectorPlanStep[],
): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const step = byId.get(id);
    for (const dependency of step?.dependsOn ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return steps.some((step) => visit(step.id));
}

/**
 * Validates a model-proposed plan without prescribing its workflow. The only
 * fixed rules here are tool existence, dependency integrity, bounded plan size
 * and execution-policy gates.
 */
export function validateDirectorPlan(
  plan: DirectorPlan,
  context: DirectorPlanningContext,
  options: { maxSteps?: number; humanApprovedToolIds?: readonly string[] } = {},
): DirectorPlanValidation {
  const errors: string[] = [];
  const stepsRequiringApproval: string[] = [];
  const maxSteps = options.maxSteps ?? 16;
  const approvedTools = new Set(options.humanApprovedToolIds ?? []);
  const toolsById = new Map(context.availableTools.map((tool) => [tool.id, tool]));
  const stepsById = new Map<string, DirectorPlanStep>();

  if (plan.version !== "1.0") errors.push("Unsupported plan version.");
  if (!plan.summary.trim()) errors.push("Plan summary is required.");
  if (plan.steps.length === 0) errors.push("Plan must contain at least one executable step.");
  if (plan.steps.length > maxSteps) errors.push(`Plan exceeds the maximum of ${maxSteps} steps.`);

  for (const step of plan.steps) {
    if (!step.id.trim()) errors.push("Every plan step needs an id.");
    if (stepsById.has(step.id)) errors.push(`Duplicate step id: ${step.id}`);
    stepsById.set(step.id, step);

    const tool = toolsById.get(step.toolId);
    if (!tool) {
      errors.push(`Step ${step.id} uses a tool that was not discovered or is not permitted: ${step.toolId}`);
      continue;
    }
    if ((tool.operation === "write" && (tool.requiresApproval || tool.risk === "high" || tool.risk === "critical"))
      || tool.risk === "critical") {
      if (!approvedTools.has(tool.id)) stepsRequiringApproval.push(step.id);
    }
    if (!step.objective.trim()) errors.push(`Step ${step.id} needs an objective.`);
    if (step.expectedEvidence.length === 0) {
      errors.push(`Step ${step.id} must define evidence needed to verify its result.`);
    }
  }

  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!stepsById.has(dependency)) {
        errors.push(`Step ${step.id} depends on unknown step: ${dependency}`);
      }
    }
  }
  if (detectCycle(plan.steps)) errors.push("Plan dependency graph contains a cycle.");

  return { valid: errors.length === 0, errors, stepsRequiringApproval };
}
