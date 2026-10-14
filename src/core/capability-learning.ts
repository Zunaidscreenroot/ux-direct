/**
 * Evidence-backed learning primitives for the universal UX Brain.
 * Stores compact outcomes, not raw prompts, screenshots, design payloads, or chain-of-thought.
 */
import type { UXWorkspaceContext } from "./workspace-context";
import type { WorldFactScope } from "./world-model";

export type LearningOutcome = "accepted" | "corrected" | "rejected" | "failed" | "blocked";
export type LearningEvidenceKind =
  | "deterministic-check"
  | "postcondition"
  | "human-review"
  | "human-correction"
  | "provider-telemetry";

export interface CapabilityLearningEvent {
  id: string;
  capabilityId: string;
  strategyId: string;
  scope: WorldFactScope;
  outcome: LearningOutcome;
  verificationPassed: boolean;
  qualityScore: number;
  correctionCount: number;
  evidenceKinds: readonly LearningEvidenceKind[];
  capturedAt: string;
  estimatedCostInr?: number;
  latencyMs?: number;
}

export interface CapabilityLearningEventInput extends CapabilityLearningEvent {
  /** Cross-client operational learning requires explicit reuse approval. */
  approvedForCrossClientReuse?: boolean;
}

export interface CapabilityLearningRepository {
  append(event: CapabilityLearningEvent): void;
  list(): CapabilityLearningEvent[];
}

export class InMemoryCapabilityLearningRepository implements CapabilityLearningRepository {
  private readonly events = new Map<string, CapabilityLearningEvent>();

  append(event: CapabilityLearningEvent): void {
    if (this.events.has(event.id)) throw new Error(`Learning event already exists: ${event.id}`);
    this.events.set(event.id, structuredClone(event));
  }

  list(): CapabilityLearningEvent[] {
    return [...this.events.values()].map((event) => structuredClone(event));
  }
}

export interface LearnedCapabilityPreference {
  capabilityId: string;
  strategyId: string;
  sampleSize: number;
  verifiedAcceptanceRate: number;
  validationPassRate: number;
  averageQuality: number;
  correctionRate: number;
  averageCostInr?: number;
  averageLatencyMs?: number;
  confidence: number;
  score: number;
  evidenceSummary: string;
}

export interface CapabilityLearningQuery {
  workspace?: UXWorkspaceContext;
  candidateCapabilityIds: readonly string[];
  minimumObservations?: number;
  minimumVerifiedAcceptanceRate?: number;
  minimumValidationPassRate?: number;
  minimumAverageQuality?: number;
}

function isVisible(event: CapabilityLearningEvent, workspace: UXWorkspaceContext | undefined): boolean {
  if (!workspace) return false;

  if (event.scope.kind === "project") {
    return event.scope.clientId === workspace.clientId
      && event.scope.projectId === workspace.id
      && event.scope.namespace === workspace.knowledgeScope.projectNamespace;
  }

  if (event.scope.kind === "client") {
    return event.scope.clientId === workspace.clientId
      && event.scope.namespace === workspace.knowledgeScope.clientNamespace;
  }

  return event.scope.licenceApproved
    && workspace.knowledgeScope.sharedKnowledgeNamespaces.includes(event.scope.namespace);
}

function isVerifiedAcceptance(event: CapabilityLearningEvent): boolean {
  return event.outcome === "accepted"
    && (event.verificationPassed || event.evidenceKinds.includes("human-review"));
}

function average(values: number[]): number | undefined {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : undefined;
}

/**
 * Repeated verified outcomes can influence advisory ranking. This loop cannot
 * grant permissions, approve writes, expand allowlists, or override budget policy.
 * Inject a persistent repository when production storage is connected.
 */
export class CapabilityLearningLoop {
  constructor(private readonly repository: CapabilityLearningRepository = new InMemoryCapabilityLearningRepository()) {}

