/**
 * Product World Model primitives.
 *
 * This is not "just RAG": facts/decisions carry provenance, authority, scope,
 * status and relationships so planning can reason over a versioned product state.
 * The in-memory store is an executable reference implementation; production
 * storage can use Postgres without changing the contracts.
 */

export type WorldFactStatus =
  | "observed"
  | "inferred"
  | "verified"
  | "approved"
  | "disputed"
  | "deprecated";

export type WorldFactKind =
  | "requirement"
  | "decision"
  | "user-need"
  | "journey-state"
  | "component-pattern"
  | "constraint"
  | "research-finding"
  | "risk"
  | "artifact"
  | "preference";

export type WorldFactScope =
  | { kind: "global"; namespace: string; licenceApproved: boolean }
  | { kind: "client"; namespace: string; clientId: string }
  | { kind: "project"; namespace: string; clientId: string; projectId: string };

export interface WorldEvidence {
  sourceId: string;
  sourceType: "document" | "figma-node" | "url" | "human-decision" | "test-result" | "telemetry";
  excerpt?: string;
  capturedAt: string;
  contentHash?: string;
}

export interface WorldFact {
  id: string;
  kind: WorldFactKind;
  subject: string;
  predicate: string;
  object: unknown;
  statement: string;
  scope: WorldFactScope;
  status: WorldFactStatus;
  confidence: number;
  tags: readonly string[];
  evidence: readonly WorldEvidence[];
  version: number;
  observedAt: string;
  validUntil?: string;
  supersedesFactId?: string;
}

export interface WorldRelation {
  id: string;
  fromFactId: string;
  relation: "depends-on" | "contradicts" | "supersedes" | "supports" | "implements" | "measured-by";
  toFactId: string;
  evidenceIds: readonly string[];
}

export interface WorldQuery {
  clientId: string;
  projectId: string;
  clientNamespace: string;
  projectNamespace: string;
  sharedKnowledgeNamespaces: readonly string[];
  tags?: readonly string[];
  kinds?: readonly WorldFactKind[];
  includeInferred?: boolean;
  now?: string;
}

export interface WorldQueryResult {
  facts: WorldFact[];
  omitted: {
    outOfScope: number;
    unapprovedGlobal: number;
    disputedOrDeprecated: number;
    stale: number;
    lowConfidence: number;
  };
}

const AUTHORITATIVE_STATUSES = new Set<WorldFactStatus>(["verified", "approved"]);
const BLOCKED_STATUSES = new Set<WorldFactStatus>(["disputed", "deprecated"]);

function isVisibleToWorkspace(fact: WorldFact, query: WorldQuery): boolean {
  if (fact.scope.kind === "project") {
    return fact.scope.projectId === query.projectId
      && fact.scope.clientId === query.clientId
      && fact.scope.namespace === query.projectNamespace;
  }
  if (fact.scope.kind === "client") {
    return fact.scope.clientId === query.clientId
      && fact.scope.namespace === query.clientNamespace;
  }
  return query.sharedKnowledgeNamespaces.includes(fact.scope.namespace)
    && fact.scope.licenceApproved;
}

/**
 * Scope filtering is a security boundary, not a relevance score. Out-of-scope
 * facts are never made visible merely because their text is semantically similar.
 * Generic global facts must be both in an approved namespace and licence-approved.
 */
export class InMemoryWorldModel {
  private readonly facts = new Map<string, WorldFact>();
  private readonly relations = new Map<string, WorldRelation>();

  upsertFact(fact: WorldFact): void {
    if (!fact.id.trim()) throw new Error("World fact requires an id.");
    if (!fact.statement.trim()) throw new Error("World fact requires a statement.");
    if (!Number.isFinite(fact.confidence) || fact.confidence < 0 || fact.confidence > 1) {
      throw new Error("World fact confidence must be between 0 and 1.");
    }
    const current = this.facts.get(fact.id);
    if (current && fact.version <= current.version) {
      throw new Error(`World fact version must increase for ${fact.id}.`);
    }
    this.facts.set(fact.id, structuredClone(fact));
  }

  upsertRelation(relation: WorldRelation): void {
    if (!this.facts.has(relation.fromFactId) || !this.facts.has(relation.toFactId)) {
      throw new Error("Both relation endpoints must exist in the world model.");
    }
    this.relations.set(relation.id, structuredClone(relation));
  }

  getFact(id: string): WorldFact | undefined {
    const fact = this.facts.get(id);
    return fact ? structuredClone(fact) : undefined;
  }

  getRelationsForFact(id: string, query: WorldQuery): WorldRelation[] {
    const visibleIds = new Set(this.query(query).facts.map((fact) => fact.id));
    if (!visibleIds.has(id)) return [];
    return [...this.relations.values()]
      .filter((relation) =>
        (relation.fromFactId === id || relation.toFactId === id)
        && visibleIds.has(relation.fromFactId)
        && visibleIds.has(relation.toFactId))
      .map((relation) => structuredClone(relation));
  }

  query(query: WorldQuery): WorldQueryResult {
    const result: WorldFact[] = [];
    const omitted: WorldQueryResult["omitted"] = {
      outOfScope: 0,
      unapprovedGlobal: 0,
      disputedOrDeprecated: 0,
      stale: 0,
      lowConfidence: 0,
    };
    const now = Date.parse(query.now ?? new Date().toISOString());
    const requestedTags = new Set((query.tags ?? []).map((tag) => tag.toLowerCase()));
    const requestedKinds = query.kinds ? new Set(query.kinds) : undefined;

    for (const fact of this.facts.values()) {
      if (fact.scope.kind === "global"
        && query.sharedKnowledgeNamespaces.includes(fact.scope.namespace)
        && !fact.scope.licenceApproved) {
        omitted.unapprovedGlobal += 1;
        continue;
      }
      if (!isVisibleToWorkspace(fact, query)) {
        omitted.outOfScope += 1;
        continue;
      }
      if (BLOCKED_STATUSES.has(fact.status)) {
        omitted.disputedOrDeprecated += 1;
        continue;
      }
      if (fact.validUntil && Date.parse(fact.validUntil) < now) {
        omitted.stale += 1;
        continue;
      }
      if (fact.status === "inferred" && !query.includeInferred) {
        omitted.lowConfidence += 1;
        continue;
      }
      if (!query.includeInferred && !AUTHORITATIVE_STATUSES.has(fact.status)
        && fact.scope.kind !== "project") {
        omitted.lowConfidence += 1;
        continue;
      }
      if (requestedKinds && !requestedKinds.has(fact.kind)) continue;
      if (requestedTags.size > 0) {
        const factTags = new Set(fact.tags.map((tag) => tag.toLowerCase()));
        if (![...requestedTags].some((tag) => factTags.has(tag))) continue;
      }
      result.push(structuredClone(fact));
    }

    // Deterministic ordering: authority first, then confidence, then newest version.
    result.sort((a, b) => {
      const rank = (status: WorldFactStatus) => status === "approved" ? 4
        : status === "verified" ? 3
        : status === "observed" ? 2
        : status === "inferred" ? 1 : 0;
      return rank(b.status) - rank(a.status)
        || b.confidence - a.confidence
        || b.version - a.version;
    });
    return { facts: result, omitted };
  }

  listRelations(query: WorldQuery): WorldRelation[] {
    const visibleIds = new Set(this.query(query).facts.map((fact) => fact.id));
    return [...this.relations.values()]
      .filter((relation) =>
        visibleIds.has(relation.fromFactId) && visibleIds.has(relation.toFactId))
      .map((relation) => structuredClone(relation));
  }
}
