import assert from "node:assert/strict";
import test from "node:test";
import { buildDirectorPlanningContext, validateDirectorPlan, type DirectorPlan } from "../src/core/director-controller";
import { getHandDefinition, UX_HANDS, UXHandRegistry, type HandTaskRequest } from "../src/core/hand-contracts";
import {
  FixtureWorkspaceContextResolver,
  WORKSPACE_FIXTURES,
  type UXWorkspaceContext,
} from "../src/core/workspace-context";
import { InMemoryWorldModel, type WorldFact } from "../src/core/world-model";
import { UXToolRegistry, type UXToolDefinition } from "../src/core/tool-registry";

const passInput = (input: unknown) => ({
  valid: Boolean(input && typeof input === "object"),
  errors: input && typeof input === "object" ? [] : ["Expected object input"],
});

function tool(overrides: Partial<UXToolDefinition> & Pick<UXToolDefinition, "id" | "operation">): UXToolDefinition {
  return {
    version: "1.0",
    description: overrides.id,
    tags: [],
    modalities: ["text"],
    providedBy: "brain",
    risk: "low",
    costClass: "local",
    requiresApproval: false,
    available: () => true,
    validateInput: passInput,
    execute: async (input) => ({ accepted: true, input }),
    ...overrides,
  };
}

function workspace(id: string, clientId: string, namespace: string): UXWorkspaceContext {
  return {
    id,
    clientId,
    displayName: id,
    knowledgeScope: {
      clientNamespace: `client:${clientId}`,
      projectNamespace: `project:${id}`,
      sharedKnowledgeNamespaces: ["bfci-generic"],
      allowCrossProjectMemory: false,
    },
    metadata: { source: "test-fixture" },
  };
}

function fact(overrides: Partial<WorldFact> & Pick<WorldFact, "id" | "scope">): WorldFact {
  return {
    kind: "requirement",
    subject: "loan review",
    predicate: "must-preserve",
    object: "consent",
    statement: "Preserve the approved consent requirement.",
    status: "approved",
    confidence: 1,
    tags: ["loan", "consent"],
    evidence: [{
      sourceId: "source-1",
      sourceType: "human-decision",
      capturedAt: "2026-10-14T00:00:00.000Z",
    }],
    version: 1,
    observedAt: "2026-10-14T00:00:00.000Z",
    ...overrides,
  };
}

test("Cockpit remains the primary hand while specialist hands are optional", () => {
  assert.equal(getHandDefinition("cockpit").role, "primary");
  assert.equal(getHandDefinition("cockpit").invocation, "default");
  assert.ok(UX_HANDS.some((hand) => hand.id === "wireframe-foundry" && hand.role === "specialist"));
  assert.ok(UX_HANDS.some((hand) => hand.id === "ux-auditor" && hand.role === "specialist"));
  assert.ok(UX_HANDS.some((hand) => hand.id === "benchmark-lab" && hand.role === "specialist"));
  assert.ok(UX_HANDS.some((hand) => hand.id === "journey-architect" && hand.role === "specialist"));
});

test("workspace context carries scope but does not prescribe a workflow", () => {
  for (const item of WORKSPACE_FIXTURES) {
    assert.ok(item.knowledgeScope.clientNamespace);
    assert.ok(item.knowledgeScope.projectNamespace);
    assert.equal(item.knowledgeScope.allowCrossProjectMemory, false);
    assert.equal("initialFoundation" in item, false);
    assert.equal("defaultHands" in item, false);
  }
});

test("a new workspace can be resolved without adding a project enum or planner branch", async () => {
  const pilot = workspace("new-bank-pilot", "new-bank", "project:new-bank-pilot");
  const resolver = new FixtureWorkspaceContextResolver([pilot]);
  const world = new InMemoryWorldModel();
  const tools = new UXToolRegistry();
  tools.register(tool({ id: "world.inspect", operation: "observe", tags: ["inspect"] }));

  const context = await buildDirectorPlanningContext({
    requestId: "req-new-project",
    objective: "Discover what is needed to begin this product",
    workspaceId: "new-bank-pilot",
    intentTags: ["inspect"],
  }, { workspaceResolver: resolver, worldModel: world, tools });

  assert.equal(context.workspace?.id, "new-bank-pilot");
  assert.deepEqual(context.availableTools.map((entry) => entry.id), ["world.inspect"]);
});