  record(input: CapabilityLearningEventInput): CapabilityLearningEvent {
    if (!input.id.trim() || !input.capabilityId.trim() || !input.strategyId.trim()) {
      throw new Error("Learning event id, capability id, and strategy id are required.");
    }
    if (!Number.isFinite(input.qualityScore) || input.qualityScore < 0 || input.qualityScore > 1) {
      throw new Error("Learning quality score must be between 0 and 1.");
    }
    if (!Number.isInteger(input.correctionCount) || input.correctionCount < 0) {
      throw new Error("Learning correction count must be a non-negative integer.");
    }
    if (!Number.isFinite(Date.parse(input.capturedAt))) {
      throw new Error("Learning event requires a valid capturedAt timestamp.");
    }
    if (!Array.isArray(input.evidenceKinds) || input.evidenceKinds.length === 0) {
      throw new Error("Learning event requires at least one evidence kind.");
    }
    for (const [name, value] of [["estimatedCostInr", input.estimatedCostInr], ["latencyMs", input.latencyMs]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`Learning ${name} must be a non-negative finite number.`);
      }
    }
    if (input.outcome === "accepted" && !input.verificationPassed
      && !input.evidenceKinds.includes("human-review")) {
      throw new Error("An accepted outcome needs passing verification or human-review evidence.");
    }
    if (input.scope.kind === "global"
      && (!input.scope.licenceApproved || input.approvedForCrossClientReuse !== true)) {
      throw new Error("Cross-client learning requires an approved global scope and explicit reuse approval.");
    }

    // Copy only allowlisted fields; accidental raw prompt/design fields cannot
    // enter the ledger through this contract.
    const event: CapabilityLearningEvent = {
      id: input.id,
      capabilityId: input.capabilityId,
      strategyId: input.strategyId,
      scope: structuredClone(input.scope),
      outcome: input.outcome,
      verificationPassed: input.verificationPassed,
      qualityScore: input.qualityScore,
      correctionCount: input.correctionCount,
      evidenceKinds: [...input.evidenceKinds],
      capturedAt: input.capturedAt,
      ...(input.estimatedCostInr !== undefined ? { estimatedCostInr: input.estimatedCostInr } : {}),
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
    };
    this.repository.append(event);
    return structuredClone(event);
  }

  recommendCapabilities(query: CapabilityLearningQuery): LearnedCapabilityPreference[] {
    const candidates = new Set(query.candidateCapabilityIds);
    if (candidates.size === 0) return [];

    const minimumObservations = query.minimumObservations ?? 3;
    const minimumAcceptance = query.minimumVerifiedAcceptanceRate ?? 0.8;
    const minimumValidation = query.minimumValidationPassRate ?? 0.9;
    const minimumQuality = query.minimumAverageQuality ?? 0.8;
    const groups = new Map<string, CapabilityLearningEvent[]>();

    for (const event of this.repository.list()) {
      if (!candidates.has(event.capabilityId) || !isVisible(event, query.workspace)) continue;
      const key = `${event.capabilityId}\u0000${event.strategyId}`;
      const group = groups.get(key) ?? [];
      group.push(event);
      groups.set(key, group);
    }

    const recommendations: LearnedCapabilityPreference[] = [];
    for (const events of groups.values()) {
      const sampleSize = events.length;
      if (sampleSize < minimumObservations) continue;
      const verifiedAcceptanceRate = events.filter(isVerifiedAcceptance).length / sampleSize;
      const validationPassRate = events.filter((event) => event.verificationPassed).length / sampleSize;
      const averageQuality = average(events.map((event) => event.qualityScore)) ?? 0;
      const correctionRate = events.filter((event) => event.correctionCount > 0).length / sampleSize;
      if (verifiedAcceptanceRate < minimumAcceptance
        || validationPassRate < minimumValidation
        || averageQuality < minimumQuality) continue;

      const first = events[0];
      if (!first) continue;
      const costs = events.flatMap((event) => event.estimatedCostInr === undefined ? [] : [event.estimatedCostInr]);
      const latencies = events.flatMap((event) => event.latencyMs === undefined ? [] : [event.latencyMs]);
      const score = (0.55 * verifiedAcceptanceRate + 0.25 * validationPassRate + 0.2 * averageQuality)
        * (1 - Math.min(0.5, correctionRate * 0.5));

      recommendations.push({
        capabilityId: first.capabilityId,
        strategyId: first.strategyId,
        sampleSize,
        verifiedAcceptanceRate,
        validationPassRate,
        averageQuality,
        correctionRate,
        ...(average(costs) !== undefined ? { averageCostInr: average(costs) } : {}),
        ...(average(latencies) !== undefined ? { averageLatencyMs: average(latencies) } : {}),
        confidence: Math.min(0.99, sampleSize / (sampleSize + 2)),
        score,
        evidenceSummary: `${sampleSize} scoped runs; ${Math.round(verifiedAcceptanceRate * 100)}% verified acceptance; ${Math.round(validationPassRate * 100)}% validation pass`,
      });
    }

    return recommendations.sort((a, b) => b.score - a.score
      || (a.averageCostInr ?? Number.POSITIVE_INFINITY) - (b.averageCostInr ?? Number.POSITIVE_INFINITY));
  }
}
