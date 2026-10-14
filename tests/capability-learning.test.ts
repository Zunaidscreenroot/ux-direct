import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityLearningLoop } from "../src/core/capability-learning";
import { CapabilityRegistry } from "../src/core/capability-registry";
import { buildDirectorPlanningContext } from "../src/core/director-controller";
import { UXToolRegistry, type UXToolDefinition } from "../src/core/tool-registry";
import { FixtureWorkspaceContextResolver, type UXWorkspaceContext } from "../src/core/workspace-context";
import { InMemoryWorldModel } from "../src/core/world-model";

const timestamp = "2026-10-14T00:00:00.000Z";

function makeWorkspace(id = "workspace-a", clientId = "client-a"): UXWorkspaceContext {
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
    metadata: { source: "learning-loop-test" },
  };
}

function event(
  id: string,
  scope: { kind: "project"; namespace: string; clientId: string; projectId: string } | { kind: "global"; namespace: string; licenceApproved: boolean },
  overrides: Partial<Parameters<CapabilityLearningLoop["record"]>[0]> = {},
): Parameters<CapabilityLearningLoop["record"]>[0] {
  return {
    id,
    capabilityId: "website.recon",
    strategyId: "verified-crawl-first",
    scope,
    outcome: "accepted",
    verificationPassed: true,
    qualityScore: 0.9,
    correctionCount: 0,
    evidenceKinds: ["deterministic-check", "postcondition"],
    capturedAt: timestamp,
    estimatedCostInr: 0,
    latencyMs: 250,
    ...overrides,
  };
}

function tool(id: string): UXToolDefinition {
  return {
    id,
    version: "1.0",
    description: id,
    operation: "observe",
    tags: ["inspect"],
    modalities: ["text", "web-evidence"],
    providedBy: "brain",
    risk: "low",
    costClass: "local",
    requiresApproval: false,
    available: () => true,
    validateInput: (input) => ({ valid: Boolean(input && typeof input === "object"), errors: [] }),
    execute: async () => ({ ok: true }),
  };
}

test("capability registry discovers newly registered website and application abilities without workflow branches", async () => {
  const registry = new CapabilityRegistry();
  registry.register({
    id: "website.recon",
    version: "1.0",
    description: "Inventory a website and classify page archetypes",
    tags: ["website", "recon", "inventory"],
    modalities: ["web-evidence", "structured-data"],
    risk: "low",
    costClass: "external-read",
    requiresApproval: false,
    validateInput: (input) => ({ valid: typeof input.url === "string", errors: typeof input.url === "string" ? [] : ["url is required"] }),
    async run(input) { return { pages: 0, source: input.url }; },
  });
  registry.register({
    id: "application.flow-inspect",
    description: "Inspect an application journey",
    tags: ["application", "journey"],
    modalities: ["application-ui", "structured-data"],
    risk: "medium",
    costClass: "free-local",
    requiresApproval: false,
    async run() { return { inspected: true }; },
  });

  assert.deepEqual(
    registry.discover({ intentTags: ["website"], requiredModalities: ["web-evidence"] }).map((item) => item.id),
    ["website.recon"],
  );
  assert.deepEqual(
    registry.discover({ intentTags: ["application"], requiredModalities: ["application-ui"] }).map((item) => item.id),
    ["application.flow-inspect"],
  );
  assert.deepEqual(await registry.execute("website.recon", { url: "https://example.com" }), {
    pages: 0,
    source: "https://example.com",
  });
  await assert.rejects(registry.execute("website.recon", {}), /Invalid input/);
});

