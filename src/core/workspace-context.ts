import type { WorkspaceId } from "./hand-contracts";

/**
 * Workspace metadata is configuration, not a project-specific brain or workflow.
 * Runtime planning must be driven by the current world state, evidence, discovered
 * tools and policy—not by a hardcoded DMI/Ujjivan step sequence.
 */
export interface UXWorkspaceContext {
  id: WorkspaceId;
  clientId: string;
  displayName: string;
  knowledgeScope: {
    /** Approved client-level material may be shared within this client. */
    clientNamespace: string;
    /** Project-specific and confidential artifacts stay inside this namespace. */
    projectNamespace: string;
    /** Generic, licensed/approved knowledge packs can be shared across clients. */
    sharedKnowledgeNamespaces: readonly string[];
    /** Cross-project retrieval is false unless a separate explicit policy says otherwise. */
    allowCrossProjectMemory: false;
  };
  knownArtifactRefs?: readonly string[];
  approvedFoundationRefs?: readonly string[];
  metadata?: Readonly<Record<string, string>>;
}

/**
 * Small seed fixtures for local development and tests.
 * Production workspace context should be loaded from the workspace store; adding
 * a client must not require adding a new planner branch or recompiling the Brain.
 */
export const WORKSPACE_FIXTURES: readonly UXWorkspaceContext[] = [
  {
    id: "dmi-hfc",
    clientId: "dmi",
    displayName: "DMI Housing Finance",
    knowledgeScope: {
      clientNamespace: "client:dmi",
      projectNamespace: "project:dmi-hfc",
      sharedKnowledgeNamespaces: ["bfci-generic"],
      allowCrossProjectMemory: false,
    },
    metadata: { contextSource: "initial-seed" },
  },
  {
    id: "dmi-finance",
    clientId: "dmi",
    displayName: "DMI Finance",
    knowledgeScope: {
      clientNamespace: "client:dmi",
      projectNamespace: "project:dmi-finance",
      sharedKnowledgeNamespaces: ["bfci-generic"],
      allowCrossProjectMemory: false,
    },
    metadata: { contextSource: "initial-seed" },
  },
  {
    id: "dmi-wealth",
    clientId: "dmi",
    displayName: "DMI Wealth",
    knowledgeScope: {
      clientNamespace: "client:dmi",
      projectNamespace: "project:dmi-wealth",
      sharedKnowledgeNamespaces: ["bfci-generic"],
      allowCrossProjectMemory: false,
    },
    metadata: { operatingMode: "existing-product" },
  },
  {
    id: "ujjivan-sfb",
    clientId: "ujjivan",
    displayName: "Ujjivan Small Finance Bank",
    knowledgeScope: {
      clientNamespace: "client:ujjivan",
      projectNamespace: "project:ujjivan-sfb",
      sharedKnowledgeNamespaces: ["bfci-generic"],
      allowCrossProjectMemory: false,
    },
    metadata: { contextSource: "initial-seed" },
  },
] as const;

export interface WorkspaceContextResolver {
  resolve(id: WorkspaceId): Promise<UXWorkspaceContext | undefined>;
}

export class FixtureWorkspaceContextResolver implements WorkspaceContextResolver {
  constructor(private readonly contexts: readonly UXWorkspaceContext[] = WORKSPACE_FIXTURES) {}

  async resolve(id: WorkspaceId): Promise<UXWorkspaceContext | undefined> {
    return this.contexts.find((context) => context.id === id);
  }
}

export async function getWorkspaceContext(
  id: WorkspaceId,
  resolver: WorkspaceContextResolver = new FixtureWorkspaceContextResolver(),
): Promise<UXWorkspaceContext> {
  const context = await resolver.resolve(id);
  if (!context) throw new Error(`Unknown workspace context: ${id}`);
  return context;
}