test("world model exposes only in-scope facts and licensed generic facts", () => {
  const world = new InMemoryWorldModel();
  world.upsertFact(fact({
    id: "dmi-project",
    scope: { kind: "project", namespace: "project:dmi-hfc", clientId: "dmi", projectId: "dmi-hfc" },
  }));
  world.upsertFact(fact({
    id: "dmi-client",
    scope: { kind: "client", namespace: "client:dmi", clientId: "dmi" },
  }));
  world.upsertFact(fact({
    id: "generic-approved",
    scope: { kind: "global", namespace: "bfci-generic", licenceApproved: true },
  }));
  world.upsertFact(fact({
    id: "generic-unlicensed",
    scope: { kind: "global", namespace: "bfci-generic", licenceApproved: false },
  }));
  world.upsertFact(fact({
    id: "ujjivan-project",
    scope: { kind: "project", namespace: "project:ujjivan-sfb", clientId: "ujjivan", projectId: "ujjivan-sfb" },
  }));

  const result = world.query({
    clientId: "dmi",
    projectId: "dmi-hfc",
    clientNamespace: "client:dmi",
    projectNamespace: "project:dmi-hfc",
    sharedKnowledgeNamespaces: ["bfci-generic"],
  });

  const ids = result.facts.map((item) => item.id);
  assert.ok(ids.includes("dmi-project"));
  assert.ok(ids.includes("dmi-client"));
  assert.ok(ids.includes("generic-approved"));
  assert.ok(!ids.includes("generic-unlicensed"));
  assert.ok(!ids.includes("ujjivan-project"));
  assert.equal(result.omitted.unapprovedGlobal, 1);
});

test("world model supports versioned decisions and rejects non-increasing versions", () => {
  const world = new InMemoryWorldModel();
  const original = fact({
    id: "decision-1",
    scope: { kind: "project", namespace: "project:dmi-hfc", clientId: "dmi", projectId: "dmi-hfc" },
  });
  world.upsertFact(original);
  assert.throws(() => world.upsertFact({ ...original, statement: "Conflicting rewrite", version: 1 }), /version must increase/);
  world.upsertFact({ ...original, statement: "Approved updated requirement", version: 2 });
  assert.equal(world.getFact("decision-1")?.version, 2);
});

test("tool discovery composes runtime tools by intent, modality and execution policy", () => {
  const registry = new UXToolRegistry();
  registry.register(tool({
    id: "figma.capture",
    operation: "observe",
    tags: ["visual", "screenshot"],
    modalities: ["image", "figma-nodes"],
    providedBy: "cockpit",
  }));
  registry.register(tool({
    id: "figma.create-frame",
    operation: "write",
    tags: ["render", "create"],
    providedBy: "cockpit",
    risk: "medium",
    requiresApproval: true,
  }));
  registry.register(tool({
    id: "research.search",
    operation: "research",
    tags: ["benchmark", "evidence"],
    providedBy: "benchmark-lab",
    costClass: "external-service",
  }));

  const visualTools = registry.discover({
    intentTags: ["visual"],
    requiredModalities: ["image"],
  });
  assert.deepEqual(visualTools.map((item) => item.id), ["figma.capture"]);

  const defaultTools = registry.discover({ intentTags: ["create"] });
  // A write tool can be discovered for planning without authorising execution.
  assert.ok(defaultTools.some((item) => item.id === "figma.create-frame"));
  assert.ok(!defaultTools.some((item) => item.id === "research.search"));
  assert.ok(!registry.discover({ intentTags: ["create"], includeWriteTools: false })
    .some((item) => item.id === "figma.create-frame"));

  const writeTools = registry.discover({
    intentTags: ["create"],
    includeWriteTools: true,
    allowedOperations: ["write"],
  });
  assert.deepEqual(writeTools.map((item) => item.id), ["figma.create-frame"]);
});

test("tool invocation enforces approval, allowlists and paid budget reservations", async () => {
  const registry = new UXToolRegistry();
  registry.register(tool({
    id: "figma.write",
    operation: "write",
    requiresApproval: true,
    execute: async () => ({ changed: true }),
  }));
  registry.register(tool({
    id: "model.premium-review",
    operation: "reason",
    costClass: "paid-model",
    execute: async () => ({ reviewed: true }),
  }));

  const base = {
    requestId: "req-safe",
    humanApproved: false,
    paidBudgetReserved: false,
  };
  await assert.rejects(registry.invoke("figma.write", {}, base), /Human approval/);
  await assert.rejects(registry.invoke("figma.write", {}, { ...base, humanApproved: true, allowedToolIds: [] }), /not allowed/);
  await assert.rejects(registry.invoke("model.premium-review", {}, base), /budget must be reserved/i);
  assert.deepEqual(
    await registry.invoke("model.premium-review", {}, { ...base, paidBudgetReserved: true }),
    { reviewed: true },
  );
});

test("director planning context does not force a client-defined sequence", async () => {
  const customWorkspace = workspace("bespoke-client", "bespoke", "project:bespoke-client");
  const resolver = new FixtureWorkspaceContextResolver([customWorkspace]);
  const world = new InMemoryWorldModel();
  const tools = new UXToolRegistry();
  tools.register(tool({ id: "research.discover", operation: "research", tags: ["discover"] }));
  tools.register(tool({ id: "figma.inspect", operation: "observe", tags: ["inspect"] }));

  const context = await buildDirectorPlanningContext({
    requestId: "req-dynamic",
    objective: "Understand the best next step for this product",
    workspaceId: customWorkspace.id,
    intentTags: ["discover", "inspect"],
    toolPolicy: { allowedOperations: ["research", "observe"] },
  }, { workspaceResolver: resolver, worldModel: world, tools });

  assert.deepEqual(new Set(context.availableTools.map((item) => item.id)), new Set(["research.discover", "figma.inspect"]));
  assert.ok(context.planningDirectives.some((line) => line.includes("mandatory client workflow")));
});