test("learning recommendations require repeated verified outcomes and quality thresholds", () => {
  const loop = new CapabilityLearningLoop();
  const scope = { kind: "project" as const, namespace: "project:workspace-a", clientId: "client-a", projectId: "workspace-a" };
  loop.record(event("run-1", scope));
  loop.record(event("run-2", scope));
  assert.equal(loop.recommendCapabilities({ workspace: makeWorkspace(), candidateCapabilityIds: ["website.recon"] }).length, 0);

  loop.record(event("run-3", scope));
  const [recommendation] = loop.recommendCapabilities({
    workspace: makeWorkspace(),
    candidateCapabilityIds: ["website.recon"],
  });
  assert.ok(recommendation);
  assert.equal(recommendation.sampleSize, 3);
  assert.equal(recommendation.verifiedAcceptanceRate, 1);
  assert.equal(recommendation.validationPassRate, 1);
  assert.ok(recommendation.confidence > 0.5);
});

test("learning excludes out-of-scope client data and never upgrades failed runs into recommendations", () => {
  const loop = new CapabilityLearningLoop();
  const anotherClientScope = {
    kind: "project" as const,
    namespace: "project:workspace-b",
    clientId: "client-b",
    projectId: "workspace-b",
  };
  for (let index = 1; index <= 3; index += 1) loop.record(event(`other-${index}`, anotherClientScope));
  assert.equal(loop.recommendCapabilities({
    workspace: makeWorkspace(),
    candidateCapabilityIds: ["website.recon"],
  }).length, 0);

  const ownScope = { kind: "project" as const, namespace: "project:workspace-a", clientId: "client-a", projectId: "workspace-a" };
  loop.record(event("bad-1", ownScope, { outcome: "failed", verificationPassed: false, qualityScore: 0.2, correctionCount: 2, evidenceKinds: ["deterministic-check"] }));
  loop.record(event("bad-2", ownScope, { outcome: "rejected", verificationPassed: false, qualityScore: 0.3, correctionCount: 2, evidenceKinds: ["human-review"] }));
  loop.record(event("bad-3", ownScope, { outcome: "failed", verificationPassed: false, qualityScore: 0.1, correctionCount: 3, evidenceKinds: ["provider-telemetry"] }));
  assert.equal(loop.recommendCapabilities({
    workspace: makeWorkspace(),
    candidateCapabilityIds: ["website.recon"],
  }).length, 0);
});

test("cross-client learning requires explicit approval and a licensed shared namespace", () => {
  const loop = new CapabilityLearningLoop();
  const globalScope = { kind: "global" as const, namespace: "bfci-generic", licenceApproved: true };
  const projectScope = { kind: "project" as const, namespace: "project:workspace-a", clientId: "client-a", projectId: "workspace-a" };
  assert.throws(() => loop.record(event("global-no-approval", projectScope, { scope: globalScope })), /Cross-client learning requires/);

  for (let index = 1; index <= 3; index += 1) {
    loop.record(event(`global-${index}`, projectScope, { scope: globalScope, approvedForCrossClientReuse: true }));
  }
  assert.equal(loop.recommendCapabilities({
    workspace: makeWorkspace(),
    candidateCapabilityIds: ["website.recon"],
  }).length, 1);
});

test("director exposes learned preferences only for currently discovered tools", async () => {
  const loop = new CapabilityLearningLoop();
  const ownScope = { kind: "project" as const, namespace: "project:workspace-a", clientId: "client-a", projectId: "workspace-a" };
  for (let index = 1; index <= 3; index += 1) loop.record(event(`director-${index}`, ownScope));

  const tools = new UXToolRegistry();
  tools.register(tool("website.recon"));
  const context = await buildDirectorPlanningContext({
    requestId: "learned-director",
    objective: "Understand this website",
    workspaceId: "workspace-a",
    intentTags: ["inspect"],
  }, {
    workspaceResolver: new FixtureWorkspaceContextResolver([makeWorkspace()]),
    worldModel: new InMemoryWorldModel(),
    tools,
    learningLoop: loop,
  });

  assert.deepEqual(context.learnedCapabilityPreferences.map((item) => item.capabilityId), ["website.recon"]);
  assert.ok(context.planningDirectives.some((directive) => directive.includes("advisory")));
});