test("plan validator permits adaptive plans but blocks unknown tools, cycles and missing verification evidence", async () => {
  const tools = new UXToolRegistry();
  tools.register(tool({ id: "context.inspect", operation: "observe" }));
  tools.register(tool({ id: "figma.create", operation: "write", requiresApproval: true, risk: "high" }));
  const context = await buildDirectorPlanningContext({
    requestId: "req-plan",
    objective: "Create and verify a screen",
    toolPolicy: { includeWriteTools: true },
  }, { worldModel: new InMemoryWorldModel(), tools });

  const validPlan: DirectorPlan = {
    version: "1.0",
    summary: "Inspect, then build the screen",
    rationale: "Start with available evidence and create only when needed.",
    assumptions: [],
    unresolvedQuestions: [],
    steps: [
      { id: "inspect", objective: "Inspect the current state", toolId: "context.inspect", input: {}, dependsOn: [], expectedEvidence: ["node summary"] },
      { id: "build", objective: "Create an editable screen", toolId: "figma.create", input: {}, dependsOn: ["inspect"], expectedEvidence: ["created node IDs", "post-write screenshot"] },
    ],
    acceptanceCriteria: ["output is editable"],
  };
  const result = validateDirectorPlan(validPlan, context);
  assert.equal(result.valid, true);
  assert.deepEqual(result.stepsRequiringApproval, ["build"]);

  const unknownToolPlan = {
    ...validPlan,
    steps: [{ ...validPlan.steps[0], toolId: "not-discovered" }],
  };
  assert.equal(validateDirectorPlan(unknownToolPlan, context).valid, false);

  const cyclicPlan = {
    ...validPlan,
    steps: [
      { ...validPlan.steps[0], dependsOn: ["build"] },
      { ...validPlan.steps[1], dependsOn: ["inspect"] },
    ],
  };
  assert.ok(validateDirectorPlan(cyclicPlan, context).errors.some((error) => error.includes("cycle")));

  const unverifiedPlan = {
    ...validPlan,
    steps: [{ ...validPlan.steps[0], expectedEvidence: [] }],
  };
  assert.ok(validateDirectorPlan(unverifiedPlan, context).errors.some((error) => error.includes("evidence")));
});

test("world-model relations are returned only when both endpoints are visible", () => {
  const world = new InMemoryWorldModel();
  world.upsertFact(fact({
    id: "visible-dmi",
    scope: { kind: "project", namespace: "project:dmi-hfc", clientId: "dmi", projectId: "dmi-hfc" },
  }));
  world.upsertFact(fact({
    id: "hidden-ujjivan",
    scope: { kind: "project", namespace: "project:ujjivan-sfb", clientId: "ujjivan", projectId: "ujjivan-sfb" },
  }));
  world.upsertRelation({
    id: "cross-client-edge",
    fromFactId: "visible-dmi",
    relation: "depends-on",
    toFactId: "hidden-ujjivan",
    evidenceIds: [],
  });

  const query = {
    clientId: "dmi",
    projectId: "dmi-hfc",
    clientNamespace: "client:dmi",
    projectNamespace: "project:dmi-hfc",
    sharedKnowledgeNamespaces: ["bfci-generic"],
  };
  assert.deepEqual(world.getRelationsForFact("visible-dmi", query), []);
  assert.deepEqual(world.listRelations(query), []);
  assert.deepEqual(world.getRelationsForFact("hidden-ujjivan", query), []);
});

test("hand contract accepts a new hand and exploratory task without a fixed capability or workspace profile", () => {
  const request: HandTaskRequest = {
    contractVersion: "1.0",
    requestId: "req-exploratory",
    idempotencyKey: "idem-exploratory",
    handId: "future-specialist-hand",
    objective: "Discover how to improve this unfamiliar product",
    userPrompt: "Inspect the available evidence and decide the next best action.",
  };
  assert.equal(request.workspaceId, undefined);
  assert.equal(request.preferredToolIds, undefined);
});

test("a specialist hand can register at runtime without changing the Brain's source enum", () => {
  const registry = new UXHandRegistry();
  registry.register({
    id: "future-specialist-hand",
    name: "Future Specialist",
    role: "specialist",
    description: "A plugin registered after the core Brain was built.",
    pluginPackage: "plugins/future-specialist",
    invocation: "on-demand",
    outputs: ["text"],
  });
  assert.equal(registry.get("future-specialist-hand")?.name, "Future Specialist");
  assert.ok(registry.list().some((hand) => hand.id === "future-specialist-hand"));
});
